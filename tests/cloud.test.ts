/**
 * `cloud`: prepare asks the host for one farm session per slot, binds the
 * devices it returns, and finish ends the run's sessions.
 */

import path from 'node:path';
import type { EngineFinishInfo, EnginePrepareInfo } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mobai } from '../src/engine.ts';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[];
let failStart: boolean;

beforeEach(() => {
  calls = [];
  failStart = false;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const { pathname } = new URL(String(url));
    calls.push({ method, path: pathname, body });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/v1/health') return reply(200, { status: 'ok' });
    if (pathname === '/api/v1/devices') return reply(200, []);
    if (pathname === '/api/v1/e2e/cloud/start') {
      if (failStart && body?.['device'] === 'Pixel 8') return reply(500, { error: 'no capacity' });
      return reply(200, { runId: body?.['runId'], deviceId: `browserstack:${String(body?.['device']).replace(/ /g, '_')}:${String(body?.['os'])}`, provider: 'browserstack', name: body?.['device'], os: body?.['os'], platform: 'ios' });
    }
    if (pathname === '/api/v1/e2e/cloud/end') return reply(200, { sessions: [] });
    return reply(200, { success: true });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function prepareInfo(slots: number): EnginePrepareInfo {
  return {
    runId: 'run-7',
    targetName: 'farm',
    projectRoot: '/project',
    app: { bundleId: 'com.example.app', appPath: 'build/App.ipa' },
    slots,
    env: {},
    signal: new AbortController().signal,
    headed: false,
    log: () => undefined,
  } as EnginePrepareInfo;
}

const finishInfo = { runId: 'run-7', env: {}, signal: new AbortController().signal, log: () => undefined } as unknown as EngineFinishInfo;

describe('cloud', () => {
  it('opens one session per slot with the target build, and ends them at finish', async () => {
    const engine = mobai({
      platform: 'ios',
      autoStart: false,
      cloud: [
        { provider: 'browserstack', device: 'iPhone 15', os: '17' },
        { provider: 'browserstack', device: 'iPhone 14', os: '16', app: 'bs://abc', options: { k: 'v' } },
      ],
    });
    expect(engine.workers).toBe(2);
    const prepared = await engine.prepare!(prepareInfo(2));
    const starts = calls.filter((c) => c.path === '/api/v1/e2e/cloud/start').map((c) => c.body);
    expect(starts).toEqual([
      { runId: 'run-7', provider: 'browserstack', device: 'iPhone 15', os: '17', platform: 'ios', app: path.resolve('/project', 'build/App.ipa') },
      { runId: 'run-7', provider: 'browserstack', device: 'iPhone 14', os: '16', platform: 'ios', app: 'bs://abc', options: { k: 'v' } },
    ]);
    expect(Object.values(prepared?.env ?? {})[0]).toContain('browserstack:iPhone_15:17');

    calls = [];
    await engine.finish!(finishInfo);
    expect(calls.filter((c) => c.path === '/api/v1/e2e/cloud/end').map((c) => c.body)).toEqual([{ runId: 'run-7' }]);
  });

  it('ends the opened sessions when one fails to start', async () => {
    failStart = true;
    const engine = mobai({
      platform: 'ios',
      autoStart: false,
      cloud: [
        { provider: 'browserstack', device: 'iPhone 15', os: '17' },
        { provider: 'browserstack', device: 'Pixel 8', os: '14' },
      ],
    });
    await expect(engine.prepare!(prepareInfo(2))).rejects.toThrow(/Pixel 8 on browserstack did not start/);
    expect(calls.some((c) => c.path === '/api/v1/e2e/cloud/end')).toBe(true);
  });

  it('refuses cloud with device, and malformed entries', () => {
    expect(() => mobai({ platform: 'ios', device: 'x', cloud: { provider: 'browserstack', device: 'iPhone 15', os: '17' } })).toThrow(/not both/);
    expect(() => mobai({ platform: 'ios', cloud: [] })).toThrow(/empty pool/);
    // @ts-expect-error an unknown provider
    expect(() => mobai({ platform: 'ios', cloud: { provider: 'nope', device: 'a', os: '1' } })).toThrow(/needs a provider/);
    expect(() => mobai({ platform: 'ios', cloud: { provider: 'saucelabs', device: 'a', os: '' } })).toThrow(/device` and `os`/);
  });
});
