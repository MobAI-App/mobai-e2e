import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FinishedRun, Report } from 'e2e';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FARM_LOG_MAX, videoOffset, withFarmFiles } from '../src/farmfiles.ts';
import { writeLocalRun } from '../src/localrun.ts';
import { toBundle } from '../src/reporter.ts';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'report-v1.valid.json'), 'utf8')) as Report;

type MutableAttempt = { id: string; status: string; startedAt: string; environment?: Record<string, string>; artifacts: unknown[] };
type MutableReport = { run: { id: string; results: { status: string; attempts: MutableAttempt[] }[] } };

/** The fixture with its first test failing on a farm device. */
function farmReport(deviceId: string): Report {
  const report = JSON.parse(JSON.stringify(fixture)) as MutableReport;
  report.run.id = 'run-farm';
  const result = report.run.results[0]!;
  result.status = 'failed';
  const attempt = result.attempts[0]!;
  attempt.status = 'failed';
  attempt.startedAt = '2026-10-18T10:00:42.000Z';
  attempt.environment = { platform: 'ios', deviceId };
  return report as unknown as Report;
}

describe('farm recordings', () => {
  let server: Server;
  let host = '';
  const asked: unknown[] = [];
  const hostDir = mkdtempSync(path.join(tmpdir(), 'farm-host-'));
  const video = path.join(hostDir, 'video.mp4');
  const log = path.join(hostDir, 'device.log');
  writeFileSync(video, 'mp4 bytes');
  writeFileSync(log, `${'old line\n'.repeat(FARM_LOG_MAX / 9 + 10)}the failure\n`);

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/v1/e2e/cloud/files') {
          asked.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ files: [{ deviceId: 'browserstack:iPhone_15:17', video, deviceLog: log, videoStartedAt: '2026-10-18T10:00:00Z', consoleUrl: 'https://farm/b1' }] }));
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

  it('adds the session video and log to the failed attempt on a farm device, the video starting at it', async () => {
    const artifactsRoot = mkdtempSync(path.join(tmpdir(), 'farm-run-'));
    const run = { report: farmReport('browserstack:iPhone_15:17'), projectRoot: '/nowhere', artifactsRoot } as unknown as FinishedRun;
    const farm = await withFarmFiles(run, { settings: undefined, baseUrl: host, env: {}, signal: new AbortController().signal });
    expect(asked).toEqual([{ runId: 'run-farm', deviceIds: ['browserstack:iPhone_15:17'] }]);
    expect(farm.notes).toEqual([]);
    const { files } = toBundle(farm.run.report, { projectName: 'demo' });
    const farmFiles = files.filter((f) => f.path.startsWith('farm/'));
    expect(farmFiles.map((f) => f.type).sort()).toEqual(['device_log', 'video']);
    const videoRel = farmFiles.find((f) => f.type === 'video')!.path;
    expect(farm.videoStarts.get(videoRel)).toBe(42);
    expect(readFileSync(path.join(artifactsRoot, ...videoRel.split('/')), 'utf8')).toBe('mp4 bytes');
    const logRel = farmFiles.find((f) => f.type === 'device_log')!.path;
    const kept = readFileSync(path.join(artifactsRoot, ...logRel.split('/')), 'utf8');
    expect(kept.length).toBeLessThanOrEqual(FARM_LOG_MAX);
    expect(kept.endsWith('the failure\n')).toBe(true);
    expect(kept.startsWith('old line\n')).toBe(true);
    // The original report is left as it was.
    expect(JSON.stringify(run.report)).not.toContain('farm/');

    const target = { dir: mkdtempSync(path.join(tmpdir(), 'farm-local-')), runId: 'local-1' };
    await writeLocalRun(farm.run, target, 'demo', farm.videoStarts);
    const saved = JSON.parse(readFileSync(path.join(target.dir, 'run.json'), 'utf8')) as { cases: { videos?: { startSec?: number }[]; deviceLog?: unknown }[] };
    const withVideo = saved.cases.find((c) => c.videos !== undefined)!;
    expect(withVideo.videos![0]!.startSec).toBe(42);
    expect(withVideo.deviceLog).toBeDefined();
  });

  it('asks nothing for a run that failed on a local device', async () => {
    asked.length = 0;
    const run = { report: farmReport('SIM-1'), projectRoot: '/nowhere', artifactsRoot: '/nowhere' } as unknown as FinishedRun;
    const farm = await withFarmFiles(run, { settings: undefined, baseUrl: host, env: {}, signal: new AbortController().signal });
    expect(asked).toEqual([]);
    expect(farm.run).toBe(run);
  });

  it('measures where the attempt starts in the recording', () => {
    expect(videoOffset('2026-10-18T10:00:42.300Z', '2026-10-18T10:00:00Z')).toBe(42.3);
    expect(videoOffset('2026-10-18T10:00:00Z', '2026-10-18T10:00:42Z')).toBe(0);
    expect(videoOffset('2026-10-18T10:00:42Z', undefined)).toBe(0);
  });
});
