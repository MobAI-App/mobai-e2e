/**
 * The MobAI engine for e2e: drives iOS and Android devices through a MobAI
 * host (the desktop app, or `mobai serve`) and contributes the `device`
 * fixture.
 */

import { createRequire } from 'node:module';
import { ConfigurationError, defineEngine, type EngineAppCheckInfo, type EngineAppDeclaration, type EngineHandle, type LocatorActionKind, type PointerActionKind } from 'e2e/engine';
import { createDeviceFixture } from './device.ts';
import { noteEngineHold, parseHold } from './hold.ts';
import type { MobaiOptions } from './options.ts';
import { MobaiSurface } from './surface.ts';

/** The action kinds a MobAI device honors. */
export const DEVICE_ACTIONS: readonly LocatorActionKind[] = [
  'tap',
  'doubleTap',
  'longPress',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'focus',
  'scrollIntoView',
  'selectOption',
  'dragTo',
  'swipe',
];

/** The pointer actions a MobAI device honors at a bare point. */
export const DEVICE_POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'longPress', 'dragTo', 'swipe', 'swipeTo'];

const surfaces = new WeakMap<EngineHandle, MobaiSurface>();
const byTarget = new Map<string, MobaiSurface>();

/** Creates one MobAI engine: one device per worker; a test launches the pinned app with `app.open()`. */
export function mobai(options: MobaiOptions): EngineHandle {
  if (typeof options !== 'object' || options === null) {
    throw new ConfigurationError('INVALID_CONFIG', "mobai() takes an options object, e.g. mobai({ platform: 'ios' })");
  }
  if (options.holdOnFailure !== undefined) {
    try {
      parseHold(options.holdOnFailure);
    } catch (cause) {
      throw new ConfigurationError('INVALID_CONFIG', `mobai(): ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    noteEngineHold({ holdOnFailure: options.holdOnFailure, apiKey: options.apiKey, baseUrl: options.baseUrl, localApiToken: options.localApiToken });
  }
  const surface = new MobaiSurface(options);
  const handle = defineEngine({
    name: 'mobai',
    version: ownVersion(),
    spiVersion: 1,
    platform: surface.platform,
    ...(surface.pool.size === undefined ? {} : { workers: surface.pool.size }),
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    init: async (info) => {
      await surface.init(info);
      byTarget.set(info.targetName, surface);
    },
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: DEVICE_ACTIONS,
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: DEVICE_POINTER_ACTIONS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressFocusedKey(key, operation),
      dismiss: (operation) => surface.dismissKeyboard(operation.signal),
    },
    validateApp: (app, info) => validateApp(app, info),
    // No `open`: a device app has no URL, so `app.open()` is served by
    // `restart`, the fresh launch of the pinned app.
    session: {
      back: (operation) => surface.back(operation),
      restart: (operation) => surface.restart(operation),
      reset: (operation) => surface.reset(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    fixtures: {
      device: (context) => createDeviceFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** A device target launches an installed app or a build: one of `bundleId` and `appPath` is required. */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a mobai() target drives an installed app; use app.bundleId or app.appPath`);
  }
  if (app.bundleId === undefined && app.appPath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs app.bundleId or app.appPath, e.g. targets: [{ engine: mobai({ platform: 'ios' }), app: { bundleId: 'com.example.app' } }]`,
    );
  }
}

/** The surface behind a handle this package created; undefined for any other engine. */
export function surfaceOf(engine: EngineHandle): MobaiSurface | undefined {
  return surfaces.get(engine);
}

/** The surface driving a target in this worker, once its `init` ran. */
export function surfaceForTarget(targetName: string): MobaiSurface | undefined {
  return byTarget.get(targetName);
}

function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
