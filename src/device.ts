/**
 * The `device` fixture: deterministic device management this engine
 * contributes. A test calls these directly; the harness records each call
 * as a `device.<method>` step.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { TestError, type EngineFixtureContext, type Expectable, type Locator } from 'e2e/engine';
import type { Point, Rect } from './client.ts';
import { notActionable, unsupported } from './errors.ts';
import { DEFAULT_LEG_MS, dragActions, resolvePoint, type Coordinate, type DragPoint } from './gestures.ts';
import { findList, listTexts } from './lists.ts';
import { changedElements, screenSignature } from './screenchange.ts';
import type { MobaiSurface } from './surface.ts';

export type FoldPose = 'closed' | 'half-open' | 'open';

export interface InstallAppOptions {
  /** Bundle id or package of the build; `reinstall` needs one. Defaults to the pinned app. */
  readonly app?: string;
  /** Remove the installed app first so the build starts with no data. */
  readonly reinstall?: boolean;
}

export interface InstalledApp {
  readonly app: string;
  readonly bundleId?: string;
}

export interface OpenAppOptions {
  /** Terminate the app first, so it starts fresh. */
  readonly relaunch?: boolean;
  /** Arguments this launch hands the app; replaces the target's `app.launchArguments` for a relaunch of the pinned app. */
  readonly launchArguments?: readonly string[];
  /** Environment variables this launch hands the app (iOS); replaces the engine's `launchEnvironment` for a relaunch of the pinned app. */
  readonly launchEnvironment?: Readonly<Record<string, string>>;
}

export interface ForegroundApp {
  readonly name: string;
  readonly bundleId?: string;
}

/** An app installed on the device. */
export interface DeviceApp {
  readonly bundleId: string;
  readonly name: string;
  /** The version the app declares, where the device reports one. */
  readonly version?: string;
}

/** Where a two-finger gesture lands: the centre of what a locator matches, or a point. */
export type GestureTarget = Locator | { readonly x: Coordinate; readonly y: Coordinate };

/** What `expect(device)` checks. */
export interface DeviceExpectations {
  /**
   * Runs `action`, then passes once the screen differs from the one before
   * it, within `timeout` (the assertion timeout by default). Catches a tap
   * that did nothing.
   */
  toChangeScreen(action: () => Promise<unknown>, options?: { readonly timeout?: number }): Promise<void>;
}

/** The `device` fixture's methods. */
export interface DeviceControls {
  /**
   * A locator from a MobAI selector, for nodes the closed `screen` query
   * vocabulary cannot name: `id=login_button`, `text="Sign in"`,
   * `text~=Sign`, `role=button`, `type=XCUIElementTypeCell`, `value=1`.
   */
  locator(selector: string): Locator;
  /** Installs a build (`.app`, `.ipa`, or `.apk`, resolved against the project root); without a path, the target's `app.appPath`. */
  installApp(appPath?: string, options?: InstallAppOptions): Promise<InstalledApp>;
  /** Brings an app to the foreground; `relaunch` restarts it fresh. */
  openApp(app: string, options?: OpenAppOptions): Promise<void>;
  /** Opens a deep link or a web link on the device; with `app`, that app is brought up first so a link it handles opens in it. */
  openLink(url: string, options?: { app?: string }): Promise<void>;
  /** Terminates an app (the pinned one by default). */
  closeApp(app?: string): Promise<void>;
  /** Wipes an app's data (the pinned one by default). Android clears it in place; iOS reinstalls the target's build. */
  clearAppState(app?: string): Promise<void>;
  /**
   * Wipes the simulator's keychain, every app's entries (simctl has no
   * per-app reset): what `app.clearState()` leaves behind, such as a saved
   * session token. iOS simulators only.
   */
  clearKeychain(): Promise<void>;
  /** The app in front, as the device reports it. */
  foregroundApp(): Promise<ForegroundApp>;
  /** Sends the device to its home screen. */
  home(): Promise<void>;
  /** Navigates back once: the hardware key on Android, the navigation bar's back button or the edge gesture on iOS. */
  back(): Promise<void>;
  /** Dismisses the soft keyboard. */
  dismissKeyboard(): Promise<void>;
  /** Reads the clipboard. */
  clipboard(): Promise<string>;
  /** Writes the clipboard. */
  setClipboard(text: string): Promise<void>;
  /** Sets the simulated location. */
  setLocation(coordinates: { latitude: number; longitude: number }): Promise<void>;
  /** Turns simulated location off. */
  clearLocation(): Promise<void>;
  /** Puts a foldable simulator in a hinge pose. */
  fold(pose: FoldPose): Promise<void>;
  /** Switches Wi-Fi and mobile data together. Android only: iOS gives a host no network switch. */
  setNetwork(state: 'online' | 'offline'): Promise<void>;
  /** Toggles airplane mode. Android only. */
  setAirplaneMode(enabled: boolean): Promise<void>;
  /**
   * Grants, denies, or resets one permission of the pinned app (camera,
   * microphone, photos, contacts, notifications, calendar, location,
   * reminders, motion, siri, media-library). Android and iOS simulators;
   * a physical iPhone has no such switch. A change can terminate the
   * running app, so it goes before `app.open()`.
   */
  setPermission(permission: string, state: 'grant' | 'deny' | 'reset'): Promise<void>;
  /** Sets the system appearance. */
  setAppearance(mode: 'light' | 'dark'): Promise<void>;
  /** Rotates the device; the app in front decides whether it follows. Android knows portrait and landscape only. */
  setOrientation(orientation: 'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right'): Promise<void>;
  /** Accepts or dismisses the system alert in front; `INVALID_STATE` when none is open. */
  alert(action: 'accept' | 'dismiss'): Promise<void>;
  /** Sends one biometric attempt to the app's prompt: Face ID or Touch ID on an iOS simulator, the fingerprint on Android. */
  setBiometrics(sensor: 'faceid' | 'touchid' | 'fingerprint', result: 'match' | 'nonmatch'): Promise<void>;
  /** Enrolls or clears the simulator's Face ID or Touch ID. iOS simulators only; Android enrolls a finger only through Settings. */
  enrollBiometrics(sensor: 'faceid' | 'touchid', enrolled: boolean): Promise<void>;
  /**
   * Drags one finger along `points`, in screen points or percentages
   * (`'50%'`): down on the first, each leg at its own `durationMs`, resting
   * `holdMs` where a point says so, up on the last.
   */
  drag(points: readonly DragPoint[]): Promise<void>;
  /** Pinches two fingers by `scale` (above 1 zooms in, below 1 out), around `at` or the screen's centre. */
  pinch(scale: number, options?: { readonly at?: GestureTarget }): Promise<void>;
  /** Taps with two fingers at once, at `at` or the screen's centre. */
  twoFingerTap(at?: GestureTarget): Promise<void>;
  /**
   * Scrolls a list to its end and returns the text of every row it passed,
   * in order, each once: what a long list holds beyond the screen. The list
   * is the scrollable that `list` matches, else the largest on screen. It is
   * left scrolled to the end.
   */
  collectList(list?: Locator, options?: { readonly direction?: 'down' | 'up' }): Promise<string[]>;
  /** Asks Siri (iOS) and returns what Siri answered, or '' when it said nothing readable. */
  siri(command: string): Promise<string>;
  /** The apps installed on the device, with the version each declares where the device reports it. */
  installedApps(): Promise<DeviceApp[]>;
}

/** Deterministic device management exposed to tests as `device`; `expect(device)` takes `DeviceExpectations`. */
export interface Device extends DeviceControls, Expectable<DeviceExpectations> {}

function isLocator(target: GestureTarget): target is Locator {
  return typeof (target as Locator).boundingBox === 'function';
}

const SCREEN_POLL_MS = 200;

/** The engine's permission names, by the fixture's (`media-library` is one word on the host). */
const PERMISSION_NAMES: Readonly<Record<string, string>> = { 'media-library': 'medialibrary' };
const PERMISSION_STATES = { grant: 'allow', deny: 'deny', reset: 'unset' } as const;

const FOLD_STATES: Readonly<Record<FoldPose, string>> = { closed: 'closed', 'half-open': 'half', open: 'open' };

/** Builds the device fixture for one attempt. */
export function createDeviceFixture(surface: MobaiSurface, context: EngineFixtureContext): Device {
  /** A gesture's anchor in screen points: a locator's centre, a point, else the screen's centre. */
  const anchor = async (target: GestureTarget | undefined, name: string): Promise<Point> => {
    if (target !== undefined && isLocator(target)) {
      const box = await target.boundingBox();
      if (box === null) throw new TestError('INVALID_ARGUMENT', `${name}: the locator matches nothing on screen`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    const viewport = await surface.viewport(context.signal);
    return target === undefined ? { x: viewport.width / 2, y: viewport.height / 2 } : resolvePoint(target, viewport, name);
  };
  const device: DeviceControls = {
    locator: (selector) => context.locator({ kind: 'selector', selector }),
    async installApp(appPath, options) {
      return surface.installApp(appPath, options ?? {}, context.signal);
    },
    async openApp(app, options) {
      await surface.openApp(app, options ?? {}, context.signal);
    },
    async openLink(url, options) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new TestError('INVALID_ARGUMENT', `openLink takes a URL, got ${JSON.stringify(url)}`);
      }
      if (['file:', 'data:', 'javascript:', 'blob:', 'filesystem:', 'view-source:'].includes(parsed.protocol)) {
        throw new TestError('POLICY_DENIED', `openLink refuses ${parsed.protocol} links`);
      }
      if (options?.app !== undefined) await surface.openApp(options.app, {}, context.signal);
      await surface.openLink(parsed.href, context.signal);
    },
    async closeApp(app) {
      await surface.closeApp(app, context.signal);
    },
    async clearAppState(app) {
      const target = app ?? surface.pinnedApp;
      if (target === undefined) throw new TestError('INVALID_ARGUMENT', "clearAppState needs an app: pass one, or pin one with the target's app.bundleId");
      await surface.clearAppState(target, context.signal);
    },
    async clearKeychain() {
      await surface.command('device.clearKeychain', (client, id) => client.resetKeychain(id, context.signal), context.signal);
    },
    async foregroundApp() {
      const state = await surface.command('device.foregroundApp', (client, id) => client.state(id, context.signal), context.signal);
      const name = state.packageName ?? state.activity ?? '';
      return { name, ...(state.packageName === undefined ? {} : { bundleId: state.packageName }) };
    },
    async home() {
      await surface.screenCommand('device.home', (client, id) => client.goHome(id, context.signal), context.signal);
    },
    async back() {
      await surface.back(context.operation());
    },
    async dismissKeyboard() {
      await surface.dismissKeyboard(context.signal);
    },
    async clipboard() {
      const result = await surface.command('device.clipboard', (client, id) => client.clipboard(id, context.signal), context.signal);
      return result.text;
    },
    async setClipboard(text) {
      await surface.command('device.setClipboard', (client, id) => client.setClipboard(id, text, context.signal), context.signal);
    },
    async setLocation({ latitude, longitude }) {
      await surface.command('device.setLocation', (client, id) => client.setLocation(id, latitude, longitude, context.signal), context.signal);
    },
    async clearLocation() {
      await surface.command('device.clearLocation', (client, id) => client.resetLocation(id, context.signal), context.signal);
    },
    async fold(pose) {
      await surface.screenCommand('device.fold', (client, id) => client.fold(id, FOLD_STATES[pose], context.signal), context.signal);
    },
    async setNetwork(state) {
      const on = state === 'online';
      await surface.command('device.setNetwork', (client, id) => client.setNetwork(id, { wifi: on, data: on }, context.signal), context.signal);
    },
    async setAirplaneMode(enabled) {
      await surface.command('device.setAirplaneMode', (client, id) => client.setNetwork(id, { airplane: enabled }, context.signal), context.signal);
    },
    async setPermission(permission, state) {
      const app = surface.pinnedApp;
      if (app === undefined) throw new TestError('INVALID_ARGUMENT', "setPermission needs the target's app.bundleId to name the app");
      const value = PERMISSION_STATES[state];
      if (value === undefined) throw new TestError('INVALID_ARGUMENT', `setPermission takes grant, deny, or reset, got ${JSON.stringify(state)}`);
      const name = PERMISSION_NAMES[permission] ?? permission;
      await surface.command('device.setPermission', (client, id) => client.setPermissions(id, app, { [name]: value }, context.signal), context.signal);
    },
    async setAppearance(mode) {
      await surface.screenCommand('device.setAppearance', (client, id) => client.setAppearance(id, mode, context.signal), context.signal);
    },
    async setOrientation(orientation) {
      await surface.screenCommand('device.setOrientation', (client, id) => client.setOrientation(id, orientation, context.signal), context.signal);
    },
    async alert(action) {
      await surface.screenCommand('device.alert', (client, id) => client.handleAlert(id, action, undefined, context.signal), context.signal);
    },
    async setBiometrics(sensor, result) {
      const action = result === 'match' ? 'match' : 'nomatch';
      await surface.screenCommand('device.setBiometrics', (client, id) => client.biometrics(id, sensor, action, context.signal), context.signal);
    },
    async enrollBiometrics(sensor, enrolled) {
      await surface.command('device.enrollBiometrics', (client, id) => client.biometrics(id, sensor, enrolled ? 'enroll' : 'unenroll', context.signal), context.signal);
    },
    async drag(points) {
      if (!Array.isArray(points)) throw new TestError('INVALID_ARGUMENT', 'drag takes a list of points');
      const actions = dragActions(points, await surface.viewport(context.signal));
      await surface.screenCommand('device.drag', (client, id) => client.performActions(id, actions, context.signal), context.signal);
    },
    async pinch(scale, options) {
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
        throw new TestError('INVALID_ARGUMENT', `pinch takes a scale above 0 (2 zooms in, 0.5 out), got ${String(scale)}`);
      }
      const at = await anchor(options?.at, 'pinch');
      await surface.screenCommand('device.pinch', (client, id) => client.pinch(id, at, scale, context.signal), context.signal);
    },
    async twoFingerTap(target) {
      const at = await anchor(target, 'twoFingerTap');
      await surface.screenCommand('device.twoFingerTap', (client, id) => client.twoFingerTap(id, at, context.signal), context.signal);
    },
    async collectList(list, options) {
      const direction = options?.direction ?? 'down';
      if (direction !== 'down' && direction !== 'up') throw new TestError('INVALID_ARGUMENT', `collectList scrolls 'down' or 'up', got ${JSON.stringify(direction)}`);
      let box: Rect | undefined;
      if (list !== undefined) {
        box = (await list.boundingBox()) ?? undefined;
        if (box === undefined) throw new TestError('INVALID_ARGUMENT', 'collectList: the locator matches nothing on screen');
      }
      const raw = await surface.hostSnapshot(context.signal);
      const index = findList(raw.root, box)?.index;
      if (index === undefined) throw notActionable(`collectList: ${box === undefined ? 'no scrollable list is on screen' : 'nothing scrollable is where the locator matches'}`);
      const result = await surface.screenCommand('device.collectList', (client, id) => client.collectList(id, index, direction, context.signal), context.signal);
      return listTexts(result.elements);
    },
    async siri(command) {
      if (surface.platform !== 'ios') throw unsupported('siri is iOS only');
      if (typeof command !== 'string' || command.trim() === '') throw new TestError('INVALID_ARGUMENT', 'siri takes what to ask, as text');
      const result = await surface.screenCommand('device.siri', (client, id) => client.dslStep(id, { action: 'siri', prompt: command }, context.signal, 'siri'), context.signal);
      return typeof result.js_value === 'string' ? result.js_value : '';
    },
    async installedApps() {
      const apps = await surface.command('device.installedApps', (client, id) => client.installedApps(id, context.signal), context.signal);
      return apps.map((app) => ({ bundleId: app.bundleId, name: app.name, ...(app.version === undefined || app.version === '' ? {} : { version: app.version }) }));
    },
  };
  const expectations: DeviceExpectations = {
    async toChangeScreen(act, options) {
      if (typeof act !== 'function') throw new TestError('INVALID_ARGUMENT', 'toChangeScreen takes the action to run, as a function');
      const timeout = options?.timeout ?? context.timeouts.assertion;
      const before = screenSignature((await surface.hostSnapshot(context.signal)).root);
      await act();
      const deadline = Date.now() + timeout;
      for (;;) {
        const after = screenSignature((await surface.hostSnapshot(context.signal)).root);
        if (changedElements(before, after) > 0) return;
        if (Date.now() >= deadline) throw new TestError('ASSERTION_FAILED', `the screen did not change within ${String(timeout)}ms of the action`);
        await sleep(SCREEN_POLL_MS, undefined, { signal: context.signal });
      }
    },
  };
  const action = { kind: 'resource' } as const;
  const fixture = context.fixture('device', device, {
    installApp: { ...action, label: (appPath) => appPath ?? surface.appPath ?? 'appPath' },
    openApp: { ...action, label: (app) => app },
    openLink: { ...action, label: (url) => url },
    closeApp: { ...action, label: (app) => app ?? surface.pinnedApp ?? 'app' },
    clearAppState: { ...action, label: (app) => app ?? surface.pinnedApp ?? 'app' },
    clearKeychain: action,
    foregroundApp: action,
    home: action,
    back: action,
    dismissKeyboard: action,
    clipboard: action,
    setClipboard: { ...action, label: (text) => `${text.length} chars` },
    setLocation: action,
    clearLocation: action,
    fold: { ...action, label: (pose) => pose },
    setNetwork: { ...action, label: (state) => state },
    setAirplaneMode: { ...action, label: (enabled) => (enabled ? 'on' : 'off') },
    setPermission: { ...action, label: (permission, state) => `${permission} ${state}` },
    setAppearance: { ...action, label: (mode) => mode },
    setOrientation: { ...action, label: (orientation) => orientation },
    alert: { ...action, label: (value) => value },
    setBiometrics: { ...action, label: (sensor, result) => `${sensor} ${result}` },
    enrollBiometrics: { ...action, label: (sensor, enrolled) => `${sensor} ${enrolled ? 'enrolled' : 'unenrolled'}` },
    drag: {
      ...action,
      label: (points) => `${String(points.length)} points`,
      timeout: (points) => context.timeouts.action + points.reduce((sum, point) => sum + (point.durationMs ?? DEFAULT_LEG_MS) + (point.holdMs ?? 0), 0),
    },
    pinch: { ...action, label: (scale) => `${String(scale)}x` },
    twoFingerTap: action,
    // The scroll runs to the list's end, however long that is; the host bounds it.
    collectList: { ...action, timeout: false },
    siri: { ...action, label: (command) => command },
    installedApps: action,
  });
  return context.expectable(fixture, () => context.fixture('expect', expectations, { toChangeScreen: { kind: 'assertion', timeout: false } }));
}
