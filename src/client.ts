/**
 * The MobAI host's HTTP API (localhost:8686 by default), as the engine
 * uses it. Every call takes an AbortSignal and maps the host's error
 * answers onto the engine error contract.
 */

import { EngineError } from 'e2e/engine';
import { cancelled, failure, invalidState, unsupported } from './errors.ts';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8686';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One element of the host's UI tree, nested. */
export interface HostElement {
  readonly index?: number;
  readonly type?: string;
  readonly text?: string;
  readonly value?: string;
  readonly contentDesc?: string;
  readonly accessibilityId?: string;
  readonly bounds?: Rect;
  readonly clickable?: boolean;
  readonly scrollable?: boolean;
  readonly editable?: boolean;
  readonly focused?: boolean;
  readonly selected?: boolean;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly password?: boolean;
  readonly children?: readonly HostElement[];
}

/** GET /devices/{id}/e2e/snapshot */
export interface HostSnapshot {
  readonly platform: 'ios' | 'android';
  readonly viewport: { readonly width: number; readonly height: number };
  readonly app: { readonly bundleId?: string; readonly activity?: string };
  readonly keyboardShown: boolean;
  readonly root: HostElement;
}

/** One device farm session to open for a run. */
export interface CloudSessionSpec {
  readonly runId: string;
  readonly provider: string;
  readonly device: string;
  readonly os: string;
  readonly platform: 'ios' | 'android';
  readonly virtual?: boolean;
  readonly app?: string;
  readonly options?: Readonly<Record<string, string>>;
}

export interface CloudSession {
  readonly runId: string;
  readonly deviceId: string;
  readonly provider: string;
  readonly name: string;
  readonly os: string;
  readonly platform: 'ios' | 'android';
  readonly virtual?: boolean;
}

/** A device held open after a failed test (POST /devices/{id}/e2e/hold). */
export interface HeldDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly details?: Record<string, string>;
  readonly holdUntil: string;
}

/** GET /devices */
export interface HostDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: 'ios' | 'android';
  readonly model?: string;
  readonly osVersion?: string;
  readonly bridgeRunning?: boolean;
  readonly virtual?: boolean;
  readonly inUse?: boolean;
  readonly remote?: boolean;
  readonly cloud?: boolean;
  readonly connectionState?: string;
  readonly screenWidth?: number;
  readonly screenHeight?: number;
}

export interface HostState {
  readonly activity?: string;
  readonly packageName?: string;
  readonly keyboardShown?: boolean;
}

export interface HostScreenshot {
  readonly data: Uint8Array;
  readonly format: 'png' | 'jpeg';
}

/** GET /devices/{id}/apps */
export interface HostApp {
  readonly bundleId: string;
  readonly name: string;
  readonly version?: string;
}

/** One element `collect-list` met while scrolling a list. */
export interface CollectedElement {
  readonly index: number;
  readonly type: string;
  readonly text: string;
}

/** One device log line, as `GET /devices/{id}/logs` streams it. */
export interface HostLogEntry {
  readonly timestamp?: string;
  readonly process?: string;
  readonly pid?: string;
  readonly level?: string;
  readonly tag?: string;
  readonly message?: string;
  readonly raw?: string;
}

/** What `POST /devices/{id}/dsl/execute` answers for a script. */
interface DslResult {
  readonly success: boolean;
  readonly step_results?: readonly {
    readonly success: boolean;
    readonly error?: { readonly code?: string; readonly message?: string };
    readonly result?: { readonly js_value?: unknown };
  }[];
}

export interface RecordingPart {
  readonly path: string;
  readonly format: string;
  readonly fps?: number;
}

interface HostError {
  readonly error?: string;
  readonly code?: string;
}

export class HostClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string = DEFAULT_BASE_URL,
    private readonly apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  /** Lease tokens by device id, sent on every request that names the device. */
  private readonly leases = new Map<string, string>();

  /** Sends `token` as the lease on every later request for `device`. */
  lease(device: string, token: string): void {
    this.leases.set(device, token);
  }

  private headers(json: boolean, path: string): Record<string, string> {
    const device = /^\/devices\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    const token = device === undefined ? undefined : this.leases.get(decodeURIComponent(device));
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.apiKey === undefined ? {} : { 'x-api-key': this.apiKey }),
      ...(token === undefined ? {} : { 'x-lease-token': token }),
    };
  }

  /** One request; `label` names it in errors. */
  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, signal: AbortSignal | undefined, label: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: this.headers(body !== undefined, path),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      if (signal?.aborted) throw cancelled(`${label} cancelled`);
      throw failure(prefixed(label, `MobAI host at ${this.baseUrl} is unreachable (${messageOf(cause)})`), cause);
    }
    const text = await response.text();
    if (!response.ok) {
      let parsed: HostError = {};
      try {
        parsed = JSON.parse(text) as HostError;
      } catch {
        // Not JSON: keep the raw body as the message.
      }
      const detail = parsed.error || text.trim() || response.statusText;
      throw hostError(response.status, parsed.code, prefixed(label, detail));
    }
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw failure(prefixed(label, 'the host answered with something that is not JSON'));
    }
  }

  get<T>(path: string, signal: AbortSignal | undefined, label: string): Promise<T> {
    return this.request<T>('GET', path, undefined, signal, label);
  }

  post<T>(path: string, body: unknown, signal: AbortSignal | undefined, label: string): Promise<T> {
    return this.request<T>('POST', path, body ?? {}, signal, label);
  }

  // --- host ---

  health(signal?: AbortSignal): Promise<{ status?: string; version?: string }> {
    return this.get('/health', signal, 'health');
  }

  devices(signal?: AbortSignal): Promise<HostDevice[]> {
    return this.get('/devices', signal, 'list devices');
  }
  startBridge(device: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/bridge/start`, {}, signal, 'start bridge');
  }

  /**
   * Claims `device` on a host that requires device claims. The same
   * `clientId` gets the same lease back, so a run that died keeps nothing
   * locked from the next one. The token is sent on this client's later
   * requests for the device.
   */
  async claimDevice(device: string, holder: string, clientId: string, signal?: AbortSignal): Promise<string> {
    const { leaseToken } = await this.post<{ leaseToken: string }>('/devices/claim', { device, holder, clientId }, signal, 'claim device');
    this.lease(device, leaseToken);
    return leaseToken;
  }

  releaseDevice(leaseToken: string, signal?: AbortSignal): Promise<void> {
    return this.post('/devices/release', { leaseToken }, signal, 'release device');
  }

  // --- observation ---

  snapshot(device: string, options: { includeKeyboard?: boolean }, signal?: AbortSignal): Promise<HostSnapshot> {
    const query = options.includeKeyboard === true ? '?includeKeyboard=true' : '';
    return this.get(`/devices/${enc(device)}/e2e/snapshot${query}`, signal, 'snapshot');
  }

  state(device: string, signal?: AbortSignal): Promise<HostState> {
    return this.get(`/devices/${enc(device)}/state`, signal, 'device state');
  }

  async screenshot(device: string, signal?: AbortSignal): Promise<HostScreenshot> {
    const answer = await this.get<{ data?: string; format?: string }>(`/devices/${enc(device)}/screenshot?format=base64`, signal, 'screenshot');
    if (answer.data === undefined || answer.data === '') throw failure('screenshot: the host returned no image data');
    const format = answer.format === 'jpeg' ? 'jpeg' : 'png';
    return { data: new Uint8Array(Buffer.from(answer.data, 'base64')), format };
  }

  // --- input ---

  tap(device: string, at: Point, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/tap`, rounded(at), signal, 'tap');
  }

  doubleTap(device: string, at: Point, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/double-tap`, rounded(at), signal, 'double tap');
  }

  longPress(device: string, at: Point, durationMs: number, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/long-press`, { ...rounded(at), duration: durationMs }, signal, 'long press');
  }

  swipe(device: string, from: Point, to: Point, durationMs: number, signal?: AbortSignal): Promise<void> {
    return this.post(
      `/devices/${enc(device)}/swipe`,
      { fromX: Math.round(from.x), fromY: Math.round(from.y), toX: Math.round(to.x), toY: Math.round(to.y), duration: durationMs },
      signal,
      'swipe',
    );
  }

  drag(device: string, from: Point, to: Point, options: { durationMs?: number; pressMs?: number; holdMs?: number }, signal?: AbortSignal): Promise<void> {
    return this.post(
      `/devices/${enc(device)}/drag`,
      {
        fromX: Math.round(from.x),
        fromY: Math.round(from.y),
        toX: Math.round(to.x),
        toY: Math.round(to.y),
        ...(options.durationMs === undefined ? {} : { duration: options.durationMs }),
        ...(options.pressMs === undefined ? {} : { pressDuration: options.pressMs }),
        ...(options.holdMs === undefined ? {} : { holdDuration: options.holdMs }),
      },
      signal,
      'drag',
    );
  }

  type(device: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/type`, { text }, signal, 'type');
  }

  clearText(device: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/clear-text`, {}, signal, 'clear text');
  }

  pressKey(device: string, key: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/press-key`, { key }, signal, `press ${key}`);
  }

  dismissKeyboard(device: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/dismiss-keyboard`, {}, signal, 'dismiss keyboard');
  }

  goHome(device: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/go-home`, {}, signal, 'home');
  }

  /** Runs one DSL step; a failed step throws with the host's message. Answers the step's result. */
  async dslStep(device: string, step: Record<string, unknown>, signal: AbortSignal | undefined, label: string): Promise<{ js_value?: unknown }> {
    const result = await this.post<DslResult>(`/devices/${enc(device)}/dsl/execute`, { version: '0.2', steps: [step] }, signal, label);
    const first = result.step_results?.[0];
    if (result.success && first?.success !== false) return first?.result ?? {};
    throw failure(prefixed(label, first?.error?.message ?? 'the device refused the step'));
  }

  /** A W3C actions sequence (fingers moving, resting, lifting), as the runner takes it. */
  performActions(device: string, actions: readonly Record<string, unknown>[], signal?: AbortSignal): Promise<{ js_value?: unknown }> {
    return this.dslStep(device, { action: 'perform_actions', actions }, signal, 'drag');
  }

  pinch(device: string, at: Point, scale: number, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/pinch`, { ...rounded(at), scale }, signal, 'pinch');
  }

  twoFingerTap(device: string, at: Point, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/two-finger-tap`, rounded(at), signal, 'two-finger tap');
  }

  /** Scrolls the list at `listIndex` (a snapshot element index) to its end and answers every element it met. */
  collectList(device: string, listIndex: number, direction: 'up' | 'down', signal?: AbortSignal): Promise<{ elements: CollectedElement[] }> {
    return this.post(`/devices/${enc(device)}/collect-list`, { listIndex, direction }, signal, 'collect list');
  }

  scrollUntilVisible(
    device: string,
    body: { listIndex?: number; targetText: string; maxScrolls?: number; direction?: 'up' | 'down' },
    signal?: AbortSignal,
  ): Promise<{ found: boolean }> {
    return this.post(`/devices/${enc(device)}/scroll-until-visible`, body, signal, 'scroll until visible');
  }

  // --- apps ---

  /** `noWait` returns once the process starts on a local simulator; other devices ignore it. */
  launchApp(device: string, bundleId: string, options: { arguments?: readonly string[]; environment?: Readonly<Record<string, string>>; noWait?: boolean }, signal?: AbortSignal): Promise<void> {
    return this.post(
      `/devices/${enc(device)}/launch-app`,
      {
        bundleId,
        ...(options.arguments === undefined || options.arguments.length === 0 ? {} : { arguments: [...options.arguments] }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.noWait === true ? { noWait: true } : {}),
      },
      signal,
      `launch ${bundleId}`,
    );
  }

  killApp(device: string, bundleId: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/kill-app`, { bundleId }, signal, `terminate ${bundleId}`);
  }

  installApp(device: string, path: string, signal?: AbortSignal): Promise<{ bundleId?: string }> {
    return this.post(`/devices/${enc(device)}/install-app`, { path }, signal, `install ${path}`);
  }

  installedApps(device: string, signal?: AbortSignal): Promise<HostApp[]> {
    return this.get(`/devices/${enc(device)}/apps`, signal, 'list apps');
  }

  uninstallApp(device: string, bundleId: string, signal?: AbortSignal): Promise<void> {
    return this.request('DELETE', `/devices/${enc(device)}/apps/${enc(bundleId)}`, undefined, signal, `uninstall ${bundleId}`);
  }

  openUrl(device: string, url: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/open-url`, { url }, signal, 'open link');
  }

  clearAppState(device: string, bundleId: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/clear-app-state`, { bundleId }, signal, `clear state of ${bundleId}`);
  }

  // --- device settings ---

  clipboard(device: string, signal?: AbortSignal): Promise<{ text: string }> {
    return this.get(`/devices/${enc(device)}/clipboard`, signal, 'read clipboard');
  }

  setClipboard(device: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/clipboard`, { text }, signal, 'write clipboard');
  }

  setLocation(device: string, lat: number, lon: number, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/location`, { lat, lon }, signal, 'set location');
  }

  resetLocation(device: string, signal?: AbortSignal): Promise<void> {
    return this.request('DELETE', `/devices/${enc(device)}/location`, undefined, signal, 'reset location');
  }

  fold(device: string, state: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/fold`, { state }, signal, `fold ${state}`);
  }

  // --- e2e device controls ---

  /** Turns the picker wheel (iOS) or NumberPicker (Android) under a point to a row; answers the row it reads afterwards. */
  async selectWheel(device: string, point: Point, value: string, signal?: AbortSignal): Promise<string> {
    const result = await this.post<{ value: string }>(`/devices/${enc(device)}/e2e/select-wheel`, { x: Math.round(point.x), y: Math.round(point.y), value }, signal, `select ${JSON.stringify(value)} on the wheel`);
    return result.value;
  }

  setOrientation(device: string, orientation: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/orientation`, { orientation }, signal, `rotate to ${orientation}`);
  }

  setAppearance(device: string, mode: 'light' | 'dark', signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/appearance`, { mode }, signal, `set ${mode} appearance`);
  }

  resetKeychain(device: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/keychain/reset`, {}, signal, 'reset keychain');
  }

  setNetwork(device: string, state: { wifi?: boolean; data?: boolean; airplane?: boolean }, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/network`, state, signal, 'set network');
  }

  setPermissions(device: string, bundleId: string, permissions: Record<string, 'allow' | 'deny' | 'unset'>, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/permissions`, { bundleId, permissions }, signal, `set permissions of ${bundleId}`);
  }

  alert(device: string, signal?: AbortSignal): Promise<{ present: boolean; text?: string }> {
    return this.get(`/devices/${enc(device)}/e2e/alert`, signal, 'read alert');
  }

  handleAlert(device: string, action: 'accept' | 'dismiss', button?: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/alert`, { action, ...(button === undefined ? {} : { button }) }, signal, `${action} alert`);
  }

  // --- hold on failure ---

  /**
   * Holds a failed test's device open in the MobAI app: the host claims the
   * device as a hold and restarts its runner so the app can reach it. A
   * refusal carries the host's own sentence for the user, passed on as it is.
   */
  hold(device: string, request: { seconds: number; details?: Record<string, string>; apiKey?: string }, signal?: AbortSignal): Promise<HeldDevice> {
    return this.post(`/devices/${enc(device)}/e2e/hold`, request, signal, '');
  }

  // --- device farms ---

  /** Opens a farm session for a run: uploads a local app, allocates the device, lists it on the host. Can take minutes. */
  cloudStart(spec: CloudSessionSpec, signal?: AbortSignal): Promise<CloudSession> {
    return this.post('/e2e/cloud/start', spec, signal, `open a ${spec.provider} session`);
  }

  /** Ends every farm session the run opened. */
  cloudEnd(runId: string, signal?: AbortSignal): Promise<{ sessions: CloudSession[] }> {
    return this.post('/e2e/cloud/end', { runId }, signal, 'end the farm sessions');
  }

  /** Enrolls, clears, or sends one attempt to the simulated biometric sensor. */
  biometrics(device: string, sensor: string, action: 'match' | 'nomatch' | 'enroll' | 'unenroll', signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/biometrics`, { sensor, action }, signal, `${sensor} ${action}`);
  }

  // --- recording ---

  startRecording(device: string, outBase: string, signal?: AbortSignal): Promise<void> {
    return this.post(`/devices/${enc(device)}/e2e/recording/start`, { outBase }, signal, 'start recording');
  }

  stopRecording(device: string, signal?: AbortSignal): Promise<{ parts: RecordingPart[]; error?: string }> {
    return this.post(`/devices/${enc(device)}/e2e/recording/stop`, {}, signal, 'stop recording');
  }

  // --- device logs ---

  /** The device's log lines as they come, until `signal` aborts. `process` narrows them on the host. */
  async *logs(device: string, process: string | undefined, signal: AbortSignal): AsyncGenerator<HostLogEntry> {
    const query = process === undefined || process === '' ? '' : `?process=${enc(process)}`;
    let response: Response;
    try {
      response = await fetch(this.url(`/devices/${enc(device)}/logs${query}`), { headers: this.headers(false, `/devices/${enc(device)}/logs`), signal });
    } catch (cause) {
      if (signal.aborted) return;
      throw failure(prefixed('device logs', `MobAI host at ${this.baseUrl} is unreachable (${messageOf(cause)})`), cause);
    }
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '');
      throw hostError(response.status, undefined, prefixed('device logs', text.trim() || response.statusText));
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          try {
            yield JSON.parse(line.slice(5)) as HostLogEntry;
          } catch {
            // A line that is not JSON is not a log entry.
          }
        }
      }
    } catch (cause) {
      if (signal.aborted) return;
      throw failure(prefixed('device logs', messageOf(cause)), cause);
    }
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Names the request in an error; an empty label passes the text on as it is. */
function prefixed(label: string, text: string): string {
  return label === '' ? text : `${label}: ${text}`;
}

function rounded(at: Point): { x: number; y: number } {
  return { x: Math.round(at.x), y: Math.round(at.y) };
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    if (inner instanceof Error && inner.message !== '') return inner.message;
    return cause.message;
  }
  return String(cause);
}

/** The host's refusal of one more device on the Free plan; `isDeviceLimit` tells it apart. */
class DeviceLimit extends Error {}

export function isDeviceLimit(error: unknown): boolean {
  return error instanceof EngineError && error.cause instanceof DeviceLimit;
}

/** The host wants a device claim before it drives the device; `isClaimRequired` tells it apart. */
class ClaimRequired extends Error {}

export function isClaimRequired(error: unknown): boolean {
  return error instanceof EngineError && error.cause instanceof ClaimRequired;
}

/** Maps one host error answer onto the engine contract. */
function hostError(status: number, code: string | undefined, text: string): EngineError {
  if (status === 404) return invalidState(text);
  if (status === 501) return unsupported(text);
  if (code === 'device_limit_reached') return failure(text, new DeviceLimit(text));
  if (code === 'CLAIM_REQUIRED') return failure(text, new ClaimRequired(text));
  if (code === 'DEVICE_IN_USE') return failure(text);
  if (status === 402) return failure(`${text} (needs MobAI Pro)`);
  if (status === 409) return failure(`${text} (device busy)`);
  return failure(text);
}
