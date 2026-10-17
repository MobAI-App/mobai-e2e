import type { AppLogEntry } from 'e2e/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClient } from '../src/client.ts';
import { captureDeviceLogs, isReplayed, toAppLog } from '../src/logs.ts';

describe('device log lines', () => {
  it('reads Android levels and keeps the tag', () => {
    expect(toAppLog({ level: 'E', tag: 'AndroidRuntime', message: 'FATAL EXCEPTION: main' }, 'android', 'warning')).toEqual({ source: 'system', level: 'error', text: 'AndroidRuntime: FATAL EXCEPTION: main' });
    expect(toAppLog({ level: 'W', tag: 'OkHttp', message: 'timeout' }, 'android', 'warning')?.level).toBe('warning');
    expect(toAppLog({ level: 'I', tag: 'Activity', message: 'start' }, 'android', 'warning')).toBeUndefined();
    expect(toAppLog({ level: 'I', tag: 'Activity', message: 'start' }, 'android', 'info')?.level).toBe('info');
    expect(toAppLog({ level: 'D', tag: 'x', message: 'debug' }, 'android', 'info')).toBeUndefined();
  });

  it("reads the simulator's compact type column", () => {
    const line = (type: string) => ({ timestamp: '2026-10-17 10:24:18.397', process: `${type} Example`, pid: '65817:ad8e761', message: `${type} Example[65817:ad8e761] (Net) request failed` });
    expect(toAppLog(line('E'), 'ios', 'warning')).toEqual({ source: 'system', level: 'error', text: 'E Example[65817:ad8e761] (Net) request failed' });
    expect(toAppLog(line('F'), 'ios', 'warning')?.level).toBe('error');
    expect(toAppLog(line('Df'), 'ios', 'warning')).toBeUndefined();
    expect(toAppLog(line('Df'), 'ios', 'info')?.level).toBe('info');
    expect(toAppLog(line('A'), 'ios', 'info')).toBeUndefined();
  });

  it("skips the simulator stream's banner and header", () => {
    expect(toAppLog({ timestamp: 'Filtering the log data ', process: 'using "process BEGINSWITH', pid: 'cd', message: 'using "process BEGINSWITH[cd] "Preferences""' }, 'ios', 'info')).toBeUndefined();
    expect(toAppLog({ timestamp: 'Timestamp               ', process: 'Ty Process', pid: 'PID:TID', message: 'Ty Process[PID:TID]' }, 'ios', 'info')).toBeUndefined();
  });

  it("reads a phone's syslog levels", () => {
    expect(toAppLog({ process: 'Example', level: 'Error', message: 'boom' }, 'ios', 'warning')).toEqual({ source: 'system', level: 'error', text: 'Example: boom' });
    expect(toAppLog({ process: 'Example', level: 'Notice', message: 'hello' }, 'ios', 'info')?.level).toBe('info');
    expect(toAppLog({ process: 'Example', level: 'Debug', message: 'noise' }, 'ios', 'info')).toBeUndefined();
  });

  it("drops logcat's replay of lines from before the stream", () => {
    const openedAt = Date.parse('2026-10-17T08:00:00Z');
    const wall = (offsetMs: number): string => new Date(openedAt - new Date(openedAt).getTimezoneOffset() * 60_000 + offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
    expect(isReplayed({ timestamp: wall(-60_000) }, openedAt)).toBe(true);
    expect(isReplayed({ timestamp: wall(-2_000) }, openedAt)).toBe(false);
    expect(isReplayed({ timestamp: 'not a time' }, openedAt)).toBe(false);
  });
});

describe('device log capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams the host lines into the app log until stopped', async () => {
    const lines = [
      { process: 'E Example', message: 'E Example[1:2] failed to load' },
      { process: 'Df Example', message: 'Df Example[1:2] fine' },
    ];
    let asked = '';
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      asked = String(url);
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(line)}\n\n`));
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const got: AppLogEntry[] = [];
    const capture = captureDeviceLogs(new HostClient('http://host:8686'), 'SIM 1', 'ios', { process: 'Example' }, (entry) => got.push(entry));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    await capture.stop();
    expect(asked).toBe('http://host:8686/api/v1/devices/SIM%201/logs?process=Example');
    expect(got).toEqual([{ source: 'system', level: 'error', text: 'E Example[1:2] failed to load' }]);
  });

  it('a host that cannot stream costs the logs, not the test', async () => {
    vi.stubGlobal('fetch', async () => new Response('no such device', { status: 404 }));
    const capture = captureDeviceLogs(new HostClient('http://host:8686'), 'gone', 'android', {}, () => undefined);
    await expect(capture.stop()).resolves.toBeUndefined();
  });
});
