/**
 * Reaching a MobAI host. The desktop app serves the API while it runs; the
 * `mobai` CLI can serve it on its own (`mobai serve`). `ensureHost` probes
 * the base URL and, on loopback, starts a background host when nothing
 * answers, so a test run needs neither the app open nor a manual start.
 */

import { spawn } from 'node:child_process';
import { EngineError } from 'e2e/engine';
import { HostClient, DEFAULT_BASE_URL } from './client.ts';
import { message } from './errors.ts';

export interface HostOptions {
  readonly baseUrl?: string | undefined;
  readonly localApiToken?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly autoStart?: boolean | undefined;
}

/** The account API key: the option, else `MOBAI_API_KEY`. */
export function resolveApiKey(options: HostOptions, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const key = (options.apiKey ?? env['MOBAI_API_KEY'])?.trim();
  return key === undefined || key === '' ? undefined : key;
}

/** The base URL to use: the option, else `MOBAI_HOST_URL`, else loopback. */
export function resolveBaseUrl(options: HostOptions, env: Readonly<Record<string, string | undefined>>): string {
  return (options.baseUrl ?? env['MOBAI_HOST_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** The host's local API token: the option, else `MOBAI_LOCAL_API_TOKEN`. */
export function resolveLocalApiToken(options: HostOptions, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = options.localApiToken ?? env['MOBAI_LOCAL_API_TOKEN'];
  return token === undefined || token.trim() === '' ? undefined : token.trim();
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const START_TIMEOUT_MS = 90_000;

/**
 * Makes sure a host answers at `client.baseUrl`. With nothing listening on
 * a loopback URL and `autoStart` on, runs `mobai serve --background` (the
 * `mobai` binary on PATH, or `MOBAI_BIN`; without one, the published CLI
 * through npx) and waits for it.
 */
export async function ensureHost(
  client: HostClient,
  options: HostOptions,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    await client.health(signal);
    return;
  } catch (cause) {
    if (signal.aborted) throw cause;
    if (options.autoStart === false || !isLoopback(client.baseUrl)) {
      throw new EngineError('ENGINE_FAILURE', `no MobAI host at ${client.baseUrl}: open the MobAI app, or run \`mobai serve\` (${message(cause)})`, {
        retryable: false,
        cause,
      });
    }
  }
  const port = new URL(client.baseUrl).port || '8686';
  const serveArgs = ['serve', '--background', '--port', port];
  // The key goes through the environment, never the command line, so it does
  // not show in a process listing. With it the host needs no sign-in.
  const apiKey = resolveApiKey(options, env);
  const childEnv = { ...process.env, ...stringEnv(env), ...(apiKey === undefined ? {} : { MOBAI_API_KEY: apiKey }) };
  const pinned = env['MOBAI_BIN'];
  let started = await runStart(pinned ?? 'mobai', serveArgs, childEnv, log);
  // No `mobai` on PATH, or one too old to serve: run the published CLI
  // through npx, as `npx @mobai-app/cli` would.
  if (pinned === undefined && (started.missing || /unknown command/i.test(started.output))) {
    log(started.missing ? 'no `mobai` CLI on PATH; running it through npx' : 'the `mobai` CLI on PATH cannot serve (too old); running the current one through npx');
    started = await runStart(NPX, ['--yes', `${CLI_PACKAGE}@latest`, ...serveArgs], childEnv, log);
  }
  if (started.missing) {
    throw new EngineError(
      'ENGINE_FAILURE',
      `could not start a MobAI host: ${started.output}; install the MobAI CLI (npm i -g ${CLI_PACKAGE}), open the MobAI app, or set MOBAI_BIN`,
      { retryable: false },
    );
  }
  if (started.code !== 0) {
    throw new EngineError('ENGINE_FAILURE', `\`${started.command} serve --background\` exited with ${String(started.code)}: ${started.output.trim()}`, { retryable: false });
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new EngineError('CANCELLED', 'host start cancelled', { retryable: false });
    try {
      await client.health(signal);
      return;
    } catch (cause) {
      last = cause;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new EngineError('ENGINE_FAILURE', `MobAI host did not come up at ${client.baseUrl} within ${START_TIMEOUT_MS / 1000}s (${message(last)})`, {
    retryable: false,
  });
}

/** The MobAI CLI on npm, run through npx when no `mobai` binary is found. */
export const CLI_PACKAGE = '@mobai-app/cli';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

interface StartResult {
  readonly command: string;
  /** The command could not be run at all (not installed). */
  readonly missing: boolean;
  readonly code: number | null;
  readonly output: string;
}

/** Runs one start command to its exit, collecting what it printed. */
function runStart(command: string, args: readonly string[], env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<StartResult> {
  log(`no MobAI host; starting \`${[command, ...args].join(' ')}\``);
  return new Promise((resolve) => {
    // npx on Windows is a .cmd, which Node runs only through a shell; the
    // arguments are fixed strings and a port number.
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env, shell: command === 'npx.cmd' });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (cause) => {
      resolve({ command, missing: true, code: null, output: `could not run \`${command}\` (${cause.message})` });
    });
    child.on('exit', (code) => {
      resolve({ command, missing: false, code, output });
    });
  });
}

function stringEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}
