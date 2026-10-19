/**
 * Recordings and device logs from device farms. A farm (BrowserStack, Sauce
 * Labs, AWS Device Farm) records the whole session and keeps its device log,
 * and hands both over only once the session has ended, after `finish`. The
 * reporter, the only part that sees which tests failed, asks the host to
 * fetch them for the failed tests' farm devices and adds them to those
 * attempts: the video starts at the attempt, the log is the device log.
 */

import { copyFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { HostClient, type FarmSessionFiles } from './client.ts';
import { message, sanitizeFilename } from './errors.ts';
import type { EngineHold } from './hold.ts';
import { resolveBaseUrl, resolveLocalApiToken } from './host.ts';

const FARM_DEVICE = /^(browserstack|saucelabs|awsdevicefarm):/;

type MutableAttempt = {
  id: string;
  status: string;
  startedAt: string;
  environment?: Record<string, string>;
  artifacts: Record<string, unknown>[];
};

/** A run with the farm files added, and where each added video starts. */
export interface FarmFilesResult {
  readonly run: FinishedRun;
  /** Seconds into each added video (by report path) where its attempt begins. */
  readonly videoStarts: ReadonlyMap<string, number>;
  readonly notes: readonly { label: string; text: string }[];
}

export interface FarmFilesOptions {
  readonly settings: EngineHold | undefined;
  readonly baseUrl?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

/** Adds the farm recordings and device logs to the run's failed attempts on farm devices. */
export async function withFarmFiles(run: FinishedRun, options: FarmFilesOptions): Promise<FarmFilesResult> {
  const unchanged: FarmFilesResult = { run, videoStarts: new Map(), notes: [] };
  const failed = failedFarmAttempts(run.report);
  if (failed.length === 0) return unchanged;
  const host = { baseUrl: options.settings?.baseUrl ?? options.baseUrl, localApiToken: options.settings?.localApiToken };
  const client = new HostClient(resolveBaseUrl(host, options.env), resolveLocalApiToken(host, options.env));
  const deviceIds = [...new Set(failed.map((a) => a.environment?.['deviceId'] ?? ''))];
  let files: FarmSessionFiles[];
  try {
    ({ files } = await client.cloudFiles(run.report.run.id, deviceIds, options.signal));
  } catch (cause) {
    if (options.signal.aborted) throw cause;
    return { ...unchanged, notes: [{ label: 'MobAI farm', text: `no farm recordings: ${message(cause)}` }] };
  }
  const byDevice = new Map(files.map((f) => [f.deviceId, f]));
  const report = structuredClone(run.report) as Report;
  const videoStarts = new Map<string, number>();
  const notes: { label: string; text: string }[] = [];
  for (const f of files) {
    if (f.error !== undefined) notes.push({ label: 'MobAI farm', text: `${f.deviceId}: ${f.error}` });
  }
  for (const attempt of failedFarmAttempts(report)) {
    const f = byDevice.get(attempt.environment?.['deviceId'] ?? '');
    if (f === undefined) continue;
    const dir = `farm/${sanitizeFilename(attempt.id)}`;
    if (f.video !== undefined) {
      const rel = `${dir}/video.mp4`;
      if (await place(f.video, run.artifactsRoot, rel, attempt, 'video', 'video/mp4')) {
        const start = videoOffset(attempt.startedAt, f.videoStartedAt);
        if (start > 0) videoStarts.set(rel, start);
      }
    }
    if (f.deviceLog !== undefined) {
      await place(f.deviceLog, run.artifactsRoot, `${dir}/device.txt`, attempt, 'log', 'text/plain');
    }
  }
  return { run: { ...run, report }, videoStarts, notes };
}

/** The attempts that did not pass on a farm device, in the report's own objects. */
function failedFarmAttempts(report: Report): MutableAttempt[] {
  const out: MutableAttempt[] = [];
  for (const result of report.run.results) {
    if (result.status === 'passed' || result.status === 'skipped') continue;
    for (const attempt of result.attempts as unknown as MutableAttempt[]) {
      if (attempt.status === 'passed') continue;
      if (FARM_DEVICE.test(attempt.environment?.['deviceId'] ?? '')) out.push(attempt);
    }
  }
  return out;
}

/** How much of a session's device log an attempt keeps: its end, where the run stopped. */
export const FARM_LOG_MAX = 2 * 1024 * 1024;

/** The id prefix of a farm device log artifact; the reporter files it as the device log. */
export const FARM_LOG_ID = 'farm-log-';

/**
 * Copies a host file into the run's artifacts and lists it on the attempt;
 * false when it could not. A device log keeps its last FARM_LOG_MAX bytes.
 */
async function place(from: string, root: string, rel: string, attempt: MutableAttempt, kind: 'video' | 'log', mediaType: string): Promise<boolean> {
  const to = path.join(root, ...rel.split('/'));
  try {
    await mkdir(path.dirname(to), { recursive: true });
    if (kind === 'log') await copyTail(from, to, FARM_LOG_MAX);
    else await copyFile(from, to);
    const size = (await stat(to)).size;
    const id = kind === 'log' ? `${FARM_LOG_ID}${attempt.id}` : `farm-video-${attempt.id}`;
    attempt.artifacts.push({ id, kind, mediaType, path: rel, size, sha256: '', redaction: 'incomplete', producer: { kind: 'attempt' } });
    return true;
  } catch {
    return false;
  }
}

/** Writes the last max bytes of from to to, starting at a line break. */
async function copyTail(from: string, to: string, max: number): Promise<void> {
  const size = (await stat(from)).size;
  if (size <= max) return copyFile(from, to);
  const handle = await open(from, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buf, 0, max, size - max);
    const body = buf.subarray(0, bytesRead);
    const nl = body.indexOf(10);
    await writeFile(to, nl >= 0 ? body.subarray(nl + 1) : body);
  } finally {
    await handle.close();
  }
}

/** Seconds from the recording's start to the attempt's; 0 when either is unknown. */
export function videoOffset(attemptStartedAt: string, videoStartedAt: string | undefined): number {
  if (videoStartedAt === undefined) return 0;
  const ms = Date.parse(attemptStartedAt) - Date.parse(videoStartedAt);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 100) / 10 : 0;
}
