/**
 * The MobAI reporter: publishes a finished run to the MobAI testing
 * dashboard (the same ingest the desktop app uses), with its screenshots and
 * videos. Nothing here can change the run's
 * outcome: a missing key or a failed upload is one summary row.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FinishedRun, Report, Reporter, ReporterSummary } from 'e2e';
import { message, sanitizeFilename } from './errors.ts';
import { describeHold, engineHold, holdFailed, parseHold } from './hold.ts';
import { localRunTarget, writeLocalRun } from './localrun.ts';

export interface MobaiReporterOptions {
  /** The MobAI cloud project id; `MOBAI_PROJECT_ID`, else the `project` of the nearest `mobai.json`. */
  readonly projectId?: string | undefined;
  /** A MobAI API key (`mobai_...`); `MOBAI_API_KEY` by default. */
  readonly apiKey?: string | undefined;
  /** The MobAI host the engine drove; the engine's `baseUrl`, `MOBAI_HOST_URL`, else loopback. */
  readonly hostUrl?: string | undefined;
}

export const DEFAULT_API_URL = 'https://api.mobai.run/api/v1';

type ReportResult = Report['run']['results'][number];
type ReportAttempt = ReportResult['attempts'][number];
type ReportStep = ReportAttempt['steps'][number];
type ReportArtifact = ReportAttempt['artifacts'][number];
type ReportSerialGroup = Report['run']['serialGroups'][number];

/** The run bundle the MobAI dashboard ingests (schema 2). */
export interface Bundle {
  schemaVersion: 2;
  runId: string;
  groupId: string;
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  error: string;
  passed: boolean;
  project: { name: string; root: string };
  runner: { name: string; version: string; os: string };
  startedAt: string;
  finishedAt: string;
  device: { idHash: string; name: string; platform: string; os: string; model: string; simulator: boolean; provider: string };
  git?: { commit: string; branch: string; message: string; pr: string; repo: string; defaultBranch: string };
  ci?: { provider: string; runUrl: string; job: string; runId: string; attempt: number; group: string };
  app: Record<string, unknown>;
  cases: BundleCase[];
  totals: { cases: number; passed: number; failed: number; skipped: number; errored: number; retried: number; seconds: number };
}

export interface BundleCase {
  id: string;
  name: string;
  kind: 'e2e';
  sourcePath: string;
  definitionHash: string;
  tags: string[];
  attempt: number;
  status: 'passed' | 'failed' | 'skipped' | 'cancelled' | 'error';
  passed: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error: string;
  failedStepIndex: number | null;
  evidence: { screenshot: string; uiTree: string } | null;
  params: null;
  steps: BundleStep[];
  extracted: null;
}

export interface BundleStep {
  index: number;
  lineNumber: number;
  lineText: string;
  stepId: string;
  kind: string;
  passed: boolean;
  durationMs: number;
  error: string;
  typedSecret: boolean;
  screenshot: string;
  uiTree: string;
  logs: string;
  subs: null;
}

/** One file of the upload manifest. */
export interface BundleFile {
  path: string;
  type: 'screenshot' | 'failure_screenshot' | 'ui_tree' | 'video' | 'step_log' | 'device_log';
  bytes: number;
  sha256: string;
  mime: string;
  caseId: string;
  attempt: number;
  stepIndex: number | null;
}

/** A manifest entry before it is measured: a report artifact, or (with `text`) a file the reporter writes itself. */
export type BuildFile = Omit<BundleFile, 'bytes' | 'sha256'> & { readonly text?: string };

/** What `toBundle` produces: the bundle and the artifacts it names, by their report path. */
export interface BundleBuild {
  readonly bundle: Bundle;
  /** Artifact report paths (relative to `artifactsRoot`) with where they go in the manifest. */
  readonly files: readonly BuildFile[];
}

const EVIDENCE_PRESENT = 'present';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function addMs(startedAt: string, durationMs: number): string {
  const started = new Date(startedAt);
  return Number.isNaN(started.getTime()) ? startedAt : new Date(started.getTime() + durationMs).toISOString();
}

/** A clean, relative, forward-slash path the ingest accepts as a case id. */
function caseId(file: string, titlePath: readonly string[]): string {
  const title = titlePath.join(' > ').replaceAll('\\', '/').replaceAll('..', '.').replaceAll(/\s+/g, ' ').trim();
  const base = file.replaceAll('\\', '/').replace(/^\/+/, '');
  return `${base}::${title}`.slice(0, 500);
}

function runStatus(status: Report['run']['status']): Bundle['status'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'blocked':
      return 'failed';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'cancelled';
  }
}

function caseStatus(status: ReportAttempt['status']): BundleCase['status'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timed-out':
      return 'failed';
    case 'interrupted':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
  }
}

/** The report's artifacts by producing step id. */
function artifactsByStep(artifacts: readonly ReportArtifact[]): Map<string, ReportArtifact[]> {
  const map = new Map<string, ReportArtifact[]>();
  for (const artifact of artifacts) {
    if (artifact.producer.kind !== 'step') continue;
    const list = map.get(artifact.producer.stepId) ?? [];
    list.push(artifact);
    map.set(artifact.producer.stepId, list);
  }
  return map;
}

/**
 * The media type the ingest expects. e2e names an `.mjpeg` file
 * `application/octet-stream`; the ingest pins each video extension to one type.
 */
function uploadMime(artifact: ReportArtifact): string {
  if (artifact.kind === 'video' && artifact.path !== undefined && path.posix.extname(artifact.path).toLowerCase() === '.mjpeg') return 'video/x-motion-jpeg';
  return artifact.mediaType;
}

/** Whether the dashboard's allowlist takes this artifact: images, mp4 videos, and the MJPEG a physical iPhone records. */
function uploadable(artifact: ReportArtifact): BundleFile['type'] | undefined {
  if (artifact.path === undefined) return undefined;
  const ext = path.posix.extname(artifact.path).toLowerCase();
  if (artifact.kind === 'screenshot' && ['.png', '.jpg', '.jpeg'].includes(ext)) return 'screenshot';
  if (artifact.kind === 'video' && (ext === '.mp4' || ext === '.mjpeg')) return 'video';
  if (artifact.kind === 'log' && ext === '.txt') return 'step_log';
  return undefined;
}

interface CaseSource {
  readonly result: ReportResult;
  readonly attemptIndex: number;
  readonly status: ReportAttempt['status'];
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: readonly ReportStep[];
  readonly artifacts: readonly ReportArtifact[];
  readonly error: string;
  readonly failureScreenshot: string | undefined;
  /** The attempt's screen at failure (a `log` artifact id): the failed step's UI tree. */
  readonly failureScreen: string | undefined;
  /** What the engine logged for the attempt (the device logs, with `deviceLogs` on), and where it goes. */
  readonly appLog: readonly AppLogLine[] | undefined;
  readonly logPath: string;
}

type AppLogLine = NonNullable<ReportAttempt['appLog']>[number];

/** The app log as the dashboard's device log: one line each, with its time, level, and step. */
export function deviceLogText(lines: readonly AppLogLine[]): string {
  return lines.map((line) => `${line.at} ${line.level.toUpperCase()}${line.step === undefined ? '' : ` [step ${String(line.step)}]`} ${line.text}\n`).join('');
}

function buildCase(source: CaseSource, files: BuildFile[]): BundleCase {
  const { result } = source;
  const id = caseId(result.file, result.titlePath);
  const attempt = source.attemptIndex + 1;
  const byStep = artifactsByStep(source.artifacts);
  const steps: BundleStep[] = source.steps.map((step) => {
    const own = byStep.get(step.id) ?? [];
    let screenshot = '';
    for (const artifact of own) {
      const type = uploadable(artifact);
      if (type === undefined || artifact.path === undefined) continue;
      const failed = step.status !== 'passed';
      files.push({
        path: artifact.path,
        type: type === 'screenshot' && failed ? 'failure_screenshot' : type,
        mime: uploadMime(artifact),
        caseId: id,
        attempt,
        stepIndex: step.index,
      });
      if (type === 'screenshot' && screenshot === '') screenshot = artifact.path;
    }
    return {
      index: step.index,
      lineNumber: step.source.line,
      lineText: `${step.api} ${step.label}`.trim(),
      stepId: step.id,
      kind: step.kind,
      passed: step.status === 'passed',
      durationMs: step.durationMs,
      error: step.error?.message ?? (step.status === 'passed' ? '' : step.explanation ?? step.status),
      typedSecret: false,
      screenshot,
      uiTree: '',
      logs: '',
      subs: null,
    };
  });
  // Attempt-level artifacts ride the case, except the failure screenshot and
  // the screen at failure: the dashboard shows those on the failed step, as
  // its screenshot and its UI tree.
  const failedStep = steps.find((step) => !step.passed);
  let failureShot = source.failureScreenshot;
  let hasTree = false;
  for (const artifact of source.artifacts) {
    if (artifact.producer.kind !== 'attempt') continue;
    const type = uploadable(artifact);
    if (type === undefined || artifact.path === undefined) continue;
    const isFailureShot = type === 'screenshot' && artifact.id === failureShot;
    const isScreen = type === 'step_log' && artifact.id === source.failureScreen;
    const onStep = (isFailureShot || isScreen) && failedStep !== undefined;
    files.push({
      path: artifact.path,
      type: isFailureShot ? 'failure_screenshot' : isScreen ? 'ui_tree' : type,
      mime: uploadMime(artifact),
      caseId: id,
      attempt,
      stepIndex: onStep ? failedStep.index : null,
    });
    if (isFailureShot) {
      failureShot = artifact.path;
      if (failedStep !== undefined) failedStep.screenshot = artifact.path;
    }
    if (isScreen) {
      hasTree = true;
      if (failedStep !== undefined) failedStep.uiTree = artifact.path;
    }
  }
  const status = caseStatus(source.status);
  // Device logs ride a case that did not pass, as mobai-ci's do.
  if (status !== 'passed' && status !== 'skipped' && source.appLog !== undefined && source.appLog.length > 0) {
    files.push({ path: source.logPath, type: 'device_log', mime: 'text/plain', caseId: id, attempt, stepIndex: null, text: deviceLogText(source.appLog) });
  }
  const hasShot = failureShot !== undefined || steps.some((step) => !step.passed && step.screenshot !== '');
  return {
    id,
    name: result.titlePath.join(' > '),
    kind: 'e2e',
    sourcePath: result.file,
    definitionHash: sha256(`${result.file}\n${result.titlePath.join('\n')}`),
    tags: [...result.tags],
    attempt,
    status,
    passed: status === 'passed',
    startedAt: source.startedAt,
    finishedAt: addMs(source.startedAt, source.durationMs),
    durationMs: source.durationMs,
    error: source.error,
    failedStepIndex: failedStep === undefined ? null : failedStep.index,
    evidence: status === 'passed' || status === 'skipped' ? null : { screenshot: hasShot ? EVIDENCE_PRESENT : 'not captured', uiTree: hasTree ? EVIDENCE_PRESENT : 'not captured' },
    params: null,
    steps,
    extracted: null,
  };
}

/** Every case the report yields: one per attempt of every selected result, serial members included. */
function collectCases(report: Report, files: BuildFile[]): BundleCase[] {
  const cases: BundleCase[] = [];
  const groups = new Map<string, ReportSerialGroup>(report.run.serialGroups.map((group) => [group.id, group]));
  for (const result of report.run.results) {
    if (!result.selected) continue;
    if (result.serialGroupId !== undefined) {
      const group = groups.get(result.serialGroupId);
      if (group === undefined) continue;
      group.attempts.forEach((attempt) => {
        const member = attempt.members.find((m) => m.testId === result.testId);
        if (member === undefined) return;
        cases.push(
          buildCase(
            {
              result,
              attemptIndex: attempt.index,
              status: member.status,
              startedAt: member.startedAt,
              durationMs: member.durationMs,
              steps: member.steps,
              artifacts: attempt.artifacts,
              error: member.error?.message ?? attempt.error?.message ?? '',
              failureScreenshot: member.failure?.screenshot,
              failureScreen: member.failure?.screen,
              appLog: member.appLog,
              logPath: deviceLogPath(`${attempt.id}-${member.id}`),
            },
            files,
          ),
        );
      });
      continue;
    }
    if (result.attempts.length === 0) {
      cases.push(
        buildCase(
          {
            result,
            attemptIndex: 0,
            status: 'skipped',
            startedAt: report.run.startedAt,
            durationMs: 0,
            steps: [],
            artifacts: [],
            error: result.skip?.reason ?? '',
            failureScreenshot: undefined,
            failureScreen: undefined,
            appLog: undefined,
            logPath: '',
          },
          files,
        ),
      );
      continue;
    }
    for (const attempt of result.attempts) {
      cases.push(
        buildCase(
          {
            result,
            attemptIndex: attempt.index,
            status: attempt.status,
            startedAt: attempt.startedAt,
            durationMs: attempt.durationMs,
            steps: attempt.steps,
            artifacts: attempt.artifacts,
            error: attempt.error?.message ?? attempt.skip?.reason ?? '',
            failureScreenshot: attempt.failure?.screenshot,
            failureScreen: attempt.failure?.screen,
            appLog: attempt.appLog,
            logPath: deviceLogPath(attempt.id),
          },
          files,
        ),
      );
    }
  }
  return cases;
}

/** Where an attempt's device log goes, beside the report's own artifacts. */
function deviceLogPath(attemptId: string): string {
  return `device-logs/${sanitizeFilename(attemptId)}.txt`;
}

/** The device the run drove, from the first attempt's environment facts. */
function deviceOf(report: Report): Bundle['device'] {
  let facts: Readonly<Record<string, string>> | undefined;
  for (const result of report.run.results) {
    for (const attempt of result.attempts) {
      if (attempt.environment !== undefined) {
        facts = attempt.environment;
        break;
      }
    }
    if (facts !== undefined) break;
  }
  if (facts === undefined) {
    for (const group of report.run.serialGroups) {
      for (const attempt of group.attempts) {
        if (attempt.environment !== undefined) {
          facts = attempt.environment;
          break;
        }
      }
      if (facts !== undefined) break;
    }
  }
  const platform = facts?.['platform'] ?? report.run.targets[0]?.platform ?? 'unknown';
  const name = facts?.['device'] ?? `${platform} device`;
  const id = facts?.['deviceId'] ?? name;
  return {
    idHash: sha256(id),
    name,
    platform,
    os: facts?.['os'] ?? '',
    model: facts?.['model'] ?? name,
    simulator: facts?.['virtual'] === 'true',
    provider: 'local',
  };
}

/** The GitHub Actions job, when the run is one. */
function ciOf(env: Readonly<Record<string, string | undefined>>): Bundle['ci'] | undefined {
  if (env['GITHUB_ACTIONS'] === undefined) return undefined;
  const server = (env['GITHUB_SERVER_URL'] ?? 'https://github.com').replace(/\/+$/, '');
  const repository = env['GITHUB_REPOSITORY'] ?? '';
  const runId = env['GITHUB_RUN_ID'] ?? '';
  return {
    provider: 'github',
    runUrl: repository === '' || runId === '' ? '' : `${server}/${repository}/actions/runs/${runId}`,
    job: env['GITHUB_JOB'] ?? '',
    runId,
    attempt: Number(env['GITHUB_RUN_ATTEMPT'] ?? '1') || 1,
    group: '',
  };
}

function gitOf(report: Report, env: Readonly<Record<string, string | undefined>>): Bundle['git'] | undefined {
  const vcs = report.run.vcs;
  const commit = vcs?.commit ?? env['GITHUB_SHA'] ?? '';
  if (commit === '') return undefined;
  const ref = env['GITHUB_HEAD_REF'] ?? env['GITHUB_REF_NAME'] ?? '';
  const prMatch = /^refs\/pull\/(\d+)\//.exec(env['GITHUB_REF'] ?? '');
  return {
    commit,
    branch: vcs?.branch ?? ref,
    message: '',
    pr: prMatch?.[1] ?? '',
    repo: env['GITHUB_REPOSITORY'] ?? '',
    defaultBranch: '',
  };
}

/** Builds the MobAI run bundle out of one report-1 document. */
export function toBundle(report: Report, options: { projectName: string; env?: Readonly<Record<string, string | undefined>> }): BundleBuild {
  const env = options.env ?? {};
  const files: BuildFile[] = [];
  const cases = collectCases(report, files);
  const last = new Map<string, BundleCase>();
  for (const c of cases) last.set(c.id, c);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  let retried = 0;
  for (const c of last.values()) {
    if (c.status === 'passed') passed += 1;
    else if (c.status === 'skipped') skipped += 1;
    else {
      failed += 1;
      if (c.status === 'error') errored += 1;
    }
    if (c.attempt > 1) retried += 1;
  }
  const seconds = cases.reduce((sum, c) => sum + c.durationMs, 0) / 1000;
  const status = runStatus(report.run.status);
  const git = gitOf(report, env);
  const ci = ciOf(env);
  const bundle: Bundle = {
    schemaVersion: 2,
    runId: `run_${report.run.id.replaceAll(/[^0-9A-Za-z_-]/g, '-')}`.slice(0, 124),
    groupId: '',
    status,
    error: report.run.errors[0]?.message ?? '',
    passed: status === 'passed',
    project: { name: options.projectName, root: '.' },
    runner: { name: 'e2e', version: report.run.runner.version, os: report.run.environment.os },
    startedAt: report.run.startedAt,
    finishedAt: report.run.finishedAt,
    device: deviceOf(report),
    ...(git === undefined ? {} : { git }),
    ...(ci === undefined ? {} : { ci }),
    app: {},
    cases,
    totals: { cases: last.size, passed, failed, skipped, errored, retried, seconds },
  };
  return { bundle, files };
}

/** The `project` of the nearest `mobai.json` at or above `root`, with its name. */
export function findProjectLink(root: string): { project: string; name: string } | undefined {
  let dir = path.resolve(root);
  for (;;) {
    const file = path.join(dir, 'mobai.json');
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { project?: unknown; name?: unknown };
        const project = typeof parsed.project === 'string' ? parsed.project.trim() : '';
        if (project !== '') return { project, name: typeof parsed.name === 'string' ? parsed.name : path.basename(dir) };
      } catch {
        // An unreadable link is no link.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface IngestArtifact {
  id: string;
  path: string;
  state: string;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  reason?: string;
}

interface IngestResponse {
  runId: string;
  clientRunId: string;
  created: boolean;
  artifacts: IngestArtifact[];
}

const UPLOAD_CONCURRENCY = 4;

/** Creates the reporter. Construction has no side effects; everything reads at `onRunFinished`. */
export function mobaiReporter(options: MobaiReporterOptions = {}): Reporter {
  return {
    name: 'mobai',
    async onRunFinished(run: FinishedRun, signal: AbortSignal): Promise<ReporterSummary> {
      const env = process.env;
      // The hold first: the failed screen should be held as soon as possible,
      // and must not wait on (or be skipped by) the upload.
      const held = await settle(run, options, env, signal);
      return [...held, ...(await saveLocal(run, env)), ...(await upload(run, options, env, signal))];
    },
  };
}

/** Saves the run into the MobAI app's local history, only when the app asked (see localrun.ts). */
async function saveLocal(run: FinishedRun, env: Readonly<Record<string, string | undefined>>): Promise<ReporterSummary> {
  const target = localRunTarget(env);
  if (target === undefined) return [];
  try {
    const projectName = findProjectLink(run.projectRoot)?.name ?? path.basename(run.projectRoot);
    return [{ label: 'MobAI', text: await writeLocalRun(run, target, projectName) }];
  } catch (cause) {
    return [{ label: 'MobAI', text: `not saved locally: ${message(cause)}` }];
  }
}

/** Holds the failed tests' devices when a hold was asked for; a passing run touches nothing. */
async function settle(
  run: FinishedRun,
  options: MobaiReporterOptions,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<readonly { label: string; text: string }[]> {
  const settings = engineHold();
  let holdSeconds: number;
  try {
    holdSeconds = parseHold(settings?.holdOnFailure ?? env['MOBAI_E2E_HOLD']);
  } catch (cause) {
    return [{ label: 'MobAI hold', text: message(cause) }];
  }
  if (holdSeconds === 0) return [];
  const { held, refused } = await holdFailed(run.report, { holdSeconds, settings, baseUrl: options.hostUrl, env, signal });
  return [
    ...(held.length > 0 ? [{ label: 'MobAI hold', text: describeHold(held) }] : []),
    ...refused.map((reason) => ({ label: 'MobAI hold', text: reason })),
  ];
}

/** Uploads the run to the dashboard, or says why not. */
async function upload(
  run: FinishedRun,
  options: MobaiReporterOptions,
  env: Readonly<Record<string, string | undefined>>,
  signal: AbortSignal,
): Promise<ReporterSummary> {
  const apiKey = (options.apiKey ?? env['MOBAI_API_KEY'] ?? '').trim();
  if (apiKey === '') return [{ label: 'MobAI', text: 'not uploaded: set MOBAI_API_KEY (a Pro key from the MobAI app, Settings > API keys)' }];
  const link = findProjectLink(run.projectRoot);
  const projectId = (options.projectId ?? env['MOBAI_PROJECT_ID'] ?? link?.project ?? '').trim();
  if (projectId === '') return [{ label: 'MobAI', text: 'not uploaded: no project; link one in mobai.json or set MOBAI_PROJECT_ID' }];
  const baseUrl = (env['MOBAI_API_URL'] ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const projectName = link?.name ?? path.basename(run.projectRoot);
  try {
    return await publish(run, { apiKey, projectId, baseUrl, projectName, projectLabel: link?.name ?? projectId, signal, env });
  } catch (cause) {
    return [{ label: 'MobAI', text: `upload failed: ${message(cause)}` }];
  }
}

interface PublishOptions {
  readonly apiKey: string;
  readonly projectId: string;
  readonly baseUrl: string;
  readonly projectName: string;
  /** The dashboard project as the summary names it: the linked name, else its id. */
  readonly projectLabel: string;
  readonly signal: AbortSignal;
  readonly env: Readonly<Record<string, string | undefined>>;
}

async function publish(run: FinishedRun, options: PublishOptions): Promise<ReporterSummary> {
  const { bundle, files } = toBundle(run.report, { projectName: options.projectName, env: options.env });
  // A run that stopped before any test (no device, a broken config) is not a
  // test run; the terminal already shows why.
  if (bundle.cases.length === 0) return [{ label: 'MobAI', text: `not uploaded: no test ran${bundle.error === '' ? '' : ` (${bundle.error})`}` }];
  const manifest: BundleFile[] = [];
  const seen = new Set<string>();
  // Files the reporter writes itself (device logs) never touch the disk.
  const written = new Map<string, Buffer>();
  for (const { text, ...file } of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    let body: Buffer;
    if (text !== undefined) {
      body = Buffer.from(text);
      written.set(file.path, body);
    } else {
      try {
        body = await readFile(path.join(run.artifactsRoot, ...file.path.split('/')));
      } catch {
        continue;
      }
    }
    manifest.push({ ...file, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') });
  }
  const headers = { 'content-type': 'application/json', 'x-api-key': options.apiKey };
  const ingest = await postJson<IngestResponse>(`${options.baseUrl}/testing/runs`, { projectId: options.projectId, bundle, files: manifest }, headers, options.signal);
  const byPath = new Map(manifest.map((file) => [file.path, file]));
  const pending = ingest.artifacts.filter((artifact) => artifact.state === 'pending' && artifact.uploadUrl !== undefined && byPath.has(artifact.path));
  const uploaded: string[] = [];
  const failures: string[] = [];
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const artifact = queue.shift();
      if (artifact === undefined) return;
      try {
        const body = written.get(artifact.path) ?? (await readFile(path.join(run.artifactsRoot, ...artifact.path.split('/'))));
        const response = await fetch(artifact.uploadUrl as string, {
          method: 'PUT',
          headers: uploadHeaders(artifact.uploadHeaders, byPath.get(artifact.path)?.mime),
          body,
          signal: options.signal,
        });
        if (!response.ok) {
          // Storage explains a refusal in the body (SignatureDoesNotMatch, AccessDenied, ...).
          const reason = (await response.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/)?.[1];
          throw new Error(`HTTP ${response.status}${reason === undefined ? '' : ` ${reason}`}`);
        }
        uploaded.push(artifact.id);
      } catch (cause) {
        failures.push(`${artifact.path}: ${message(cause)}`);
      }
    }
  });
  await Promise.all(workers);
  if (uploaded.length > 0) {
    await postJson(`${options.baseUrl}/testing/artifacts/complete`, { runId: ingest.runId, artifactIds: uploaded }, headers, options.signal);
  }
  const rows: { label: string; text: string }[] = [
    { label: 'MobAI', text: `run ${ingest.runId} ${ingest.created ? 'uploaded to' : 'already in'} project ${options.projectLabel} (${bundle.totals.passed}/${bundle.totals.cases} passed${manifest.length === 0 ? '' : `, ${uploaded.length}/${pending.length} artifacts`})` },
  ];
  if (failures.length > 0) rows.push({ label: 'MobAI', text: `artifacts not uploaded: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` and ${failures.length - 3} more` : ''}` });
  return rows;
}

/**
 * The headers for one artifact PUT: the ones the URL was signed with, as the
 * server sent them. Adding our own content-type beside the server's makes
 * fetch join them ("video/mp4, video/mp4"), which no longer matches the
 * signature, so ours is only a fallback. Content-Length comes from the body.
 */
function uploadHeaders(signed: Readonly<Record<string, string>> | undefined, mime: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed ?? {})) {
    if (name.toLowerCase() !== 'content-length') headers[name] = value;
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = mime ?? 'application/octet-stream';
  }
  return headers;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      detail = parsed.error ?? parsed.message ?? detail;
    } catch {
      // Keep the raw body.
    }
    throw new Error(`${url}: HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`);
  }
  return (text === '' ? {} : JSON.parse(text)) as T;
}
