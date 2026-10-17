/** What `mobai()` takes. */

import type { DeviceLogOptions } from './logs.ts';

export type MobaiPlatform = 'ios' | 'android';

export interface MobaiOptions {
  /** Platform the target's device runs. */
  readonly platform: MobaiPlatform;
  /**
   * Device to drive: a device id as MobAI lists it (a simulator UDID, an
   * adb serial, a phone's UDID), or a device name. A list is a pool: the
   * engine declares one worker per entry and worker slot `n` drives the
   * `n`th. Omitted, the pool is every connected device of the platform at
   * `prepare`, as many as the run has slots. The environment variable
   * `MOBAI_E2E_DEVICE` picks the first worker's device, which is how a run
   * started from the MobAI editor uses the device the user selected.
   */
  readonly device?: string | readonly string[] | undefined;
  /** The MobAI host, `http://127.0.0.1:8686` by default (`MOBAI_HOST_URL`). */
  readonly baseUrl?: string | undefined;
  /**
   * The local API token of a MobAI host on another machine, when that host
   * has one set (`MOBAI_LOCAL_API_TOKEN`). Not the account key: that is `apiKey`.
   */
  readonly localApiToken?: string | undefined;
  /**
   * A MobAI account API key (`mobai_...`; `MOBAI_API_KEY` by default). A host
   * the engine starts runs on it with no sign-in, and `holdOnFailure` uses it.
   */
  readonly apiKey?: string | undefined;
  /**
   * Start a local host with `mobai serve --background` when nothing serves
   * `baseUrl`. Default `true`; the desktop app, when running, is the host.
   */
  readonly autoStart?: boolean | undefined;
  /**
   * How long a control that appeared or moved with the last action is given
   * to finish arriving before a test acts on it, in milliseconds. Default
   * 500, the length of a screen transition.
   */
  readonly transition?: number | undefined;
  /**
   * How long the engine waits after an agent-originated action before the
   * next observation, in milliseconds; `false` skips it. Default 150.
   */
  readonly settle?: number | false | undefined;
  /** Whether `observe` keeps the soft keyboard's keys in the tree. Default `false`. */
  readonly keyboardNodes?: boolean | undefined;
  /**
   * Keep a failed test's device open, on the screen the test stopped at, so
   * the failure can be inspected from the MobAI desktop app: seconds, or
   * `"90s"`, `"10m"`, `"1h"`, up to 2 hours. `MOBAI_E2E_HOLD` by default;
   * unset or 0 holds nothing. Needs `mobaiReporter()` in the config, which
   * asks for the hold once the run ends. Pro: it uses `apiKey`, else the
   * host's signed-in account. Not on farm devices. A refusal is one line in
   * the run summary, not a failure.
   */
  readonly holdOnFailure?: string | number | undefined;
  /**
   * Run on a device farm instead of a device the host already lists: the host
   * opens one session per entry at `prepare` (a list is a pool, one worker per
   * entry) and ends them when the run finishes. Provider credentials come from
   * the host's environment (`BROWSERSTACK_USERNAME`/`_ACCESS_KEY`,
   * `SAUCE_USERNAME`/`_ACCESS_KEY`/`SAUCE_REGION`, `AWS_ACCESS_KEY_ID`/
   * `AWS_SECRET_ACCESS_KEY`). Pro. Not with `device`. Farm devices the MobAI
   * app saved are listed by the host already; name those with `device`.
   */
  readonly cloud?: CloudDevice | readonly CloudDevice[] | undefined;
  /**
   * Capture the device's log lines while each test runs, as evidence: the
   * trace shows them under the step that was running, and `mobaiReporter()`
   * uploads them with a failed case. `true` keeps warnings and errors from
   * the whole device; `{ level, process }` narrows them. Off by default.
   */
  readonly deviceLogs?: boolean | DeviceLogOptions | undefined;
}

/** One farm device for `cloud`. */
export interface CloudDevice {
  readonly provider: 'browserstack' | 'saucelabs' | 'awsdevicefarm';
  /** Catalog device name, e.g. `iPhone 15 Pro`, as the provider's device catalog names it. */
  readonly device: string;
  /** Catalog OS version, e.g. `17`. */
  readonly os: string;
  /** The provider's simulator/emulator catalog instead of real devices. */
  readonly virtual?: boolean | undefined;
  /**
   * The app under test: a local `.ipa`/`.apk` (uploaded by the host) or an
   * uploaded ref (`bs://…`, `storage:…`, `arn:…`). Default: the target's
   * `app.appPath` when it is an `.ipa` or `.apk`.
   */
  readonly app?: string | undefined;
  /** Provider job options (capabilities), passed to the provider as they are. */
  readonly options?: Readonly<Record<string, string>> | undefined;
}

export const MOBAI_OPTION_KEYS: readonly string[] = Object.keys({
  platform: true,
  device: true,
  baseUrl: true,
  localApiToken: true,
  apiKey: true,
  autoStart: true,
  transition: true,
  settle: true,
  keyboardNodes: true,
  holdOnFailure: true,
  cloud: true,
  deviceLogs: true,
} satisfies Record<keyof MobaiOptions, true>);

export const DEFAULT_TRANSITION_MS = 500;
export const DEFAULT_SETTLE_MS = 150;
export const DEFAULT_LONG_PRESS_MS = 1_000;
