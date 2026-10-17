/**
 * Starting a host when none answers: the `mobai` on PATH first, then the
 * published CLI through npx. PATH holds fake commands that record how they
 * were called and bring a stub host up.
 */

import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostClient } from '../src/client.ts';
import { ensureHost } from '../src/host.ts';

let server: Server | undefined;
let dir: string;

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A host stub that answers health only once `up` exists in dir. */
async function stubHost(): Promise<string> {
  server = createServer((_req, res) => {
    if (!existsSync(path.join(dir, 'up'))) {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'mobai', version: 'test' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** A fake command on PATH: records its arguments, then prints and exits. */
function fake(name: string, script: string): void {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$@" >> "${path.join(dir, `${name}.calls`)}"\n${script}\n`);
  chmodSync(file, 0o755);
}

function calls(name: string): string {
  return existsSync(path.join(dir, `${name}.calls`)) ? readFileSync(path.join(dir, `${name}.calls`), 'utf8').trim() : '';
}

async function start(env: Record<string, string>): Promise<string[]> {
  const base = await stubHost();
  const lines: string[] = [];
  await ensureHost(new HostClient(base), {}, { PATH: `${dir}:/usr/bin:/bin`, ...env }, (l) => lines.push(l), new AbortController().signal);
  return lines;
}

describe.skipIf(process.platform === 'win32')('ensureHost start', () => {
  it('runs the CLI through npx when no mobai is on PATH', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mobai-host-'));
    fake('npx', `touch "${dir}/up"`);
    const lines = await start({});
    expect(calls('npx')).toMatch(/^--yes @mobai-app\/cli@latest serve --background --port \d+$/);
    expect(lines.join('\n')).toMatch(/no `mobai` CLI on PATH/);
  });

  it('uses the mobai on PATH when it can serve', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mobai-host-'));
    fake('mobai', `touch "${dir}/up"`);
    fake('npx', 'exit 1');
    await start({});
    expect(calls('mobai')).toMatch(/^serve --background --port \d+$/);
    expect(calls('npx')).toBe('');
  });

  it('falls back to npx when the mobai on PATH is too old to serve', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mobai-host-'));
    fake('mobai', 'echo \'Error: unknown command "serve" for "mobai"\' >&2; exit 1');
    fake('npx', `touch "${dir}/up"`);
    const lines = await start({});
    expect(calls('npx')).toMatch(/@mobai-app\/cli@latest serve/);
    expect(lines.join('\n')).toMatch(/too old/);
  });

  it('never falls back when MOBAI_BIN pins a binary', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mobai-host-'));
    fake('npx', `touch "${dir}/up"`);
    await expect(start({ MOBAI_BIN: path.join(dir, 'missing') })).rejects.toThrow(/set MOBAI_BIN/);
    expect(calls('npx')).toBe('');
  });
});
