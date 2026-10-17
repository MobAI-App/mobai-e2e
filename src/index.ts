/**
 * @mobai-app/e2e: MobAI for tester-army e2e.
 *
 *   import { mobai, mobaiReporter } from '@mobai-app/e2e';
 *
 *   export default {
 *     targets: [{ name: 'iphone', engine: mobai({ platform: 'ios' }), app: { bundleId: 'com.example.app' } }],
 *     reporters: ['list', mobaiReporter()],
 *   } satisfies E2EConfig;
 */

export { mobai } from './engine.ts';
export { mobaiReporter, type MobaiReporterOptions } from './reporter.ts';
export type { CloudDevice, MobaiOptions, MobaiPlatform } from './options.ts';
export type { Device, DeviceApp, DeviceControls, DeviceExpectations, FoldPose, ForegroundApp, GestureTarget, InstallAppOptions, InstalledApp, OpenAppOptions } from './device.ts';
export type { Coordinate, DragPoint } from './gestures.ts';
export type { DeviceLogOptions, LogLevel } from './logs.ts';
