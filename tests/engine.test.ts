/**
 * The engine against a scripted MobAI host: `fetch` is replaced with a
 * router that answers the routes the engine uses and records every action,
 * so the lifecycle, observation, location and dispatch are checked without
 * a device.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineFixtureContext, EngineHandle, Locator, OperationContext } from 'e2e/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSnapshot } from '../src/client.ts';
import { createDeviceFixture, type Device, type DeviceExpectations } from '../src/device.ts';
import { mobai, surfaceOf } from '../src/engine.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const calls: Call[] = [];
let screen: HostSnapshot;

function route(method: string, url: string, body: unknown): { status: number; json: unknown } {
  const { pathname } = new URL(url);
  calls.push({ method, path: pathname, body });
  if (pathname === '/api/v1/health') return { status: 200, json: { status: 'ok' } };
  if (pathname === '/api/v1/devices') {
    return { status: 200, json: [{ id: 'SIM-1', name: 'iPhone 17', platform: 'ios', osVersion: '27.0', virtual: true, connectionState: 'ready' }] };
  }
  if (pathname.endsWith('/e2e/snapshot')) return { status: 200, json: screen };
  if (pathname.endsWith('/screenshot')) return { status: 200, json: { data: '', format: 'png' } };
  if (pathname.endsWith('/e2e/recording/start')) return { status: 501, json: { error: 'this device cannot be recorded' } };
  if (pathname.endsWith('/e2e/select-wheel')) {
    const { value } = body as { value: string };
    if (value === 'nope') return { status: 422, json: { error: "the picker has no such value: Picker wheel has no row 'nope'; it reads '1 min'" } };
    return { status: 200, json: { value: `${value} min` } };
  }
  if (pathname.endsWith('/e2e/alert')) {
    if (method === 'GET') return { status: 200, json: { present: false } };
    return { status: 404, json: { error: 'no alert is open' } };
  }
  if (pathname.endsWith('/e2e/network')) return { status: 501, json: { error: 'not supported on this device' } };
  if (pathname.endsWith('/dsl/execute')) {
    const step = (body as { steps: { action: string; prompt?: string }[] }).steps[0]!;
    if (step.prompt === 'fail') return { status: 200, json: { success: false, step_results: [{ success: false, error: { code: 'TIMEOUT', message: 'activate siri timed out' } }] } };
    return { status: 200, json: { success: true, step_results: [{ success: true, result: step.action === 'siri' ? { js_value: 'It is 10:30.' } : {} }] } };
  }
  if (pathname.endsWith('/collect-list')) {
    return {
      status: 200,
      json: {
        count: 7,
        elements: [
          { index: 0, type: 'XCUIElementTypeApplication', text: 'Settings' },
          { index: 3, type: 'XCUIElementTypeStaticText', text: 'General' },
          { index: 4, type: 'XCUIElementTypeCell', text: '' },
          { index: 5, type: 'XCUIElementTypeButton', text: 'About' },
          { index: 6, type: 'XCUIElementTypeStaticText', text: 'About' },
          { index: 7, type: 'XCUIElementTypeOther', text: 'Vertical scroll bar, 2 pages' },
          { index: 8, type: 'XCUIElementTypeStaticText', text: 'Keyboard' },
        ],
      },
    };
  }
  if (pathname.endsWith('/apps')) {
    return { status: 200, json: [{ bundleId: 'com.example.app', name: 'Example', version: '1.2' }, { bundleId: 'com.apple.Preferences', name: 'Settings' }] };
  }
  if (pathname.endsWith('/e2e/biometrics')) {
    const { sensor } = body as { sensor: string };
    if (sensor === 'fingerprint') return { status: 400, json: { error: 'sensor must be faceid or touchid on iOS, fingerprint on Android: got "fingerprint"' } };
    return { status: 200, json: { success: true } };
  }
  return { status: 200, json: { success: true } };
}

const okScreen = (focused: boolean): HostSnapshot => ({
  platform: 'ios',
  viewport: { width: 400, height: 800 },
  app: { bundleId: 'com.example.app' },
  keyboardShown: false,
  root: {
    type: 'XCUIElementTypeApplication',
    children: [
      { type: 'XCUIElementTypeTextField', text: 'Email', accessibilityId: 'email', bounds: { x: 20, y: 100, width: 360, height: 40 }, enabled: true, editable: true, focused },
      { type: 'XCUIElementTypeButton', text: 'Continue', bounds: { x: 20, y: 200, width: 360, height: 50 }, enabled: true },
      { type: 'XCUIElementTypeSwitch', text: 'Dark mode', value: '0', bounds: { x: 20, y: 300, width: 360, height: 40 }, enabled: true, children: [{ type: 'XCUIElementTypeSwitch', value: '0', bounds: { x: 330, y: 304, width: 50, height: 32 }, enabled: true }] },
      { type: 'XCUIElementTypePickerWheel', value: '1 min', bounds: { x: 20, y: 400, width: 360, height: 200 }, enabled: true },
    ],
  },
});

function operation(origin: 'test' | 'agent' = 'test'): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 5000, runId: 'run', attemptId: 'attempt', origin };
}

let engine: EngineHandle;
let artifactsDir: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const answer = route(method, String(url), body);
    return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'content-type': 'application/json' } });
  });
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'mobai-e2e-'));
  engine = mobai({ platform: 'ios', transition: 0, settle: false });
  const env = {};
  const prepared = await engine.prepare!({ runId: 'run', targetName: 'phone', projectRoot: artifactsDir, app: { bundleId: 'com.example.app' }, slots: 1, env, signal: new AbortController().signal, headed: false, log: () => undefined });
  await engine.init!({ runId: 'run', targetName: 'phone', projectRoot: artifactsDir, app: { bundleId: 'com.example.app' }, env: { ...env, ...(prepared?.env ?? {}) }, headed: false, workerSlot: 0, signal: new AbortController().signal, log: () => undefined });
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(artifactsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.length = 0;
  screen = okScreen(false);
  await engine.endAttempt!({ signal: new AbortController().signal, timeoutMs: 1000 });
  await engine.startAttempt!({
    attemptId: 'attempt',
    artifactsDir,
    resolveSecret: async () => '',
    signal: new AbortController().signal,
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });
});

describe('mobai engine', () => {
  it('declares its capabilities and prepared the device pool', () => {
    expect(engine.name).toBe('mobai');
    expect(engine.platform).toBe('ios');
    expect(engine.capabilities.has('observation')).toBe(true);
    expect(engine.capabilities.has('actions')).toBe(true);
    expect(engine.capabilities.has('location')).toBe(true);
    expect(engine.capabilities.has('pointer')).toBe(true);
    expect(engine.capabilities.has('keyboard')).toBe(true);
    expect(engine.capabilities.has('device')).toBe(true);
    expect(engine.actions).toContain('scrollIntoView');
    expect(engine.actions).toContain('dragTo');
    expect(engine.actions).not.toContain('hover');
    expect(surfaceOf(engine)?.deviceId()).toBe('SIM-1');
  });

  it('observes one root with a stable id and the app as its location', async () => {
    const first = await engine.observe!(operation());
    const second = await engine.observe!(operation());
    expect(first.root.ref.id).toBe('root');
    expect(second.root.ref.id).toBe('root');
    expect(first.viewport).toEqual({ width: 400, height: 800 });
    expect(first.location).toBe('com.example.app');
    const button = first.root.children![0]!.children?.find((n) => n.name === 'Continue') ?? first.root.children!.find((n) => n.name === 'Continue');
    expect(button?.role).toBe('button');
  });

  it('taps a located node at its centre', async () => {
    const [button] = await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Continue', exact: true } } }, operation());
    expect(button).toBeDefined();
    await engine.perform!(button!.ref, { kind: 'tap' }, operation());
    const tap = calls.find((c) => c.path.endsWith('/tap'));
    expect(tap?.body).toEqual({ x: 200, y: 225 });
  });

  it('fills a field by focusing it, clearing it, and typing', async () => {
    const [field] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'email', exact: true } } }, operation());
    await engine.perform!(field!.ref, { kind: 'fill', value: 'me@example.com', sensitive: false }, operation());
    const after = calls.slice(calls.findIndex((c) => c.path.endsWith('/e2e/snapshot')) + 1).map((c) => path.basename(c.path));
    expect(after).toEqual(['tap', 'clear-text', 'type']);
    expect(calls.find((c) => c.path.endsWith('/type'))?.body).toEqual({ text: 'me@example.com' });
  });

  it('checks a switch through its inner control and skips one already in that state', async () => {
    const [toggle] = await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'switch', exact: true } } }, operation());
    await engine.perform!(toggle!.ref, { kind: 'check' }, operation());
    expect(calls.find((c) => c.path.endsWith('/tap'))?.body).toEqual({ x: 355, y: 320 });
    calls.length = 0;
    await engine.perform!(toggle!.ref, { kind: 'uncheck' }, operation());
    expect(calls.some((c) => c.path.endsWith('/tap'))).toBe(false);
  });

  it('scrolls the screen on a root swipe with the DSL drag that stops, twice', async () => {
    await engine.observe!(operation());
    await engine.perform!({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    const drags = calls.filter((c) => c.path.endsWith('/drag')).map((c) => c.body as { fromY: number; toY: number; duration: number; holdDuration: number });
    expect(drags).toHaveLength(2);
    expect(drags[0]!.fromY).toBeGreaterThan(drags[0]!.toY);
    expect(drags[0]).toMatchObject({ duration: 200, holdDuration: 50 });
    expect(calls.some((c) => c.path.endsWith('/swipe'))).toBe(false);
  });

  it('refuses a stale ref', async () => {
    const [button] = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Continue', exact: true } } }, operation());
    await engine.perform!({ id: 'n9999', revision: '' }, { kind: 'tap' }, operation()).then(
      () => {
        throw new Error('expected NODE_STALE');
      },
      (error: { code: string; retryable: boolean }) => {
        expect(error.code).toBe('NODE_STALE');
        expect(error.retryable).toBe(true);
      },
    );
    expect(button).toBeDefined();
  });

  it('types into the focused field and presses Enter as a newline on iOS', async () => {
    await engine.keyboard!.type('hi', { replace: true }, operation());
    expect(calls.map((c) => path.basename(c.path))).toEqual(['clear-text', 'type']);
    calls.length = 0;
    await engine.keyboard!.press('Enter', operation());
    expect(calls.find((c) => c.path.endsWith('/type'))?.body).toEqual({ text: '\n' });
    await expect(engine.keyboard!.press('Control+a', operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('relaunches the pinned app on restart', async () => {
    await engine.session!.restart!(operation());
    expect(calls.map((c) => path.basename(c.path))).toEqual(['kill-app', 'launch-app']);
    expect(calls[1]?.body).toEqual({ bundleId: 'com.example.app', noWait: true });
  });

  it('acts at bare points', async () => {
    await engine.observe!(operation());
    await engine.performAt!({ x: 10, y: 20 }, { kind: 'swipeTo', target: { x: 10, y: 300 } }, operation());
    expect(calls.find((c) => c.path.endsWith('/swipe'))?.body).toMatchObject({ fromX: 10, fromY: 20, toX: 10, toY: 300 });
    await expect(engine.performAt!({ x: 10, y: 20 }, { kind: 'hover' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('treats a device without a recorder as no video, not a failure', async () => {
    await engine.artifacts!.startVideo!(operation());
    expect(await engine.artifacts!.stopVideo!(operation())).toEqual([]);
  });

  it('turns a picker wheel to the row named by text', async () => {
    const [wheel] = await engine.locate!({ kind: 'selector', selector: 'type=XCUIElementTypePickerWheel' }, operation());
    expect(wheel).toBeDefined();
    await engine.perform!(wheel!.ref, { kind: 'selectOption', value: '5' }, operation());
    const call = calls.find((c) => c.path.endsWith('/e2e/select-wheel'));
    expect(call?.body).toEqual({ x: 200, y: 500, value: '5' });
    expect(calls.some((c) => c.path.endsWith('/tap'))).toBe(false);
    await expect(engine.perform!(wheel!.ref, { kind: 'selectOption', value: { label: 'nope' } }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    await expect(engine.perform!(wheel!.ref, { kind: 'selectOption', value: { index: 2 } }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('rotates, restyles, and handles alerts through the device fixture', async () => {
    const { device } = fixture();
    await device.setOrientation('landscape-left');
    expect(calls.find((c) => c.path.endsWith('/e2e/orientation'))?.body).toEqual({ orientation: 'landscape-left' });
    await device.setAppearance('dark');
    expect(calls.find((c) => c.path.endsWith('/e2e/appearance'))?.body).toEqual({ mode: 'dark' });
    await device.setPermission('media-library', 'grant');
    expect(calls.find((c) => c.path.endsWith('/e2e/permissions'))?.body).toEqual({ bundleId: 'com.example.app', permissions: { medialibrary: 'allow' } });
    await expect(device.alert('accept')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(device.setNetwork('offline')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await device.enrollBiometrics('faceid', true);
    await device.setBiometrics('faceid', 'nonmatch');
    const biometrics = calls.filter((c) => c.path.endsWith('/e2e/biometrics')).map((c) => c.body);
    expect(biometrics).toEqual([
      { sensor: 'faceid', action: 'enroll' },
      { sensor: 'faceid', action: 'nomatch' },
    ]);
    await expect(device.setBiometrics('fingerprint', 'match')).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('drags along a path, each leg at its own speed', async () => {
    const { device } = fixture();
    await device.drag([
      { x: '50%', y: '80%', holdMs: 400 },
      { x: 200, y: 320, durationMs: 600 },
      { x: '25%', y: 320 },
    ]);
    const step = (calls.find((c) => c.path.endsWith('/dsl/execute'))?.body as { steps: { action: string; actions: { actions: unknown[] }[] }[] }).steps[0]!;
    expect(step.action).toBe('perform_actions');
    expect(step.actions[0]!.actions).toEqual([
      { type: 'pointerMove', x: 200, y: 640, duration: 0 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 400 },
      { type: 'pointerMove', x: 200, y: 320, duration: 600 },
      { type: 'pointerMove', x: 100, y: 320, duration: 300 },
      { type: 'pointerUp', button: 0 },
    ]);
    await expect(device.drag([{ x: 1, y: 1 }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.drag([{ x: 'half' as '1%', y: 1 }, { x: 1, y: 1 }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('pinches and two-finger taps at the centre, a point, or a locator', async () => {
    const { device } = fixture();
    await device.pinch(2);
    expect(calls.find((c) => c.path.endsWith('/pinch'))?.body).toEqual({ x: 200, y: 400, scale: 2 });
    const map = { boundingBox: async () => ({ x: 0, y: 100, width: 400, height: 300 }) } as unknown as Locator;
    await device.pinch(0.5, { at: map });
    expect(calls.filter((c) => c.path.endsWith('/pinch')).at(-1)?.body).toEqual({ x: 200, y: 250, scale: 0.5 });
    await device.twoFingerTap({ x: '10%', y: 80 });
    expect(calls.find((c) => c.path.endsWith('/two-finger-tap'))?.body).toEqual({ x: 40, y: 80 });
    await expect(device.pinch(0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('collects a list: the largest scrollable, its row texts once each', async () => {
    const { device } = fixture();
    screen = listScreen();
    const texts = await device.collectList();
    expect(calls.find((c) => c.path.endsWith('/collect-list'))?.body).toEqual({ listIndex: 2, direction: 'down' });
    expect(texts).toEqual(['General', 'About', 'Keyboard']);
    const small = { boundingBox: async () => ({ x: 0, y: 700, width: 400, height: 50 }) } as unknown as Locator;
    await device.collectList(small, { direction: 'up' });
    expect(calls.filter((c) => c.path.endsWith('/collect-list')).at(-1)?.body).toEqual({ listIndex: 9, direction: 'up' });
    screen = okScreen(false);
    await expect(device.collectList()).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it("asks Siri and returns its answer; lists the device's apps", async () => {
    const { device } = fixture();
    await expect(device.siri('What time is it')).resolves.toBe('It is 10:30.');
    expect(calls.find((c) => c.path.endsWith('/dsl/execute'))?.body).toEqual({ version: '0.2', steps: [{ action: 'siri', prompt: 'What time is it' }] });
    await expect(device.siri('fail')).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'siri: activate siri timed out' });
    await expect(device.installedApps()).resolves.toEqual([{ bundleId: 'com.example.app', name: 'Example', version: '1.2' }, { bundleId: 'com.apple.Preferences', name: 'Settings' }]);
  });

  it('expects the screen to change after an action', async () => {
    const { device, expectations } = fixture();
    await expectations().toChangeScreen(async () => {
      screen = okScreen(true);
    });
    await expect(expectations().toChangeScreen(async () => undefined, { timeout: 50 })).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(device).toBeDefined();
  });
});

/** The device fixture over the engine's surface, with the harness's recording left out. */
function fixture(): { device: Device; expectations: () => DeviceExpectations } {
  let factory: (() => DeviceExpectations) | undefined;
  const context = {
    targetName: 'phone',
    signal: new AbortController().signal,
    timeouts: { test: 30_000, action: 5_000, assertion: 1_000 },
    fixture: <T extends object>(_name: string, value: T) => value,
    expectable: <T extends object>(target: T, make: () => DeviceExpectations) => {
      factory = make;
      return target;
    },
    locator: () => undefined,
    operation,
  } as unknown as EngineFixtureContext;
  const device = createDeviceFixture(surfaceOf(engine)!, context);
  return { device, expectations: () => factory!() };
}

/** A settings-style screen: a full-screen list with chrome and a scroll bar, and a small strip list at the bottom. */
function listScreen(): HostSnapshot {
  return {
    platform: 'ios',
    viewport: { width: 400, height: 800 },
    app: { bundleId: 'com.apple.Preferences' },
    keyboardShown: false,
    root: {
      index: 0,
      type: 'XCUIElementTypeApplication',
      children: [
        { index: 2, type: 'XCUIElementTypeCollectionView', scrollable: true, bounds: { x: 0, y: 0, width: 400, height: 800 } },
        { index: 9, type: 'XCUIElementTypeScrollView', scrollable: true, bounds: { x: 0, y: 690, width: 400, height: 60 } },
      ],
    },
  };
}
