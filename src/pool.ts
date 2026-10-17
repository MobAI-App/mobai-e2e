/**
 * The devices one target drives: one MobAI device per worker slot. `prepare`
 * binds a device to every slot the run will use, starts its bridge once per
 * run, and hands the bindings to the workers through the run's environment;
 * `init` resumes its slot's device from there.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { ConfigurationError, EngineError, type EnginePrepareInfo, type EnginePrepareResult } from 'e2e/engine';
import { isClaimRequired, isDeviceLimit, type HostClient, type HostDevice } from './client.ts';
import { message } from './errors.ts';
import { resolveApiKey } from './host.ts';
import type { CloudDevice, MobaiOptions, MobaiPlatform } from './options.ts';

/** What one worker slot drives. */
export interface SlotBinding {
  readonly id: string;
  readonly name: string;
  readonly platform: MobaiPlatform;
  readonly model?: string | undefined;
  readonly os?: string | undefined;
  readonly virtual?: boolean | undefined;
  /** The lease token, on a host that requires device claims. */
  readonly lease?: string | undefined;
}

const MAX_BINDINGS_ENV_BYTES = 16 * 1024;

export function bindingsVariable(targetName: string): string {
  const readable = targetName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const digest = createHash('sha256').update(targetName).digest('hex').slice(0, 8).toUpperCase();
  return `MOBAI_E2E_POOL_${readable}_${digest}`;
}

export function encodeBindings(bindings: readonly SlotBinding[]): string {
  const encoded = JSON.stringify(bindings);
  if (Buffer.byteLength(encoded) > MAX_BINDINGS_ENV_BYTES) {
    throw new EngineError('ENGINE_FAILURE', `the device bindings take more than ${MAX_BINDINGS_ENV_BYTES} bytes`, { retryable: false });
  }
  return encoded;
}

export function decodeBindings(raw: string | undefined): readonly SlotBinding[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isBinding)) return parsed as SlotBinding[];
  } catch {
    // Not ours.
  }
  return undefined;
}

function isBinding(value: unknown): value is SlotBinding {
  if (typeof value !== 'object' || value === null) return false;
  const { id, name, platform } = value as Record<string, unknown>;
  return typeof id === 'string' && typeof name === 'string' && (platform === 'ios' || platform === 'android');
}

function toBinding(device: HostDevice): SlotBinding {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    ...(device.model === undefined ? {} : { model: device.model }),
    ...(device.osVersion === undefined ? {} : { os: device.osVersion }),
    ...(device.virtual === undefined ? {} : { virtual: device.virtual }),
  };
}

/** Whether a listed device can be driven from this host right now. */
function available(device: HostDevice, platform: MobaiPlatform): boolean {
  if (device.platform !== platform) return false;
  if (device.inUse === true) return false;
  if (device.cloud === true) return false;
  if (device.connectionState !== undefined && device.connectionState !== '' && device.connectionState !== 'connected' && device.connectionState !== 'ready') return false;
  return true;
}

/** Matches one configured device string against a listing: id first, then exact name, then name substring. */
function pick(devices: readonly HostDevice[], wanted: string, platform: MobaiPlatform): HostDevice | undefined {
  const lowered = wanted.toLowerCase();
  return (
    devices.find((d) => d.id === wanted && d.platform === platform) ??
    devices.find((d) => d.name.toLowerCase() === lowered && d.platform === platform) ??
    devices.find((d) => d.name.toLowerCase().includes(lowered) && d.platform === platform)
  );
}

const CLOUD_PROVIDERS: readonly string[] = ['browserstack', 'saucelabs', 'awsdevicefarm'];

/** Reads `cloud` into a list, checking each entry. */
function cloudDevices(cloud: MobaiOptions['cloud']): readonly CloudDevice[] | undefined {
  if (cloud === undefined) return undefined;
  const list: readonly CloudDevice[] = Array.isArray(cloud) ? cloud : [cloud as CloudDevice];
  if (list.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'mobai: `cloud` is an empty pool; name at least one farm device, or omit it');
  }
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || !CLOUD_PROVIDERS.includes(entry.provider)) {
      throw new ConfigurationError('INVALID_CONFIG', `mobai: each \`cloud\` entry needs a provider: ${CLOUD_PROVIDERS.join(', ')}`);
    }
    if (typeof entry.device !== 'string' || entry.device === '' || typeof entry.os !== 'string' || entry.os === '') {
      throw new ConfigurationError('INVALID_CONFIG', 'mobai: each `cloud` entry needs `device` and `os` from the provider\'s catalog');
    }
  }
  return list;
}

/** The farm app for an entry: its own, else the target's build when a farm can install it. */
function cloudApp(entry: CloudDevice, info: EnginePrepareInfo): string | undefined {
  if (entry.app !== undefined) return /^(bs:\/\/|storage:|arn:)/.test(entry.app) ? entry.app : path.resolve(info.projectRoot, entry.app);
  const build = info.app.appPath;
  if (build === undefined || !/\.(ipa|apk)$/i.test(build)) return undefined;
  return path.resolve(info.projectRoot, build);
}

export class DevicePool {
  private readonly bound = new Map<string, readonly SlotBinding[]>();
  /** Lease tokens taken in this process, by device id. */
  private readonly leases = new Map<string, string>();
  private readonly configured: readonly string[] | undefined;
  private readonly cloud: readonly CloudDevice[] | undefined;

  constructor(
    private readonly options: MobaiOptions,
    private readonly client: () => HostClient,
  ) {
    const { device } = options;
    this.cloud = cloudDevices(options.cloud);
    if (this.cloud !== undefined && device !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', 'mobai: set `device` or `cloud`, not both');
    }
    if (device === undefined) {
      this.configured = undefined;
    } else if (typeof device === 'string') {
      this.configured = [device];
    } else if (Array.isArray(device)) {
      if (device.length === 0) {
        throw new ConfigurationError('INVALID_CONFIG', 'mobai: `device` is an empty pool; name at least one device, or omit it to use every connected one');
      }
      this.configured = device as readonly string[];
    } else {
      throw new ConfigurationError('INVALID_CONFIG', 'mobai: `device` must be a device id or name, or a list of them');
    }
  }

  /** Workers the engine serves per target: the configured pool's size, or unknown until `prepare`. */
  get size(): number | undefined {
    return this.cloud?.length ?? this.configured?.length;
  }

  /** Whether `prepare` opens farm sessions that `finish` must end. */
  get usesCloud(): boolean {
    return this.cloud !== undefined;
  }

  /** What slot `slot` of `targetName` drives: bound in this process, else from the environment. */
  binding(targetName: string, slot: number, env: Readonly<Record<string, string | undefined>>): SlotBinding {
    const bindings = this.bound.get(targetName) ?? decodeBindings(env[bindingsVariable(targetName)]);
    if (bindings === undefined) {
      throw new EngineError('ENGINE_FAILURE', `no device was bound for target "${targetName}"; prepare did not run`, { retryable: false });
    }
    const binding = bindings[slot];
    if (binding === undefined) {
      throw new EngineError('ENGINE_FAILURE', `worker slot ${slot} is outside a device pool of ${bindings.length}`, { retryable: false });
    }
    return binding;
  }

  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (info.slots === 0) return {};
    const client = this.client();
    const devices = await client.devices(info.signal);
    const { platform } = this.options;
    const pinned = info.env['MOBAI_E2E_DEVICE']?.trim();
    const chosen: HostDevice[] = [];
    if (pinned !== undefined && pinned !== '') {
      const device = pick(devices, pinned, platform);
      if (device === undefined) {
        throw new EngineError('ENGINE_FAILURE', `MOBAI_E2E_DEVICE names "${pinned}", which is not a connected ${platform} device on ${client.baseUrl}`, { retryable: false });
      }
      chosen.push(device);
    } else if (this.cloud !== undefined) {
      chosen.push(...(await this.openCloud(client, info)));
    } else if (this.configured !== undefined) {
      for (const wanted of this.configured.slice(0, info.slots)) {
        const device = pick(devices, wanted, platform);
        if (device === undefined) {
          const known = devices.filter((d) => d.platform === platform).map((d) => `${d.name} (${d.id})`);
          throw new EngineError(
            'ENGINE_FAILURE',
            `device "${wanted}" is not a connected ${platform} device on ${client.baseUrl}${known.length === 0 ? '' : `; connected: ${known.join(', ')}`}`,
            { retryable: false },
          );
        }
        chosen.push(device);
      }
    } else {
      const free = devices.filter((d) => available(d, platform));
      chosen.push(...free.slice(0, info.slots));
      if (chosen.length === 0) {
        throw new EngineError(
          'ENGINE_FAILURE',
          `no ${platform} device is connected to MobAI at ${client.baseUrl}; boot a simulator or emulator, or plug a phone in (${devices.length} device(s) listed)`,
          { retryable: false },
        );
      }
    }
    const bindings = chosen.map(toBinding);
    info.log(`driving ${bindings.length} ${platform} device(s): ${bindings.map((b) => `${b.name} (${b.id})`).join(', ')}`);
    for (const [i, binding] of bindings.entries()) {
      info.log(`starting bridge on ${binding.name}`);
      try {
        await this.startBridge(client, binding, info);
      } catch (cause) {
        if (info.signal.aborted) throw cause;
        if (isDeviceLimit(cause) && bindings.length > 1) {
          throw new EngineError(
            'ENGINE_FAILURE',
            `Running on ${bindings.length} devices in parallel needs MobAI Pro. The Free plan runs on one device at a time. Name one device in \`device\`, or upgrade to Pro`,
            { retryable: false, cause },
          );
        }
        throw new EngineError('ENGINE_FAILURE', `bridge on ${binding.name} did not start: ${message(cause)}`, { retryable: false, cause });
      }
      if (binding.lease === undefined) {
        const lease = this.leases.get(binding.id);
        if (lease !== undefined) bindings[i] = { ...binding, lease };
      }
      const app = info.app.bundleId;
      if (app !== undefined) {
        try {
          await client.launchApp(binding.id, app, {}, info.signal);
        } catch (cause) {
          if (info.signal.aborted) throw cause;
          info.log(`${binding.name}: ${app} did not open (${message(cause)}); the first attempt opens it`);
        }
      }
    }
    this.bound.set(info.targetName, bindings);
    return { workers: bindings.length, env: { [bindingsVariable(info.targetName)]: encodeBindings(bindings) } };
  }

  /**
   * Starts the bridge; a host that requires device claims answers the first
   * try with CLAIM_REQUIRED, so the device is claimed for the run and the
   * start repeated. One stable client id per project and device, so a run
   * that died hands its lease to the next run instead of locking it out.
   */
  private async startBridge(client: HostClient, binding: SlotBinding, info: EnginePrepareInfo): Promise<void> {
    try {
      await client.startBridge(binding.id, info.signal);
    } catch (cause) {
      if (!isClaimRequired(cause)) throw cause;
      const holder = `e2e (${path.basename(info.projectRoot)})`;
      const token = await client.claimDevice(binding.id, holder, `e2e:${info.projectRoot}:${binding.id}`, info.signal);
      this.leases.set(binding.id, token);
      info.log(`${binding.name}: claimed for this run, the host requires device claims`);
      await client.startBridge(binding.id, info.signal);
    }
  }

  /** Releases the leases `prepare` took for `targetName`; the host drops a lease it never hears about again anyway. */
  async release(client: HostClient, targetName: string, signal?: AbortSignal): Promise<void> {
    for (const binding of this.bound.get(targetName) ?? []) {
      if (binding.lease === undefined) continue;
      this.leases.delete(binding.id);
      await client.releaseDevice(binding.lease, signal);
    }
  }

  /**
   * Opens one farm session per slot. One that fails ends the ones already
   * open, so a broken run never leaves a billed device behind.
   */
  private async openCloud(client: HostClient, info: EnginePrepareInfo): Promise<HostDevice[]> {
    const { platform } = this.options;
    const opened: HostDevice[] = [];
    for (const entry of this.cloud!.slice(0, info.slots)) {
      const app = cloudApp(entry, info);
      info.log(`opening ${entry.device} (${entry.os}) on ${entry.provider}${app === undefined ? '' : ` with ${path.basename(app)}`}; this can take a few minutes`);
      try {
        const session = await client.cloudStart(
          {
            runId: info.runId,
            provider: entry.provider,
            device: entry.device,
            os: entry.os,
            platform,
            ...(entry.virtual === undefined ? {} : { virtual: entry.virtual }),
            ...(app === undefined ? {} : { app }),
            ...(entry.options === undefined ? {} : { options: entry.options }),
          },
          info.signal,
        );
        opened.push({ id: session.deviceId, name: `${entry.device} on ${entry.provider}`, platform, osVersion: entry.os, virtual: entry.virtual === true });
      } catch (cause) {
        await client.cloudEnd(info.runId).catch(() => undefined);
        if (info.signal.aborted) throw cause;
        throw new EngineError('ENGINE_FAILURE', `${entry.device} on ${entry.provider} did not start: ${message(cause)}`, { retryable: false, cause });
      }
    }
    return opened;
  }
}
