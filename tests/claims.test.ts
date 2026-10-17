/**
 * A host with "Require device claim" on answers the first device call with
 * CLAIM_REQUIRED: prepare claims the device, repeats the call, sends the
 * lease on every later request for the device, and finish releases it.
 */

import type { EngineFinishInfo, EngineInitInfo, EnginePrepareInfo } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mobai, surfaceOf } from '../src/engine.ts';

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  lease: string | null;
}

const DEVICE = '00008110-001651283620201E';
const TOKEN = 'lease-token-1';

let calls: Call[];
let requireClaim: boolean;
let holder: string | undefined;

beforeEach(() => {
  calls = [];
  requireClaim = true;
  holder = undefined;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const lease = new Headers(init?.headers).get('x-lease-token');
    const { pathname } = new URL(String(url));
    calls.push({ method, path: pathname, body, lease });
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/v1/health') return reply(200, { status: 'ok' });
    if (pathname === '/api/v1/devices') return reply(200, [{ id: DEVICE, name: 'iPhone', platform: 'ios', connectionState: 'ready' }]);
    if (pathname === '/api/v1/devices/claim') {
      if (holder !== undefined) return reply(409, { error: `device is in use by ${holder}; claim a different device or wait for the lease to expire`, code: 'DEVICE_IN_USE' });
      return reply(200, { deviceId: DEVICE, leaseToken: TOKEN, expiresAt: '2026-10-17T20:00:00Z', device: {} });
    }
    if (pathname === '/api/v1/devices/release') return reply(200, { status: 'released' });
    if (pathname.startsWith(`/api/v1/devices/${DEVICE}/`) && requireClaim && lease !== TOKEN) {
      return reply(409, { error: 'device must be claimed first: POST /api/v1/devices/claim', code: 'CLAIM_REQUIRED' });
    }
    return reply(200, { success: true });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const prepareInfo = {
  runId: 'run-9',
  targetName: 'ios',
  projectRoot: '/work/numbra',
  app: { bundleId: 'com.example.numbra' },
  slots: 1,
  env: {},
  signal: new AbortController().signal,
  headed: false,
  log: () => undefined,
} as EnginePrepareInfo;

describe('device claims', () => {
  it('claims the device when the host asks, drives it with the lease, and releases it at finish', async () => {
    const engine = mobai({ platform: 'ios', autoStart: false });
    const prepared = await engine.prepare!(prepareInfo);

    const device = calls.filter((c) => c.path.startsWith('/api/v1/devices/'));
    expect(device.map((c) => c.path.replace(`/api/v1/devices/${DEVICE}/`, '').replace('/api/v1/devices/', ''))).toEqual(['bridge/start', 'claim', 'bridge/start', 'launch-app']);
    expect(device[1]?.body).toEqual({ device: DEVICE, holder: 'e2e (numbra)', clientId: `e2e:/work/numbra:${DEVICE}` });
    expect(device.map((c) => c.lease)).toEqual([null, null, TOKEN, TOKEN]);

    // A worker gets the lease through the bindings in the environment.
    const env = { ...prepared?.env };
    const worker = mobai({ platform: 'ios', autoStart: false });
    await worker.init!({ ...prepareInfo, env, workerSlot: 0 } as unknown as EngineInitInfo);
    calls = [];
    await surfaceOf(worker)!.hostSnapshot(new AbortController().signal).catch(() => undefined);
    expect(calls.find((c) => c.path.endsWith('/e2e/snapshot'))?.lease).toBe(TOKEN);

    calls = [];
    await engine.finish!({ ...prepareInfo, env: {} } as unknown as EngineFinishInfo);
    expect(calls.map((c) => [c.path, c.body])).toEqual([['/api/v1/devices/release', { leaseToken: TOKEN }]]);
  });

  it('names the holder when the device is already claimed by someone else', async () => {
    holder = 'Dzmitryi';
    const engine = mobai({ platform: 'ios', autoStart: false });
    await expect(engine.prepare!(prepareInfo)).rejects.toThrow(/bridge on iPhone did not start: claim device: device is in use by Dzmitryi/);
  });

  it('never claims on a host that does not require it', async () => {
    requireClaim = false;
    const engine = mobai({ platform: 'ios', autoStart: false });
    await engine.prepare!(prepareInfo);
    expect(calls.some((c) => c.path === '/api/v1/devices/claim')).toBe(false);
    calls = [];
    await engine.finish!({ ...prepareInfo, env: {} } as unknown as EngineFinishInfo);
    expect(calls).toEqual([]);
  });
});
