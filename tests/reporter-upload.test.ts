/**
 * The reporter's upload protocol against a stub of the MobAI API: ingest
 * answers with presigned upload URLs, the reporter PUTs each file, then
 * completes the artifacts. The stub records every request.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mobaiReporter } from '../src/reporter.ts';

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const seen: Seen[] = [];
let server: Server;
let baseUrl: string;
let root: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('latin1');
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/api/v1/testing/runs') {
        const request = JSON.parse(body) as { files: { path: string; mime: string; bytes: number }[] };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            runId: 'srv-run-1',
            clientRunId: 'run_x',
            created: true,
            artifacts: request.files.map((file, i) => ({ id: `art-${i}`, path: file.path, state: 'pending', uploadUrl: `${baseUrl}/put/${i}`, uploadHeaders: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes), 'x-amz-meta-kind': 'test' } })),
          }),
        );
        return;
      }
      if (req.url?.startsWith('/put/')) {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.url === '/api/v1/testing/artifacts/complete') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ artifacts: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  root = mkdtempSync(path.join(tmpdir(), 'mobai-e2e-upload-'));
  writeFileSync(path.join(root, 'mobai.json'), JSON.stringify({ project: 'proj-123', name: 'Demo App' }));
  mkdirSync(path.join(root, '.e2e', 'results', 'ios', 't', 'attempt-0', 'screenshots'), { recursive: true });
  writeFileSync(path.join(root, '.e2e', 'results', 'ios', 't', 'attempt-0', 'screenshots', '001-after.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function finishedRun(): FinishedRun {
  const report = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-v1.valid.json'), 'utf8')) as Report;
  const attempt = report.run.results[0]!.attempts[0]!;
  (attempt as unknown as { artifacts: unknown[] }).artifacts = [
    { id: 'shot-1', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/001-after.png', size: 7, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'step', stepId: attempt.steps[1]!.id } },
    { id: 'missing', kind: 'screenshot', mediaType: 'image/png', path: 'ios/t/attempt-0/screenshots/never-written.png', size: 7, sha256: '0'.repeat(64), redaction: 'complete', producer: { kind: 'attempt' } },
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mobaiReporter upload', () => {
  it('ingests, uploads pending artifacts, and completes them', async () => {
    vi.stubEnv('MOBAI_API_URL', `${baseUrl}/api/v1`);
    const reporter = mobaiReporter({ apiKey: 'mobai_test' });
    const rows = await reporter.onRunFinished!(finishedRun(), new AbortController().signal);
    expect(rows).toBeTruthy();
    expect(rows![0]!.text).toMatch(/run srv-run-1 uploaded to project Demo App/);

    const ingest = seen.find((s) => s.url === '/api/v1/testing/runs')!;
    expect(ingest.headers['x-api-key']).toBe('mobai_test');
    const request = JSON.parse(ingest.body) as { projectId: string; bundle: { runId: string; cases: unknown[] }; files: { path: string; type: string; bytes: number; sha256: string }[] };
    expect(request.projectId).toBe('proj-123');
    expect(request.bundle.runId).toMatch(/^run_/);
    expect(request.bundle.cases.length).toBe(2);
    // The artifact that never landed on disk is left out of the manifest.
    expect(request.files.map((f) => [f.path, f.type, f.bytes])).toEqual([['ios/t/attempt-0/screenshots/001-after.png', 'failure_screenshot', 7]]);
    expect(request.files[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);

    const put = seen.find((s) => s.method === 'PUT')!;
    expect(put.url).toBe('/put/0');
    expect(put.headers['x-amz-meta-kind']).toBe('test');
    // Signed like the real server (Content-Type, Content-Length): sent once,
    // exactly as signed; a second content-type beside it broke the signature.
    expect(put.headers['content-type']).toBe('image/png');
    expect(put.headers['content-length']).toBe('7');
    expect(Buffer.from(put.body, 'latin1')[0]).toBe(0x89);

    const complete = seen.find((s) => s.url === '/api/v1/testing/artifacts/complete')!;
    expect(JSON.parse(complete.body)).toEqual({ runId: 'srv-run-1', artifactIds: ['art-0'] });
  });

  it('does nothing without a key, and reports a failed upload as a row', async () => {
    vi.stubEnv('MOBAI_API_URL', `${baseUrl}/api/v1`);
    const silent = mobaiReporter({ apiKey: '' });
    const before = seen.length;
    const rows = await silent.onRunFinished!(finishedRun(), new AbortController().signal);
    expect(rows![0]!.text).toMatch(/MOBAI_API_KEY/);
    expect(seen.length).toBe(before);

    vi.stubEnv('MOBAI_API_URL', `${baseUrl}/nowhere`);
    const broken = mobaiReporter({ apiKey: 'mobai_test' });
    const failed = await broken.onRunFinished!(finishedRun(), new AbortController().signal);
    expect(failed![0]!.text).toMatch(/upload failed: .*404/);
  });

  it('uploads nothing when no test ran', async () => {
    vi.stubEnv('MOBAI_API_URL', `${baseUrl}/api/v1`);
    const run = finishedRun();
    const stopped = run.report.run as unknown as { results: unknown[]; errors: { message: string }[] };
    stopped.results = [];
    stopped.errors = [{ message: 'no device' }];
    const before = seen.length;
    const rows = await mobaiReporter({ apiKey: 'mobai_test' }).onRunFinished!(run, new AbortController().signal);
    expect(rows![0]!.text).toBe('not uploaded: no test ran (no device)');
    expect(seen.length).toBe(before);
  });
});
