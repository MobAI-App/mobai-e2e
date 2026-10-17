/**
 * Saving a run into the MobAI app's local history: only when the app names a
 * slot, never by default.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mobaiReporter } from '../src/reporter.ts';

let root: string;

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function finishedRun(): FinishedRun {
  root = mkdtempSync(path.join(tmpdir(), 'mobai-e2e-local-'));
  const results = path.join(root, '.e2e', 'results', 'ios', 't', 'attempt-0');
  mkdirSync(path.join(results, 'screenshots'), { recursive: true });
  mkdirSync(path.join(results, 'video'), { recursive: true });
  writeFileSync(path.join(results, 'screenshots', '001-after.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(results, 'video', 'video.mjpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const report = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-v1.valid.json'), 'utf8')) as Report;
  const attempt = report.run.results[0]!.attempts[0]!;
  (attempt as unknown as { artifacts: unknown[] }).artifacts = [
    { id: 'shot-1', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/001-after.png', size: 4, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'step', stepId: attempt.steps[1]!.id } },
    { id: 'gone', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/never-written.png', size: 4, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'step', stepId: attempt.steps[0]!.id } },
    { id: 'vid', kind: 'video', mediaType: 'video/x-motion-jpeg', path: 'ios/t/attempt-0/video/video.mjpeg', size: 4, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'attempt' } },
  ];
  return {
    report,
    status: report.run.status,
    exitCode: report.run.exitCode,
    projectRoot: root,
    reportPath: path.join(root, '.e2e', 'report.json'),
    artifactsRoot: path.join(root, '.e2e', 'results'),
    aiTracePath: undefined,
    traces: new Map(),
  };
}

const signal = new AbortController().signal;

describe('local run', () => {
  it('writes nothing unless the app names a slot', async () => {
    const run = finishedRun();
    const slot = path.join(root, 'slot');
    mkdirSync(slot);
    vi.stubEnv('MOBAI_E2E_LOCAL_RUN_DIR', undefined);
    vi.stubEnv('MOBAI_E2E_LOCAL_RUN_ID', undefined);
    const rows = await mobaiReporter({ apiKey: '' }).onRunFinished!(run, signal);
    expect(rows!.map((r) => r.text).join('\n')).not.toMatch(/local/);
    expect(readdirSync(slot)).toEqual([]);

    // A directory without a run id is not a request either.
    vi.stubEnv('MOBAI_E2E_LOCAL_RUN_DIR', slot);
    await mobaiReporter({ apiKey: '' }).onRunFinished!(run, signal);
    expect(readdirSync(slot)).toEqual([]);
  });

  it('saves the run, its files and its recording into the slot', async () => {
    const run = finishedRun();
    const slot = path.join(root, 'run_abc.tmp');
    mkdirSync(slot);
    vi.stubEnv('MOBAI_E2E_LOCAL_RUN_DIR', slot);
    vi.stubEnv('MOBAI_E2E_LOCAL_RUN_ID', 'run_abc');
    const rows = await mobaiReporter({ apiKey: '' }).onRunFinished!(run, signal);
    expect(rows!.some((r) => r.text === 'saved to the local dashboard')).toBe(true);

    const bundle = JSON.parse(readFileSync(path.join(slot, 'run.json'), 'utf8')) as {
      runId: string;
      cases: { attempt: number; steps: { screenshot: string }[]; videos?: { path: string; format: string; fps?: number; bytes: number }[] }[];
    };
    expect(bundle.runId).toBe('run_abc');
    expect(existsSync(path.join(slot, 'run.json.part'))).toBe(false);
    expect(existsSync(path.join(slot, 'artifacts', 'ios', 't', 'attempt-0', 'screenshots', '001-after.png'))).toBe(true);
    const first = bundle.cases.find((c) => c.attempt === 1)!;
    expect(first.steps.map((s) => s.screenshot)).toContain('ios/t/attempt-0/screenshots/001-after.png');
    // The screenshot the run never wrote is not referenced.
    expect(first.steps.map((s) => s.screenshot)).not.toContain('ios/t/attempt-0/screenshots/never-written.png');
    expect(first.videos).toEqual([{ path: 'ios/t/attempt-0/video/video.mjpeg', format: 'mjpeg', fps: 25, bytes: 4 }]);
  });
});
