/**
 * Hold on failure (`mobai({ holdOnFailure })`): after a test fails, its device
 * stays open in the MobAI app on the screen the test stopped at, so the
 * failure can be inspected there. Nothing is published while the run drives
 * the device: the host only hears about a device once its test has failed.
 *
 * The engine cannot ask for the hold itself: its hooks never learn whether a
 * test failed. The reporter sees the finished run, so it holds the failed
 * tests' devices, with the settings the engine was configured with. Both live
 * in the process that loads `e2e.config.ts`, so `mobai()` records them here.
 */

import type { Report } from 'e2e';
import { HostClient, type HeldDevice } from './client.ts';
import { message } from './errors.ts';
import { resolveApiKey, resolveBaseUrl, resolveLocalApiToken } from './host.ts';
import { toBundle } from './reporter.ts';

/** Reads a hold: seconds as a number, or a string such as `90s`, `10m`, `1h`. */
export function parseHold(value: string | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`holdOnFailure must be zero or more seconds, got ${value}`);
    return Math.round(value);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(value);
  if (match === null) throw new Error(`holdOnFailure takes seconds or a duration such as "10m", got ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  return Math.round(amount * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1));
}

/** What an engine with `holdOnFailure` was configured with, for the reporter. */
export interface EngineHold {
  readonly holdOnFailure: string | number;
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly localApiToken?: string | undefined;
}

let configured: EngineHold | undefined;

/** Records an engine's hold settings; the longest hold wins. */
export function noteEngineHold(settings: EngineHold): void {
  if (configured === undefined || parseHold(settings.holdOnFailure) > parseHold(configured.holdOnFailure)) configured = settings;
}

/** The hold settings the engines asked for, if any. */
export function engineHold(): EngineHold | undefined {
  return configured;
}

/** Forgets the recorded settings (tests). */
export function resetEngineHold(): void {
  configured = undefined;
}

/** The first failure: what the app shows next to the held device. */
export function failureDetails(report: Report): Record<string, string> {
  const { bundle } = toBundle(report, { projectName: '' });
  const failing = bundle.cases.find((c) => !c.passed && c.status !== 'skipped');
  if (failing === undefined) return bundle.error === '' ? { test: 'run' } : { test: 'run', error: bundle.error };
  const details: Record<string, string> = { test: failing.name };
  const step = failing.failedStepIndex === null ? undefined : failing.steps.find((s) => s.index === failing.failedStepIndex);
  if (step !== undefined && step.lineText !== '') details['step'] = step.lineText;
  const error = step?.error || failing.error;
  if (error !== '') details['error'] = error;
  if (failing.sourcePath !== '') details['file'] = failing.sourcePath;
  return details;
}

/** The devices failed tests ran on, from each failed attempt's recorded device. */
export function failedDevices(report: Report): string[] {
  const ids = new Set<string>();
  for (const result of report.run.results) {
    if (result.status === 'passed' || result.status === 'skipped') continue;
    for (const attempt of result.attempts) {
      if (attempt.status === 'passed') continue;
      const id = attempt.environment?.['deviceId'];
      if (id !== undefined && id !== '') ids.add(id);
    }
  }
  return [...ids];
}

export interface HoldOptions {
  /** Seconds to hold each failed test's device. */
  readonly holdSeconds: number;
  readonly settings: EngineHold | undefined;
  readonly baseUrl?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
}

/** Holds the failed tests' devices; answers what is held and why any is not. */
export async function holdFailed(report: Report, options: HoldOptions): Promise<{ held: HeldDevice[]; refused: string[] }> {
  const devices = failedDevices(report);
  const held: HeldDevice[] = [];
  const refused: string[] = [];
  if (devices.length === 0 || options.holdSeconds === 0) return { held, refused };
  const host = { baseUrl: options.settings?.baseUrl ?? options.baseUrl, localApiToken: options.settings?.localApiToken };
  const client = new HostClient(resolveBaseUrl(host, options.env), resolveLocalApiToken(host, options.env));
  const apiKey = resolveApiKey({ apiKey: options.settings?.apiKey }, options.env);
  const details = failureDetails(report);
  for (const device of devices) {
    try {
      held.push(await client.hold(device, { seconds: options.holdSeconds, details, ...(apiKey === undefined ? {} : { apiKey }) }, options.signal));
    } catch (cause) {
      if (options.signal.aborted) throw cause;
      refused.push(message(cause));
    }
  }
  return { held, refused };
}

/** One summary line for the held devices. */
export function describeHold(held: readonly HeldDevice[]): string {
  const names = held.map((d) => `"${d.label}"`).join(', ');
  const until = held[0]?.holdUntil;
  const when = until === undefined ? '' : ` until ${new Date(until).toLocaleTimeString()}`;
  return `holding ${names} for inspection${when}. Open it in the MobAI app under CI Devices, and release it there to end early.`;
}
