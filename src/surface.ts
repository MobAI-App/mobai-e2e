/**
 * The MobAI surface: one device driven through the MobAI host's HTTP API,
 * exposed to the runner as the contract's observe/locate/perform members.
 * It owns the id space (one fresh generation per observation), the attempt
 * state (artifact directory, screenshot counter, recording), and every
 * translation between the contract's vocabulary and the host's routes. The
 * runner owns everything else.
 *
 * Every observation is reported under one root of a stable id (`ROOT_ID`)
 * wrapping the device's top-level elements; a `swipe` performed on that root
 * scrolls the whole screen.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ConfigurationError,
  EngineError,
  KEY_NAMES,
  parseKey,
  raceAbort,
  rejectUnknownKeys,
  resolveExpression,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type Momentum,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type ScrollDirection,
  type SelectOption,
  type SemanticNode,
  type VideoSegment,
  type ViewportPoint,
  type ViewportSize,
} from 'e2e/engine';
import { HostClient, type HostSnapshot, type Point, type Rect } from './client.ts';
import { cancelled, invalidState, message, notActionable, sanitizeFilename, unsupported } from './errors.ts';
import { ensureHost, resolveBaseUrl, resolveLocalApiToken } from './host.ts';
import { captureDeviceLogs, deviceLogOptions, type DeviceLogOptions, type LogCapture } from './logs.ts';
import { centreOf, isWithin, projectSnapshot, ROOT_ID, screenRoot, type ProjectedNode, type ProjectedSnapshot } from './nodes.ts';
import { DEFAULT_LONG_PRESS_MS, DEFAULT_SETTLE_MS, DEFAULT_TRANSITION_MS, MOBAI_OPTION_KEYS, type MobaiOptions } from './options.ts';
import { maskPng, readPngSize } from './png.ts';
import { DevicePool, type SlotBinding } from './pool.ts';
import { matchSelector } from './selector.ts';

/** Action data only: a located reference never retains the whole projection. */
interface NodeBinding {
  readonly id: string;
  readonly kind: string;
  readonly node: SemanticNode;
  /** The box to tap for this node: a toggle's inner control, else its own. */
  readonly controlRect: Rect | undefined;
  readonly scrollable: boolean;
  /** The nearest scrollable ancestor's box, for `scrollIntoView`. */
  readonly scrollContainer: Rect | undefined;
}

interface Attempt {
  readonly attemptId: string;
  readonly artifactsDir: string;
  screenshots: number;
  video: { readonly outBase: string; startedAt: string } | undefined;
}

const MAX_LOCATED_REFS = 2048;
const SWIPE_MS = 300;
const DRAG_PRESS_MS = 500;
const DRAG_MS = 500;
const WHEEL_KINDS: ReadonlySet<string> = new Set(['picker-wheel', 'picker', 'number-picker']);
/** Roles an option of an opened chooser can have. */
const OPTION_ROLES: ReadonlySet<string> = new Set(['listitem', 'menuitem', 'text', 'button', 'radio', 'checkbox']);
/**
 * How long a tap waits, past the transition budget, for a moving target to
 * stop. A list flung by a slow swipe coasts about 2s on iOS.
 */
const MAX_SETTLE_MS = 3_000;
const MAX_SCROLL_INTO_VIEW = 8;

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The finger gesture that scrolls one rect's content in `direction`. */
export function swipeWithin(rect: Rect, direction: ScrollDirection, momentum: Momentum | undefined): { from: Point; to: Point } {
  const ratio = momentum === 'fast' ? 0.8 : momentum === 'slow' ? 0.25 : 0.5;
  const centre = centreOf(rect);
  const dx = (rect.width * ratio) / 2;
  const dy = (rect.height * ratio) / 2;
  switch (direction) {
    case 'down':
      return { from: { x: centre.x, y: centre.y + dy }, to: { x: centre.x, y: centre.y - dy } };
    case 'up':
      return { from: { x: centre.x, y: centre.y - dy }, to: { x: centre.x, y: centre.y + dy } };
    case 'right':
      return { from: { x: centre.x + dx, y: centre.y }, to: { x: centre.x - dx, y: centre.y } };
    case 'left':
      return { from: { x: centre.x - dx, y: centre.y }, to: { x: centre.x + dx, y: centre.y } };
  }
}

/**
 * A screen scroll on iOS: two drags from the centre over 80% of the screen,
 * kept 50pt inside the edge. Each holds 50ms before lift so the content
 * stops instead of coasting.
 */
const SCROLL_SHARE = 0.8;
const SCROLL_EDGE_INSET = 50;
const SCROLL_DRAG_MS = 200;
const SCROLL_HOLD_MS = 50;
const SCROLL_DRAGS = 2;

/** One drag of the screen scroll: from the centre toward `direction`'s content, clamped inside the edges. */
export function screenScrollDrag(viewport: ViewportSize, direction: ScrollDirection): { from: Point; to: Point } {
  const from = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
  const dx = Math.round(viewport.width * SCROLL_SHARE);
  const dy = Math.round(viewport.height * SCROLL_SHARE);
  const clamp = (value: number, size: number) => Math.min(Math.max(value, SCROLL_EDGE_INSET), size - SCROLL_EDGE_INSET);
  // Scrolling down reveals what is below, so the finger travels up.
  const to = {
    down: { x: from.x, y: clamp(from.y - dy, viewport.height) },
    up: { x: from.x, y: clamp(from.y + dy, viewport.height) },
    right: { x: clamp(from.x - dx, viewport.width), y: from.y },
    left: { x: clamp(from.x + dx, viewport.width), y: from.y },
  }[direction];
  return { from, to };
}

function transitionMs(transition: MobaiOptions['transition']): number {
  const budget = transition ?? DEFAULT_TRANSITION_MS;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobai: `transition` must be a non-negative integer of milliseconds');
  }
  return budget;
}

function settleMs(settle: MobaiOptions['settle']): number {
  if (settle === false) return 0;
  const quiet = settle ?? DEFAULT_SETTLE_MS;
  if (!Number.isInteger(quiet) || quiet < 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobai: `settle` must be a non-negative integer of milliseconds, or false');
  }
  return quiet;
}

function checkLaunchEnvironment(environment: MobaiOptions['launchEnvironment'], platform: MobaiOptions['platform']): void {
  if (environment === undefined) return;
  if (platform === 'android') {
    throw new ConfigurationError('INVALID_CONFIG', 'mobai: `launchEnvironment` is iOS only; Android has no per-process environment, pass intent extras with app.launchArguments');
  }
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment) || Object.values(environment).some((value) => typeof value !== 'string')) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobai: `launchEnvironment` must map variable names to strings');
  }
}

function tellHarness(call: () => void): void {
  try {
    call();
  } catch {
    // The trace is a reader of the attempt, never a reason it fails.
  }
}

export class MobaiSurface {
  readonly pool: DevicePool;
  private client: HostClient | undefined;
  private binding: SlotBinding | undefined;
  private attempt: Attempt | undefined;
  private screenSink: ((snapshot: EngineSnapshot) => void) | undefined;
  private generation = new Map<string, NodeBinding>();
  private readonly located = new Map<string, NodeBinding>();
  private idCounter = 0;
  private app: EngineAppInfo = {};
  private projectRoot = process.cwd();
  /** The app `appPath` installed through `installApp`, so `app.open()` can launch it. */
  private installedApp: string | undefined;
  private readonly transitionMs: number;
  private readonly settleMs: number;
  private lastActionAt = 0;
  private indexBeforeAction: readonly ProjectedNode[] | undefined;
  private latestIndex: readonly ProjectedNode[] | undefined;
  private knownViewport: ViewportSize | undefined;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly logOptions: DeviceLogOptions | undefined;
  private logs: LogCapture | undefined;

  constructor(readonly options: MobaiOptions) {
    rejectUnknownKeys('mobai()', options, MOBAI_OPTION_KEYS);
    if (options.platform !== 'ios' && options.platform !== 'android') {
      throw new ConfigurationError('INVALID_CONFIG', "mobai: `platform` must be 'ios' or 'android'");
    }
    this.logOptions = deviceLogOptions(options.deviceLogs);
    if (this.logOptions !== undefined) {
      rejectUnknownKeys('mobai({ deviceLogs })', this.logOptions, ['level', 'process']);
      const level = this.logOptions.level;
      if (level !== undefined && level !== 'error' && level !== 'warning' && level !== 'info') {
        throw new ConfigurationError('INVALID_CONFIG', `mobai: \`deviceLogs.level\` must be 'error', 'warning' or 'info', got ${JSON.stringify(level)}`);
      }
    }
    checkLaunchEnvironment(options.launchEnvironment, options.platform);
    this.transitionMs = transitionMs(options.transition);
    this.settleMs = settleMs(options.settle);
    this.pool = new DevicePool(options, () => this.hostClient(process.env));
  }

  get platform(): 'ios' | 'android' {
    return this.options.platform;
  }

  /** The client for the host the run's environment names; made once per surface. */
  hostClient(env: Readonly<Record<string, string | undefined>>): HostClient {
    this.client ??= new HostClient(resolveBaseUrl(this.options, env), resolveLocalApiToken(this.options, env));
    return this.client;
  }

  /** The device this worker drives; INVALID_STATE before init. */
  deviceId(): string {
    if (this.binding === undefined) throw invalidState('the mobai engine is not initialized');
    return this.binding.id;
  }

  /** The device label for messages and the report. */
  get deviceLabel(): string | undefined {
    return this.binding?.name;
  }

  /** The app `app.open()` launches: the target's `bundleId`, else the app its build installed. */
  get pinnedApp(): string | undefined {
    return this.app.bundleId ?? this.installedApp;
  }

  get appPath(): string | undefined {
    return this.app.appPath;
  }

  private requireClient(): HostClient {
    if (this.client === undefined) throw invalidState('the mobai engine is not initialized');
    return this.client;
  }

  /** Runs one host command, tracked until it settles. */
  async command<T>(label: string, run: (client: HostClient, device: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = this.requireClient();
    const device = this.deviceId();
    const pending = run(client, device);
    this.track(pending);
    try {
      return await pending;
    } catch (cause) {
      if (signal?.aborted) throw cancelled(`${label} cancelled`);
      throw cause;
    }
  }

  /** A fixture command that changes the screen: recorded as an action, so controls that arrive with it wait out the transition. */
  async screenCommand<T>(label: string, run: (client: HostClient, device: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const before = this.latestIndex;
    const result = await this.command(label, run, signal);
    this.markAction(before);
    return result;
  }

  private track<T>(pending: Promise<T>): void {
    this.inflight.add(pending);
    pending.then(
      () => this.inflight.delete(pending),
      () => this.inflight.delete(pending),
    );
  }

  private async settleInflight(signal: AbortSignal): Promise<void> {
    while (this.inflight.size > 0) {
      await raceAbort(Promise.allSettled(this.inflight), signal, 'settling in-flight device commands');
    }
  }

  // --- lifecycle ---

  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    const client = this.hostClient(info.env);
    await ensureHost(client, this.options, info.env, info.log, info.signal);
    return this.pool.prepare(info);
  }

  async finish(info: EngineFinishInfo): Promise<void> {
    // Farm sessions bill by the minute: end them first. The host also ends
    // them when idle or on its way out, in case this never runs.
    if (this.pool.usesCloud) {
      try {
        await this.hostClient(info.env).cloudEnd(info.runId, info.signal);
      } catch (cause) {
        info.log(`could not end the farm sessions (${message(cause)}); the host ends them after 10 idle minutes`);
      }
    }
    // Leases exist only on a host that requires device claims; releasing one
    // never touches the bridge, so a hold the reporter asks for still works.
    try {
      await this.pool.release(this.hostClient(info.env), info.targetName, info.signal);
    } catch (cause) {
      info.log(`could not release the device claim (${message(cause)}); the host drops it after its idle timeout`);
    }
    // Nothing published. A failed test's device is held by the reporter, the
    // only part that sees the outcome.
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.app = info.app;
    this.hostClient(info.env);
    this.binding = this.pool.binding(info.targetName, info.workerSlot, info.env);
    if (this.binding.lease !== undefined) this.requireClient().lease(this.binding.id, this.binding.lease);
    info.log(`driving ${this.binding.name} (${this.binding.id}) through ${this.requireClient().baseUrl}`);
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running on this mobai engine');
    await this.settleInflight(context.signal);
    this.attempt = { attemptId: context.attemptId, artifactsDir: context.artifactsDir, screenshots: 0, video: undefined };
    this.generation = new Map();
    this.located.clear();
    this.screenSink = context.screen;
    if (this.logOptions !== undefined) {
      this.logs = captureDeviceLogs(this.requireClient(), this.deviceId(), this.platform, this.logOptions, context.appLog);
    }
    const binding = this.binding;
    tellHarness(() =>
      context.environment({
        platform: this.platform,
        ...(binding === undefined ? {} : { device: binding.name, deviceId: binding.id }),
        ...(binding?.os === undefined ? {} : { os: binding.os }),
        ...(binding?.model === undefined ? {} : { model: binding.model }),
        ...(binding?.virtual === undefined ? {} : { virtual: binding.virtual ? 'true' : 'false' }),
      }),
    );
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    await this.stopLogs();
    const attempt = this.attempt;
    this.attempt = undefined;
    this.screenSink = undefined;
    this.generation = new Map();
    this.located.clear();
    if (attempt?.video !== undefined) {
      await this.command('stop recording', (client, device) => client.stopRecording(device, context.signal), context.signal).catch(() => undefined);
    }
  }

  async dispose(_context: EngineCleanupContext): Promise<void> {
    await this.stopLogs();
    this.attempt = undefined;
    this.generation = new Map();
    this.located.clear();
    this.installedApp = undefined;
    this.knownViewport = undefined;
    this.binding = undefined;
  }

  private async stopLogs(): Promise<void> {
    const logs = this.logs;
    this.logs = undefined;
    await logs?.stop();
  }

  // --- observation ---

  private async snapshot(signal: AbortSignal | undefined): Promise<HostSnapshot> {
    return this.command('snapshot', (client, device) => client.snapshot(device, { includeKeyboard: this.options.keyboardNodes === true }, signal), signal);
  }

  /** The host's tree of the screen as it is now, for fixture methods that read it themselves. */
  async hostSnapshot(signal: AbortSignal): Promise<HostSnapshot> {
    const raw = await this.snapshot(signal);
    if (raw.viewport.width > 0 && raw.viewport.height > 0) this.knownViewport = raw.viewport;
    return raw;
  }

  /** The screen's size in points: the last one seen, else read now. */
  async viewport(signal: AbortSignal): Promise<ViewportSize> {
    if (this.knownViewport !== undefined) return this.knownViewport;
    const raw = await this.hostSnapshot(signal);
    if (raw.viewport.width > 0 && raw.viewport.height > 0) return raw.viewport;
    throw new EngineError('ENGINE_FAILURE', 'the device reported no screen geometry, so the viewport is unknown', { retryable: false });
  }

  private project(raw: HostSnapshot): ProjectedSnapshot {
    const projected = projectSnapshot(raw, {
      mintId: () => {
        this.idCounter += 1;
        return `n${this.idCounter}`;
      },
    });
    this.latestIndex = projected.index;
    if (projected.viewport.width > 0 && projected.viewport.height > 0) this.knownViewport = projected.viewport;
    return projected;
  }

  private viewportFor(projected: ProjectedSnapshot): ViewportSize {
    if (projected.viewport.width > 0 && projected.viewport.height > 0) return projected.viewport;
    if (this.knownViewport !== undefined) return this.knownViewport;
    throw new EngineError('ENGINE_FAILURE', 'the device reported no screen geometry, so the viewport is unknown', { retryable: false });
  }

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const raw = await this.snapshot(operation.signal);
    const projected = this.project(raw);
    this.generation = new Map(projected.index.map((entry) => [entry.id, this.bind(entry, projected.index)]));
    const viewport = this.viewportFor(projected);
    const capture = options?.pixels === true ? await this.capturePixels(operation.signal, projected, viewport) : undefined;
    return {
      root: screenRoot(projected.roots, viewport),
      viewport,
      ...(projected.location === undefined ? {} : { location: projected.location }),
      ...(capture === undefined ? {} : { pixels: capture.pixels, maskedRegionCount: capture.masked }),
    };
  }

  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const raw = await this.snapshot(operation.signal);
    const projected = this.project(raw);
    this.traceScreen(projected);
    const byId = new Map(projected.index.map((entry) => [entry.id, entry]));
    const matches = resolveExpression(expression, projected.roots, {
      selector: (selector) => matchSelector(selector, projected.index).map((entry) => entry.node),
    });
    for (const node of matches) {
      const entry = byId.get(node.ref.id);
      if (entry !== undefined) this.located.set(entry.id, this.bind(entry, projected.index));
    }
    for (const oldest of this.located.keys()) {
      if (this.located.size <= MAX_LOCATED_REFS) break;
      this.located.delete(oldest);
    }
    return matches;
  }

  private traceScreen(projected: ProjectedSnapshot): void {
    const sink = this.screenSink;
    if (sink === undefined) return;
    let viewport: ViewportSize;
    try {
      viewport = this.viewportFor(projected);
    } catch {
      return;
    }
    tellHarness(() =>
      sink({
        root: screenRoot(projected.roots, viewport),
        viewport,
        ...(projected.location === undefined ? {} : { location: projected.location }),
      }),
    );
  }

  private resolveRef(ref: NodeRef): NodeBinding {
    const entry = this.located.get(ref.id) ?? this.generation.get(ref.id);
    if (entry === undefined) {
      throw new EngineError('NODE_STALE', `node ${ref.id} is not part of the newest observation`, { retryable: true });
    }
    return entry;
  }

  /**
   * The node a toggle press must land on: UIKit reports a settings row as a
   * labelled Switch spanning the row with the real control as a child at its
   * trailing edge. The innermost same-role descendant is the control.
   */
  private controlOf(entry: ProjectedNode, snapshot: readonly ProjectedNode[]): ProjectedNode {
    const role = entry.node.role;
    if (role !== 'switch' && role !== 'checkbox') return entry;
    let control = entry;
    let depth = -1;
    for (const candidate of snapshot) {
      if (candidate.node.role !== role || candidate.node.rect === undefined || !isWithin(candidate, entry)) continue;
      let hops = 0;
      for (let current = candidate.parent; current !== undefined && current !== entry; current = current.parent) hops += 1;
      if (hops > depth) {
        control = candidate;
        depth = hops;
      }
    }
    return control;
  }

  private bind(entry: ProjectedNode, snapshot: readonly ProjectedNode[]): NodeBinding {
    const { children: _children, ...node } = entry.node;
    const control = this.controlOf(entry, snapshot);
    let container: Rect | undefined;
    for (let current = entry.parent; current !== undefined; current = current.parent) {
      if (current.raw.scrollable === true && current.node.rect !== undefined) {
        container = current.node.rect;
        break;
      }
    }
    return {
      id: entry.id,
      kind: entry.kind,
      node,
      controlRect: control.node.rect,
      scrollable: entry.raw.scrollable === true,
      scrollContainer: container,
    };
  }

  /** The node a binding stands for, in a fresh snapshot: same role, test id, name and text, nearest to where it was. */
  private refind(entry: NodeBinding, index: readonly ProjectedNode[]): ProjectedNode | undefined {
    const candidates = index.filter(
      (candidate) =>
        candidate.node.role === entry.node.role &&
        candidate.node.testId === entry.node.testId &&
        candidate.node.name === entry.node.name &&
        candidate.node.text === entry.node.text,
    );
    if (candidates.length <= 1 || entry.node.rect === undefined) return candidates[0];
    const was = centreOf(entry.node.rect);
    let best = candidates[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate.node.rect === undefined) continue;
      const at = centreOf(candidate.node.rect);
      const distance = Math.hypot(at.x - was.x, at.y - was.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Lets a control that came with the last action finish arriving before a
   * test acts on it: a control already at the same place before the action
   * is acted on at once; anything else waits out the transition budget and
   * is found again in a fresh snapshot. If it is still moving then (a list
   * coasting after a swipe), it is read again until two reads agree, so the
   * tap does not land on a moving list, which iOS takes as "stop scrolling".
   */
  private async settled(entry: NodeBinding, operation: OperationContext): Promise<NodeBinding> {
    const since = Date.now() - this.lastActionAt;
    if (since >= this.transitionMs + MAX_SETTLE_MS) return entry;
    const before = this.indexBeforeAction;
    if (before !== undefined) {
      const prior = this.refind(entry, before);
      if (prior !== undefined && sameRect(prior.node.rect, entry.node.rect)) return entry;
    }
    const remaining = this.transitionMs - since;
    if (remaining > 0) {
      await sleep(remaining, operation.signal);
      if (operation.signal.aborted) throw cancelled('transition wait cancelled');
    }
    let previous = entry;
    let current = await this.relocated(entry, operation);
    const stopBy = Date.now() + MAX_SETTLE_MS;
    while (!sameRect(previous.node.rect, current.node.rect) && Date.now() < stopBy) {
      previous = current;
      current = await this.relocated(current, operation);
    }
    return current;
  }

  private async relocated(entry: NodeBinding, operation: OperationContext): Promise<NodeBinding> {
    const projected = this.project(await this.snapshot(operation.signal));
    const found = this.refind(entry, projected.index);
    return found === undefined ? entry : this.bind(found, projected.index);
  }

  private markAction(before: readonly ProjectedNode[] | undefined): void {
    this.indexBeforeAction = before;
    this.lastActionAt = Date.now();
  }

  /** After an agent-originated action: the quiet window before the agent reads the screen. */
  private async settleAfter(operation: OperationContext): Promise<void> {
    if (operation.origin !== 'agent' || this.settleMs === 0) return;
    await sleep(this.settleMs, operation.signal);
  }

  /** Forgets the screen after a launch or a close: nothing on it survives. */
  screenReplaced(): void {
    this.markAction(undefined);
    this.generation = new Map();
    this.located.clear();
  }

  private tapPoint(entry: NodeBinding, control = false): Point {
    const rect = control ? (entry.controlRect ?? entry.node.rect) : entry.node.rect;
    if (rect === undefined) throw notActionable(`node ${entry.id} has no bounds to tap`);
    return centreOf(rect);
  }

  // --- actions ---

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    const deterministic = operation.origin === 'test';
    if (ref.id === ROOT_ID) {
      if (action.kind !== 'swipe') throw notActionable(`the screen root takes swipe only, not ${action.kind}; act on a node`);
      const viewport = this.knownViewport;
      if (viewport === undefined) throw invalidState('no observation yet: observe before swiping the screen');
      const before = this.latestIndex;
      if (this.platform === 'ios') {
        // The screen scrolls and stops (screen.swipe, scrollUntilVisible, the
        // agent's scroll); momentum is not applied, as no coast is the point.
        // A node swipe stays a fling, which pagers need.
        const { from, to } = screenScrollDrag(viewport, action.direction);
        await this.command('swipe', async (client, device) => {
          for (let i = 0; i < SCROLL_DRAGS; i += 1) {
            await client.drag(device, from, to, { durationMs: SCROLL_DRAG_MS, pressMs: 0, holdMs: SCROLL_HOLD_MS }, operation.signal);
          }
        }, operation.signal);
      } else {
        const gesture = swipeWithin({ x: 0, y: 0, width: viewport.width, height: viewport.height }, action.direction, action.momentum ?? 'slow');
        await this.command('swipe', (client, device) => client.swipe(device, gesture.from, gesture.to, SWIPE_MS, operation.signal), operation.signal);
      }
      this.markAction(before);
      await this.settleAfter(operation);
      return;
    }
    const entry = this.resolveRef(ref);
    if ((action.kind === 'check' || action.kind === 'uncheck') && entry.node.states?.checked === (action.kind === 'check')) return;
    const before = this.latestIndex;
    const target = deterministic ? await this.settled(entry, operation) : entry;
    const { signal } = operation;
    await this.command(`perform ${action.kind}`, async (client, device) => {
      switch (action.kind) {
        case 'tap':
          return client.tap(device, this.tapPoint(target, true), signal);
        case 'doubleTap':
          return client.doubleTap(device, this.tapPoint(target), signal);
        case 'longPress':
          return client.longPress(device, this.tapPoint(target), action.durationMs ?? DEFAULT_LONG_PRESS_MS, signal);
        case 'focus':
          if (target.node.role !== 'textbox') {
            throw unsupported(`a touch surface focuses editable fields only; node ${target.id} is ${target.node.role ?? 'unknown'}`);
          }
          return client.tap(device, this.tapPoint(target), signal);
        case 'fill': {
          if (target.node.states?.focused !== true) await client.tap(device, this.tapPoint(target), signal);
          await client.clearText(device, signal);
          if (action.value !== '') await client.type(device, action.value, signal);
          return;
        }
        case 'clear': {
          if (target.node.states?.focused !== true) await client.tap(device, this.tapPoint(target), signal);
          return client.clearText(device, signal);
        }
        case 'check':
        case 'uncheck': {
          const checked = target.node.states?.checked;
          if (checked === undefined) throw unsupported(`the tree does not say whether node ${target.id} is checked; tap it instead`);
          if (checked === (action.kind === 'check')) return;
          return client.tap(device, this.tapPoint(target, true), signal);
        }
        case 'press':
          return this.pressKeyOn(client, device, target, action.key, signal);
        case 'swipe': {
          const rect = target.node.rect;
          if (rect === undefined) throw notActionable(`node ${target.id} has no bounds to swipe within`);
          const gesture = swipeWithin(rect, action.direction, action.momentum);
          return client.swipe(device, gesture.from, gesture.to, SWIPE_MS, signal);
        }
        case 'dragTo': {
          const destination = this.resolveRef(action.target);
          return client.drag(device, this.tapPoint(target), this.tapPoint(destination), { pressMs: DRAG_PRESS_MS, durationMs: DRAG_MS }, signal);
        }
        case 'scrollIntoView':
          return this.scrollIntoView(target, operation);
        case 'selectOption':
          return this.selectOption(target, action.value, operation);
        case 'hover':
        case 'secondaryTap':
        case 'setInputFiles':
          throw unsupported(`a touch surface cannot perform "${action.kind}"`);
      }
    }, signal);
    this.markAction(before);
    await this.settleAfter(operation);
  }

  /**
   * Brings a partly visible node fully into the viewport by swiping inside
   * its nearest scrollable ancestor (else the screen) toward it, one step at
   * a time, re-finding it after each swipe.
   */
  private async scrollIntoView(entry: NodeBinding, operation: OperationContext): Promise<void> {
    const viewport = this.knownViewport;
    if (viewport === undefined) throw invalidState('no observation yet');
    let current = entry;
    for (let step = 0; step < MAX_SCROLL_INTO_VIEW; step += 1) {
      const rect = current.node.rect;
      if (rect === undefined) throw notActionable(`node ${current.id} has no bounds to scroll into view`);
      const container = current.scrollContainer ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
      const direction = outOfView(rect, container);
      if (direction === undefined) return;
      const gesture = swipeWithin(container, direction, 'slow');
      await this.requireClient().swipe(this.deviceId(), gesture.from, gesture.to, SWIPE_MS, operation.signal);
      await sleep(this.settleMs, operation.signal);
      const { index } = this.project(await this.snapshot(operation.signal));
      const found = this.refind(current, index);
      if (found === undefined) throw new EngineError('NODE_STALE', `node ${current.id} left the screen while scrolling it into view`, { retryable: true });
      current = this.bind(found, index);
    }
    throw notActionable(`node ${entry.id} did not come fully into view after ${MAX_SCROLL_INTO_VIEW} scrolls`);
  }

  /**
   * Picks an option of a native chooser: taps the control, then taps the
   * option whose label, value, or position matches in the screen that opens
   * (an Android Spinner's list, a menu, an action sheet). A wheel (an iOS
   * picker wheel, an Android NumberPicker) has no tappable options: the
   * device turns it to the row whose text matches, so a wheel takes a label
   * or value, not an index.
   */
  private async selectOption(entry: NodeBinding, option: SelectOption, operation: OperationContext): Promise<void> {
    const client = this.requireClient();
    const device = this.deviceId();
    const wanted: { label?: string; value?: string; index?: number } = typeof option === 'string' ? { label: option } : option;
    if (WHEEL_KINDS.has(entry.kind)) {
      const text = wanted.label ?? wanted.value;
      if (text === undefined) throw unsupported(`a wheel takes the row's text; node ${entry.id} cannot be turned to index ${wanted.index}`);
      try {
        await client.selectWheel(device, this.tapPoint(entry), text, operation.signal);
      } catch (cause) {
        if (cause instanceof EngineError && cause.code === 'ENGINE_FAILURE') throw notActionable(`node ${entry.id}: ${cause.message}`);
        throw cause;
      }
      return;
    }
    await client.tap(device, this.tapPoint(entry), operation.signal);
    await sleep(Math.max(this.transitionMs, this.settleMs), operation.signal);
    const projected = this.project(await this.snapshot(operation.signal));
    const candidates = projected.index.filter((node) => node.node.rect !== undefined && node.node.role !== undefined && OPTION_ROLES.has(node.node.role));
    let chosen: ProjectedNode | undefined;
    if (wanted.index !== undefined) {
      chosen = candidates[wanted.index];
    } else {
      const text = wanted.label ?? wanted.value;
      chosen = candidates.find((node) => node.node.name === text || node.node.text === text || node.node.value === text);
    }
    if (chosen?.node.rect === undefined) {
      throw notActionable(`no option ${JSON.stringify(wanted)} is on screen after tapping node ${entry.id}`);
    }
    await client.tap(device, centreOf(chosen.node.rect), operation.signal);
  }

  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    const before = this.latestIndex;
    const { signal } = operation;
    await this.command(`${action.kind} at point`, (client, device) => {
      switch (action.kind) {
        case 'tap':
          return client.tap(device, point, signal);
        case 'doubleTap':
          return client.doubleTap(device, point, signal);
        case 'longPress':
          return client.longPress(device, point, action.durationMs ?? DEFAULT_LONG_PRESS_MS, signal);
        case 'swipeTo':
          return client.swipe(device, point, action.target, action.durationMs ?? SWIPE_MS, signal);
        case 'dragTo':
          return client.drag(device, point, action.target, { pressMs: DRAG_PRESS_MS, durationMs: DRAG_MS }, signal);
        case 'swipe': {
          const viewport = this.knownViewport;
          if (viewport === undefined) throw invalidState('no observation yet: observe before swiping at a point');
          const ratio = action.momentum === 'fast' ? 0.6 : action.momentum === 'slow' ? 0.15 : 0.3;
          const dx = viewport.width * ratio;
          const dy = viewport.height * ratio;
          const to = {
            down: { x: point.x, y: point.y - dy },
            up: { x: point.x, y: point.y + dy },
            right: { x: point.x - dx, y: point.y },
            left: { x: point.x + dx, y: point.y },
          }[action.direction];
          return client.swipe(device, point, to, SWIPE_MS, signal);
        }
        case 'hover':
        case 'secondaryTap':
          throw unsupported(`a touch surface cannot perform "${action.kind}" at a point`);
      }
    }, signal);
    this.markAction(before);
    await this.settleAfter(operation);
  }

  // --- keyboard ---

  /** A key the device can deliver: Enter submits, Backspace deletes, the rest are typed or refused. */
  private async pressKeyOn(client: HostClient, device: string, entry: NodeBinding | undefined, key: string, signal: AbortSignal): Promise<void> {
    const parsed = parseKey(key);
    if (parsed === undefined) {
      throw unsupported(`"${key}" is not a key: press takes one key in the form [Modifier+]...Key, a named key (${KEY_NAMES.join(', ')}) or one character`);
    }
    if (parsed.modifiers.length > 0) throw unsupported(`a device cannot hold ${parsed.modifiers.join('+')}; press the key alone`);
    const focusFirst = async (): Promise<void> => {
      if (entry !== undefined && entry.node.role === 'textbox' && entry.node.states?.focused !== true) {
        await client.tap(device, this.tapPoint(entry), signal);
      }
    };
    if (parsed.key.kind === 'char' || parsed.key.name === 'Space') {
      await focusFirst();
      await client.type(device, parsed.key.kind === 'char' ? parsed.key.char : ' ', signal);
      return;
    }
    const name = parsed.key.name;
    if (name === 'Enter') {
      await focusFirst();
      if (this.platform === 'android') await client.pressKey(device, 'enter', signal);
      else await client.type(device, '\n', signal);
      return;
    }
    if (this.platform === 'android') {
      const android: Partial<Record<string, string>> = { Backspace: 'delete', Delete: 'delete', Tab: 'tab', Escape: 'escape' };
      const code = android[name];
      if (code !== undefined) {
        await focusFirst();
        await client.pressKey(device, code, signal);
        return;
      }
    }
    if (name === 'Backspace') {
      await focusFirst();
      await client.type(device, '\b', signal);
      return;
    }
    throw unsupported(`a device cannot press ${name}; Enter, Backspace, Space, and single characters reach the keyboard${this.platform === 'android' ? ', and Android also takes Tab, Delete, and Escape' : ''}`);
  }

  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    const before = this.latestIndex;
    await this.command('keyboard.type', async (client, device) => {
      if (options.replace) await client.clearText(device, operation.signal);
      if (text !== '') await client.type(device, text, operation.signal);
    }, operation.signal);
    this.markAction(before);
    await this.settleAfter(operation);
  }

  async pressFocusedKey(key: string, operation: OperationContext): Promise<void> {
    const before = this.latestIndex;
    await this.command('keyboard.press', (client, device) => this.pressKeyOn(client, device, undefined, key, operation.signal), operation.signal);
    this.markAction(before);
    await this.settleAfter(operation);
  }

  async dismissKeyboard(signal: AbortSignal): Promise<void> {
    await this.screenCommand('keyboard.dismiss', (client, device) => client.dismissKeyboard(device, signal), signal);
  }

  // --- session ---

  /**
   * Back: the hardware key on Android. iOS has none, so the navigation bar's
   * leading button is tapped when one is listed, else the interactive pop
   * gesture (a drag from the left edge) is sent.
   */
  async back(operation: OperationContext): Promise<void> {
    const before = this.latestIndex;
    await this.command('back', async (client, device) => {
      if (this.platform === 'android') return client.pressKey(device, 'back', operation.signal);
      const projected = this.project(await this.snapshot(operation.signal));
      const viewport = this.viewportFor(projected);
      const bar = projected.index.find((entry) => entry.kind === 'navigation-bar');
      const leading =
        bar === undefined
          ? undefined
          : projected.index.find(
              (entry) => entry.node.role === 'button' && entry.node.rect !== undefined && isWithin(entry, bar) && entry.node.rect.x < viewport.width * 0.3,
            );
      if (leading?.node.rect !== undefined) return client.tap(device, centreOf(leading.node.rect), operation.signal);
      return client.swipe(device, { x: 2, y: viewport.height / 2 }, { x: viewport.width * 0.7, y: viewport.height / 2 }, 400, operation.signal);
    }, operation.signal);
    this.markAction(before);
    await this.settleAfter(operation);
  }

  async restart(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported("launching the app needs the target's `app.bundleId`, or the build `app.appPath` names installed first with `device.installApp()`");
    await this.openApp(app, { relaunch: true }, operation.signal);
  }

  /** Clears the pinned app's persisted state and relaunches it. */
  async reset(operation: OperationContext): Promise<void> {
    const app = this.pinnedApp;
    if (app === undefined) throw unsupported("app.clearState needs the target's `app.bundleId`, or the build `app.appPath` names installed first");
    await this.clearAppState(app, operation.signal);
    await this.openApp(app, { relaunch: true }, operation.signal);
  }

  /**
   * Wipes an app's data. Android clears the package in place. iOS has no
   * per-app wipe, so the build is reinstalled when the target names one;
   * without a build there is nothing to reinstall from.
   */
  async clearAppState(app: string, signal: AbortSignal): Promise<void> {
    if (this.platform === 'android') {
      await this.command('clear app state', (client, device) => client.clearAppState(device, app, signal), signal);
      this.screenReplaced();
      return;
    }
    const build = this.app.appPath;
    if (build === undefined) {
      throw unsupported('iOS cannot clear one app\'s data in place; name the build with the target\'s `app.appPath` so the engine can reinstall it, or uninstall and install it in the test');
    }
    await this.command('clear app state', async (client, device) => {
      await client.uninstallApp(device, app, signal).catch(() => undefined);
      await client.installApp(device, path.resolve(this.projectRoot, build), signal);
    }, signal);
    this.screenReplaced();
  }

  async openApp(
    app: string,
    options: { relaunch?: boolean; launchArguments?: readonly string[] | undefined; launchEnvironment?: Readonly<Record<string, string>> | undefined },
    signal: AbortSignal,
  ): Promise<void> {
    const relaunch = options.relaunch === true;
    const pinned = relaunch && app === this.pinnedApp;
    const launchArguments = options.launchArguments ?? (pinned ? this.app.launchArguments : undefined);
    const launchEnvironment = options.launchEnvironment ?? (pinned ? this.options.launchEnvironment : undefined);
    if (launchEnvironment !== undefined && this.platform === 'android') {
      throw unsupported('Android has no per-process environment; pass intent extras with launchArguments, e.g. ["--es", "KEY", "value"]');
    }
    await this.command(`open ${app}`, async (client, device) => {
      if (relaunch) await client.killApp(device, app, signal).catch(() => undefined);
      // The test's next step waits for the app's screen, so the launch need not.
      await client.launchApp(
        device,
        app,
        { ...(launchArguments === undefined ? {} : { arguments: launchArguments }), ...(launchEnvironment === undefined ? {} : { environment: launchEnvironment }), noWait: true },
        signal,
      );
    }, signal);
    this.screenReplaced();
  }

  async closeApp(app: string | undefined, signal: AbortSignal): Promise<void> {
    const target = app ?? this.pinnedApp;
    if (target === undefined) throw invalidState('closeApp needs an app: pass one, or pin one with the target\'s app.bundleId');
    await this.command(`close ${target}`, (client, device) => client.killApp(device, target, signal), signal);
    this.screenReplaced();
  }

  async installApp(appPath: string | undefined, options: { app?: string | undefined; reinstall?: boolean | undefined }, signal: AbortSignal): Promise<{ app: string; bundleId?: string }> {
    const build = appPath ?? this.app.appPath;
    if (build === undefined) throw invalidState("installApp needs a build: pass a path, or name one with the target's app.appPath");
    const resolved = path.resolve(this.projectRoot, build);
    const engineBuild = appPath === undefined || (this.app.appPath !== undefined && resolved === path.resolve(this.projectRoot, this.app.appPath));
    const app = options.app ?? (engineBuild ? this.app.bundleId : undefined);
    if (options.reinstall === true && app === undefined) {
      throw invalidState("reinstall needs an app: pass `app`, or pin one with the target's app.bundleId");
    }
    const result = await this.command(`install ${resolved}`, async (client, device) => {
      if (options.reinstall === true && app !== undefined) await client.uninstallApp(device, app, signal).catch(() => undefined);
      return client.installApp(device, resolved, signal);
    }, signal);
    const identity = result?.bundleId ?? app;
    if (identity === undefined) {
      throw new EngineError('ENGINE_FAILURE', `installed ${resolved}, but MobAI reported no bundle id for it; name the app with the target's \`app.bundleId\` or installApp's \`app\` option`, {
        retryable: false,
      });
    }
    if (engineBuild) this.installedApp = identity;
    return { app: identity, ...(result?.bundleId === undefined ? {} : { bundleId: result.bundleId }) };
  }

  async openLink(url: string, signal: AbortSignal): Promise<void> {
    await this.command('open link', (client, device) => client.openUrl(device, url, signal), signal);
    this.screenReplaced();
  }

  // --- artifacts ---

  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    const projected = this.project(await this.snapshot(operation.signal));
    const shot = await this.command('screenshot', (client, device) => client.screenshot(device, operation.signal), operation.signal);
    const masked = redactSecure(shot.data, shot.format, projected, projected.viewport.width > 0 ? projected.viewport : this.knownViewport);
    if (masked === undefined) {
      throw new EngineError('ENGINE_FAILURE', 'a secure field on screen could not be masked; screenshot withheld', { retryable: false });
    }
    attempt.screenshots += 1;
    const extension = shot.format === 'jpeg' ? 'jpg' : 'png';
    const name = `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.${extension}`;
    const relative = path.join('screenshots', name);
    mkdirSync(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    writeFileSync(path.join(attempt.artifactsDir, relative), masked.data);
    return relative;
  }

  private async capturePixels(signal: AbortSignal, projected: ProjectedSnapshot, viewport: ViewportSize): Promise<{ pixels: ObservationPixels; masked: number } | undefined> {
    let shot: { data: Uint8Array; format: 'png' | 'jpeg' };
    try {
      shot = await this.command('screenshot', (client, device) => client.screenshot(device, signal), signal);
    } catch {
      return undefined;
    }
    if (shot.format !== 'png') return undefined;
    const redacted = redactSecure(shot.data, shot.format, projected, viewport);
    if (redacted === undefined) return undefined;
    const size = readPngSize(redacted.data);
    if (size === undefined) return undefined;
    const scale = viewport.width > 0 ? size.width / viewport.width : 1;
    return { pixels: { data: redacted.data, mediaType: 'image/png', width: size.width, height: size.height, scale }, masked: redacted.masked };
  }

  async startVideo(operation: OperationContext): Promise<void> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('startVideo outside an attempt');
    if (attempt.video !== undefined) throw invalidState('a video is already recording');
    const outBase = path.join(attempt.artifactsDir, 'video', 'video');
    mkdirSync(path.dirname(outBase), { recursive: true });
    attempt.video = { outBase, startedAt: new Date().toISOString() };
    try {
      await this.command('start recording', (client, device) => client.startRecording(device, outBase, operation.signal), operation.signal);
    } catch (cause) {
      attempt.video = undefined;
      // A device with no recorder costs the attempt its video, never the step.
      if (cause instanceof EngineError && cause.code === 'UNSUPPORTED_CAPABILITY') return;
      throw cause;
    }
    attempt.video.startedAt = new Date().toISOString();
  }

  async stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('stopVideo outside an attempt');
    const video = attempt.video;
    if (video === undefined) return [];
    const result = await this.command('stop recording', (client, device) => client.stopRecording(device, operation.signal), operation.signal);
    attempt.video = undefined;
    const segments: VideoSegment[] = [];
    // mp4 from simulators and Android; MJPEG from a physical iPhone, which the
    // MobAI dashboard plays as well.
    const parts = result.parts.filter((part) => (part.format === 'mp4' || part.format === 'mjpeg') && existsSync(part.path));
    parts.forEach((part, position) => {
      const name = parts.length === 1 ? 'video' : `video-${String(position + 1)}`;
      const relative = path.join('video', `${name}.${part.format}`);
      const absolute = path.join(attempt.artifactsDir, relative);
      if (part.path !== absolute) renameSync(part.path, absolute);
      segments.push({ path: relative, startedAt: video.startedAt });
    });
    return segments;
  }
}

/** Which way a rect must scroll to sit inside `container`; undefined when it already does. */
function outOfView(rect: Rect, container: Rect): ScrollDirection | undefined {
  if (rect.y + rect.height > container.y + container.height + 1) return 'down';
  if (rect.y < container.y - 1) return 'up';
  if (rect.x + rect.width > container.x + container.width + 1) return 'right';
  if (rect.x < container.x - 1) return 'left';
  return undefined;
}

/**
 * Paints every secure node's bounds black on a screenshot of the same
 * screen. Undefined when a secure node has no bounds or the image cannot be
 * edited (a JPEG), so the caller withholds it rather than ship an image it
 * could not prove redacted.
 */
function redactSecure(data: Uint8Array, format: 'png' | 'jpeg', projected: ProjectedSnapshot, viewport: ViewportSize | undefined): { data: Uint8Array; masked: number } | undefined {
  const secure = projected.index.filter((entry) => entry.node.states?.secure === true);
  if (secure.length === 0) return { data, masked: 0 };
  if (format !== 'png') return undefined;
  const size = readPngSize(data);
  if (size === undefined) return undefined;
  const scale = viewport !== undefined && viewport.width > 0 ? size.width / viewport.width : 1;
  const rects: Rect[] = [];
  for (const entry of secure) {
    const rect = entry.node.rect;
    if (rect === undefined) return undefined;
    rects.push({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  }
  try {
    return { data: maskPng(data, rects), masked: rects.length };
  } catch {
    return undefined;
  }
}
