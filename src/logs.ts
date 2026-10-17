/**
 * Device logs as evidence: while an attempt runs, the device's log lines
 * (iOS syslog or the simulator's log stream, Android logcat) go to the
 * harness as the attempt's app log, the place e2e keeps what the app did on
 * its own. The trace shows them under the step that was running, the report
 * keeps them, and `mobaiReporter()` uploads them with a failed case.
 */

import type { AppLogEntry } from 'e2e/engine';
import type { HostClient, HostLogEntry } from './client.ts';

export type LogLevel = 'error' | 'warning' | 'info';

/** What `mobai({ deviceLogs })` takes beyond `true`. */
export interface DeviceLogOptions {
  /** The lowest level kept. Default `'warning'`. */
  readonly level?: LogLevel | undefined;
  /**
   * Only lines of this process: the app's executable name on iOS (the
   * simulator's `log stream --process`), a log tag on Android. Without it
   * the whole device logs, the system included.
   */
  readonly process?: string | undefined;
}

const RANK: Readonly<Record<LogLevel, number>> = { info: 0, warning: 1, error: 2 };

/** The level types of the simulator's compact log style, as the first word of its process column. */
const SIMULATOR_TYPES: Readonly<Record<string, LogLevel | undefined>> = { E: 'error', F: 'error', Df: 'info', I: 'info', D: undefined, Db: undefined, A: undefined };

/** Android logcat drops its whole buffer on a new reader first; lines older than this before the stream opened are that replay. */
const REPLAY_SLACK_MS = 10_000;

/** One host log line as an app log entry, or undefined for a line below the level or with no level worth keeping. */
export function toAppLog(entry: HostLogEntry, platform: 'ios' | 'android', floor: LogLevel): AppLogEntry | undefined {
  let level: LogLevel | undefined;
  let text: string;
  if (platform === 'android') {
    level = androidLevel(entry.level);
    const message = entry.message ?? entry.raw ?? '';
    text = entry.tag === undefined || entry.tag === '' ? message : `${entry.tag}: ${message}`;
  } else {
    const process = entry.process ?? '';
    const typed = /^(\S+)\s+\S/.exec(process);
    const type = typed?.[1];
    if (entry.level === undefined && type !== undefined && type in SIMULATOR_TYPES) {
      // The simulator's line: "<time> Df Name[pid:tid] message", kept whole after the type.
      level = SIMULATOR_TYPES[type];
      text = entry.message ?? entry.raw ?? '';
    } else {
      level = appleLevel(entry.level);
      const message = entry.message ?? entry.raw ?? '';
      text = process === '' ? message : `${process}: ${message}`;
    }
  }
  if (level === undefined || RANK[level] < RANK[floor] || text.trim() === '') return undefined;
  return { source: 'system', level, text };
}

function androidLevel(level: string | undefined): LogLevel | undefined {
  switch (level) {
    case 'E':
    case 'F':
      return 'error';
    case 'W':
      return 'warning';
    case 'I':
      return 'info';
    default:
      return undefined;
  }
}

function appleLevel(level: string | undefined): LogLevel | undefined {
  const name = (level ?? '').toLowerCase();
  if (name.includes('fault') || name.includes('err') || name.includes('crit') || name.includes('alert') || name.includes('emerg')) return 'error';
  if (name.includes('warn')) return 'warning';
  if (name.includes('notice') || name.includes('info') || name.includes('default')) return 'info';
  // No level: the simulator stream's banner and header lines, not log entries.
  return undefined;
}

/**
 * Whether an Android line is from logcat's replay of its buffer. The host
 * stamps logcat's wall-clock time as if it were UTC, so it is compared with
 * the local wall clock read the same way.
 */
export function isReplayed(entry: HostLogEntry, openedAt: number): boolean {
  const at = Date.parse(entry.timestamp ?? '');
  if (Number.isNaN(at)) return false;
  const wallAsUtc = openedAt - new Date(openedAt).getTimezoneOffset() * 60_000;
  return at < wallAsUtc - REPLAY_SLACK_MS;
}

/** A running capture; `stop` ends it and resolves once the stream is closed. */
export interface LogCapture {
  stop(): Promise<void>;
}

/** Streams the device's logs into `appLog` until stopped. A stream that fails costs the attempt its logs, never a step. */
export function captureDeviceLogs(
  client: HostClient,
  device: string,
  platform: 'ios' | 'android',
  options: DeviceLogOptions,
  appLog: (entry: AppLogEntry) => void,
): LogCapture {
  const controller = new AbortController();
  const floor = options.level ?? 'warning';
  const openedAt = Date.now();
  const done = (async () => {
    try {
      for await (const entry of client.logs(device, options.process, controller.signal)) {
        if (platform === 'android' && isReplayed(entry, openedAt)) continue;
        const line = toAppLog(entry, platform, floor);
        if (line !== undefined) appLog(line);
      }
    } catch {
      // No logs is not a failure of the test.
    }
  })();
  return {
    async stop() {
      controller.abort();
      await done;
    },
  };
}

/** Reads `deviceLogs` into its options, or undefined when off. */
export function deviceLogOptions(value: boolean | DeviceLogOptions | undefined): DeviceLogOptions | undefined {
  if (value === undefined || value === false) return undefined;
  return value === true ? {} : value;
}
