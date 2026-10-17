import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { toBundle } from '../src/reporter.ts';

const report = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-v1.valid.json'), 'utf8')) as Report;

describe('toBundle', () => {
  const { bundle, files } = toBundle(report, { projectName: 'demo', env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42', GITHUB_JOB: 'ios', GITHUB_SHA: 'a'.repeat(40) } });

  it('names the run the way the ingest expects', () => {
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.runId).toMatch(/^run_[0-9A-Za-z_-]{1,120}$/);
    expect(bundle.status).toBe('failed');
    expect(bundle.passed).toBe(false);
    expect(bundle.runner).toEqual({ name: 'e2e', version: '0.1.0', os: 'darwin' });
    expect(bundle.project).toEqual({ name: 'demo', root: '.' });
    expect(bundle.startedAt).toBe('2026-07-24T12:00:00.000Z');
  });

  it('yields one case per attempt of every selected result', () => {
    expect(bundle.cases.map((c) => [c.id, c.status, c.attempt])).toEqual([
      ['tests/example.e2e.ts::opens app', 'passed', 1],
      ['tests/example.e2e.ts::switches organizations', 'skipped', 1],
    ]);
    const first = bundle.cases[0]!;
    expect(first.kind).toBe('e2e');
    expect(first.sourcePath).toBe('tests/example.e2e.ts');
    expect(first.tags).toEqual(['smoke']);
    expect(first.finishedAt).toBe('2026-07-24T12:00:01.000Z');
    expect(first.definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps steps with their line, label, verdict and error', () => {
    const steps = bundle.cases[0]!.steps;
    expect(steps.length).toBe(2);
    expect(steps[0]).toMatchObject({ index: 0, lineNumber: 3, lineText: 'agent.act adds shoes to the cart', passed: true, durationMs: 4200, error: '' });
    expect(steps[1]).toMatchObject({ index: 1, lineText: 'agent.assert the result is visible', passed: false, error: 'semantic capture timed out' });
    expect(bundle.cases[0]!.failedStepIndex).toBe(1);
  });

  it('keeps mp4 videos in the manifest and leaves webm and hosted ones out', () => {
    expect(files.map((f) => [f.path, f.type, f.caseId])).toEqual([]);
    const totals = bundle.totals;
    expect(totals).toMatchObject({ cases: 2, passed: 1, failed: 0, skipped: 1 });
  });

  it('reads the device from the attempt environment, and the CI job from the environment', () => {
    expect(bundle.device.platform).toBe('web');
    expect(bundle.device.idHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.ci).toEqual({ provider: 'github', runUrl: 'https://github.com/acme/app/actions/runs/42', job: 'ios', runId: '42', attempt: 1, group: '' });
    expect(bundle.git?.commit).toBe('a'.repeat(40));
  });

  it('carries attempt artifacts and failure screenshots into the manifest', () => {
    const withShots = structuredClone(report) as Report;
    const attempt = withShots.run.results[0]!.attempts[0]!;
    (attempt as unknown as { artifacts: unknown[] }).artifacts = [
      { id: 'shot-1', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/001-after.png', size: 1, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'step', stepId: attempt.steps[1]!.id } },
      { id: 'vid-1', kind: 'video', mediaType: 'video/mp4', path: 'ios/t/attempt-0/video/video.mp4', size: 1, sha256: '0'.repeat(64), redaction: 'incomplete', producer: { kind: 'attempt' } },
      // A physical iPhone records MJPEG; the dashboard plays it.
      { id: 'vid-2', kind: 'video', mediaType: 'video/x-motion-jpeg', path: 'ios/t/attempt-0/video/video-1.mjpeg', size: 1, sha256: '0'.repeat(64), redaction: 'incomplete', producer: { kind: 'attempt' } },
    ];
    const built = toBundle(withShots, { projectName: 'demo' });
    expect(built.files.map((f) => [f.path, f.type, f.stepIndex])).toEqual([
      ['ios/t/attempt-0/screenshots/001-after.png', 'failure_screenshot', 1],
      ['ios/t/attempt-0/video/video.mp4', 'video', null],
      ['ios/t/attempt-0/video/video-1.mjpeg', 'video', null],
    ]);
    expect(built.files.find((f) => f.path.endsWith('.mjpeg'))!.mime).toBe('video/x-motion-jpeg');
    expect(built.bundle.cases[0]!.steps[1]!.screenshot).toBe('ios/t/attempt-0/screenshots/001-after.png');
    expect(built.bundle.cases[0]!.evidence).toBeNull();
  });

  it('puts the failure screenshot and the screen at failure on the failed step', () => {
    const failed = structuredClone(report) as Report;
    const attempt = failed.run.results[0]!.attempts[0]! as unknown as { artifacts: unknown[]; failure?: { screenshot?: string; screen?: string } };
    attempt.artifacts = [
      { id: 'shot-f', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/001-failure.png', size: 1, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'attempt' } },
      { id: 'screen-f', kind: 'log', mediaType: 'text/plain', path: 'ios/t/attempt-0/screen-at-failure.txt', size: 1, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'attempt' } },
    ];
    attempt.failure = { screenshot: 'shot-f', screen: 'screen-f' };
    const built = toBundle(failed, { projectName: 'demo' });
    const failedIndex = built.bundle.cases[0]!.failedStepIndex;
    expect(failedIndex).not.toBeNull();
    expect(built.files.map((f) => [f.path, f.type, f.stepIndex])).toEqual([
      ['ios/t/attempt-0/screenshots/001-failure.png', 'failure_screenshot', failedIndex],
      ['ios/t/attempt-0/screen-at-failure.txt', 'ui_tree', failedIndex],
    ]);
    const step = built.bundle.cases[0]!.steps.find((s) => s.index === failedIndex)!;
    expect(step.screenshot).toBe('ios/t/attempt-0/screenshots/001-failure.png');
    expect(step.uiTree).toBe('ios/t/attempt-0/screen-at-failure.txt');
  });

  it("uploads a failed attempt's device logs as its device log, and a passing one's not at all", () => {
    const logged = structuredClone(report) as Report;
    const attempt = logged.run.results[0]!.attempts[0]! as unknown as { id: string; status: string; appLog?: unknown[] };
    attempt.appLog = [
      { source: 'system', level: 'warning', text: 'OkHttp: slow response', at: '2026-07-24T12:00:00.100Z' },
      { source: 'system', level: 'error', text: 'AndroidRuntime: FATAL EXCEPTION: main', at: '2026-07-24T12:00:00.900Z', step: 1 },
    ];
    expect(toBundle(logged, { projectName: 'demo' }).files.filter((f) => f.type === 'device_log')).toEqual([]);
    attempt.status = 'failed';
    const log = toBundle(logged, { projectName: 'demo' }).files.find((f) => f.type === 'device_log');
    expect(log).toMatchObject({ path: `device-logs/${attempt.id}.txt`, mime: 'text/plain', attempt: 1, stepIndex: null });
    expect(log?.text).toBe('2026-07-24T12:00:00.100Z WARNING OkHttp: slow response\n2026-07-24T12:00:00.900Z ERROR [step 1] AndroidRuntime: FATAL EXCEPTION: main\n');
  });
});
