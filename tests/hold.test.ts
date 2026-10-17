import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mobai } from '../src/engine.ts';
import { failedDevices, failureDetails, parseHold, resetEngineHold } from '../src/hold.ts';
import { mobaiReporter } from '../src/reporter.ts';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-v1.valid.json'), 'utf8')) as Report;

function copy(): Report {
  return JSON.parse(JSON.stringify(fixture)) as Report;
}

type MutableReport = {
  run: {
    status: string;
    errors: unknown[];
    results: { status: string; attempts: { status: string; error: unknown; environment?: Record<string, string>; steps: { status: string; error?: unknown }[] }[] }[];
  };
};

/** The fixture with its first test failing on its first step, on device SIM-1. */
function failingReport(): Report {
  const report = copy() as unknown as MutableReport;
  report.run.errors = [];
  const result = report.run.results[0]!;
  result.status = 'failed';
  const attempt = result.attempts[0]!;
  attempt.status = 'failed';
  attempt.environment = { platform: 'ios', device: 'iPhone 18 Pro', deviceId: 'SIM-1' };
  attempt.error = { category: 'test', code: 'ASSERTION_FAILED', message: 'expected "unlocked", got "prompting"', retryable: false };
  attempt.steps[0]!.status = 'failed';
  attempt.steps[0]!.error = { category: 'test', code: 'ASSERTION_FAILED', message: 'expected "unlocked", got "prompting"', retryable: false };
  return report as unknown as Report;
}

/** Every test passed, on device SIM-1. */
function passingReport(): Report {
  const report = copy() as unknown as MutableReport;
  report.run.status = 'passed';
  report.run.errors = [];
  for (const result of report.run.results) {
    result.status = 'passed';
    for (const attempt of result.attempts) {
      attempt.status = 'passed';
      attempt.environment = { platform: 'ios', deviceId: 'SIM-1' };
    }
  }
  return report as unknown as Report;
}

describe('parseHold', () => {
  it('reads seconds and durations', () => {
    expect(parseHold(undefined)).toBe(0);
    expect(parseHold(90)).toBe(90);
    expect(parseHold('45')).toBe(45);
    expect(parseHold('90s')).toBe(90);
    expect(parseHold('10m')).toBe(600);
    expect(parseHold('1.5h')).toBe(5400);
    expect(() => parseHold('soon')).toThrow(/duration/);
    expect(() => parseHold(-1)).toThrow(/zero or more/);
  });
});

describe('what a failed run holds', () => {
  it('names the first failing test, its step, and its error', () => {
    const details = failureDetails(failingReport());
    expect(details['test']).toBe('opens app');
    expect(details['error']).toContain('unlocked');
    expect(details['file']).toBe('tests/example.e2e.ts');
  });

  it('holds only the devices failed tests ran on', () => {
    expect(failedDevices(failingReport())).toEqual(['SIM-1']);
    expect(failedDevices(passingReport())).toEqual([]);
  });
});

describe('hold on failure, configured on the engine', () => {
  let server: Server;
  let host: string;
  const holds: { device: string; body: unknown }[] = [];

  beforeEach(() => {
    resetEngineHold();
    holds.length = 0;
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const match = /^\/api\/v1\/devices\/([^/]+)\/e2e\/hold$/.exec(req.url ?? '');
        if (req.method === 'POST' && match !== null) {
          holds.push({ device: decodeURIComponent(match[1]!), body: JSON.parse(body) });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ deviceId: match[1], label: 'e2e · iPhone', holdUntil: '2026-10-12T22:00:00Z' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const finished = (report: Report): FinishedRun => ({ report, projectRoot: '/nowhere', artifactsRoot: '/nowhere' }) as unknown as FinishedRun;

  it("holds the failed test's device and says where to find it, before the upload is considered", async () => {
    mobai({ platform: 'ios', holdOnFailure: '10m', apiKey: 'mobai_engine' });
    const rows = await mobaiReporter({ hostUrl: host, apiKey: '' }).onRunFinished!(finished(failingReport()), new AbortController().signal);
    expect(holds).toEqual([{ device: 'SIM-1', body: { seconds: 600, details: expect.objectContaining({ test: 'opens app' }), apiKey: 'mobai_engine' } }]);
    const lines = (rows ?? []) as { label: string; text: string }[];
    expect(lines[0]?.label).toBe('MobAI hold');
    expect(lines[0]?.text).toContain('"e2e · iPhone"');
    expect(lines[1]?.text).toContain('not uploaded');
  });

  it('touches nothing on a passed run', async () => {
    mobai({ platform: 'ios', holdOnFailure: 600 });
    const rows = (await mobaiReporter({ hostUrl: host, apiKey: '' }).onRunFinished!(finished(passingReport()), new AbortController().signal)) as unknown as { label: string }[];
    expect(holds).toEqual([]);
    expect(rows.some((row) => row.label === 'MobAI hold')).toBe(false);
  });

  it('touches nothing when no hold was asked for', async () => {
    const rows = (await mobaiReporter({ hostUrl: host, apiKey: '' }).onRunFinished!(finished(failingReport()), new AbortController().signal)) as unknown as { label: string }[];
    expect(holds).toEqual([]);
    expect(rows.some((row) => row.label === 'MobAI hold')).toBe(false);
  });

  it('rejects a malformed hold when the config is loaded', () => {
    expect(() => mobai({ platform: 'ios', holdOnFailure: 'soon' })).toThrow(/holdOnFailure/);
  });

  it('says why a requested hold failed', async () => {
    mobai({ platform: 'ios', holdOnFailure: '5m' });
    const rows = (await mobaiReporter({ hostUrl: 'http://127.0.0.1:9', apiKey: '' }).onRunFinished!(finished(failingReport()), new AbortController().signal)) as { label: string; text: string }[];
    expect(rows[0]?.label).toBe('MobAI hold');
    expect(rows[0]?.text).toMatch(/^MobAI host at .* is unreachable/);
  });

  it("passes the host's refusal on as it is", async () => {
    const refusal = 'Hold on error is skipped. Pro tier is required, upgrade with cli command or in desktop App.';
    const refusing = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: refusal }));
      });
    });
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    try {
      mobai({ platform: 'ios', holdOnFailure: '5m' });
      const url = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`;
      const rows = (await mobaiReporter({ hostUrl: url, apiKey: '' }).onRunFinished!(finished(failingReport()), new AbortController().signal)) as { label: string; text: string }[];
      expect(rows[0]).toEqual({ label: 'MobAI hold', text: refusal });
    } finally {
      refusing.close();
    }
  });
});
