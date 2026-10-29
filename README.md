# @mobai-app/e2e

**Run [tester-army/e2e](https://github.com/tester-army/e2e) tests on physical iOS and Android devices, simulators, and emulators from macOS, Linux, or Windows.**

[@mobai-app/e2e](https://mobai.run) adds a MobAI device engine and reporter to `e2e`. Test on real phones over USB, iOS simulators, Android emulators, and cloud device farms. Use the [MobAI desktop app](https://mobai.run) or [MobAI CLI](https://mobai.run/cli) to access devices locally or through remote hosts. Run tests across multiple devices, keep failed sessions alive for debugging, and publish results to the [MobAI testing dashboard](https://mobai.run/testing).

- **Physical devices on macOS, Linux, and Windows.** Test on real iPhones and Android phones over USB.
- **Simulators and emulators.** Run tests on iOS simulators and Android emulators through local or remote MobAI hosts.
- **Device farms built in.** Run on BrowserStack, Sauce Labs, and AWS Device Farm, or connect to devices exposed by another MobAI host.
- **Inspect failures on the device.** Hold a failed session at the exact screen where the test stopped, then open it in the MobAI desktop app.
- **Full run history.** Send results, screenshots, videos, and device logs to the MobAI testing dashboard.
- **Fast, reliable test execution.** Run test files in parallel across devices, with configurable waits for UI transitions and screen updates.

Physical devices, local testing, and single-device runs work on the Free plan. Parallel devices, device farms, devices on other hosts, dashboard uploads, and hold-on-failure require Pro.

## Quick start

```bash
npm install -D e2e @mobai-app/e2e
```

Configure iOS and Android targets:

```ts
// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { mobai, mobaiReporter } from '@mobai-app/e2e';

export default {
  targets: [
    {
      name: 'iphone',
      engine: mobai({ platform: 'ios' }),
      app: { bundleId: 'com.example.app' },
    },
    {
      name: 'pixel',
      engine: mobai({ platform: 'android' }),
      app: { bundleId: 'com.example.app' },
    },
  ],
  reporters: ['list', mobaiReporter()], // Pro: dashboard uploads
} satisfies E2EConfig;
```

Write tests using the standard `e2e` API:

```ts
// tests/login.e2e.ts
import { expect, test } from 'e2e';

test('signs in', async ({ app, screen }) => {
  await app.open();
  await screen.getByTestId('email').fill('me@example.com');
  await screen.getByRole('button', { name: 'Continue' }).tap();
  await expect(screen.getByText('Welcome')).toBeVisible();
});
```

The engine connects to a running MobAI host, or starts one when needed. No separate host setup is required for local runs.

## Choose where tests run

MobAI discovers the devices available to the host, including:

- Physical iOS and Android devices connected over USB
- iOS simulators and Android emulators
- Devices attached to other MobAI hosts, including remote machines
- BrowserStack, Sauce Labs, and AWS Device Farm devices

Select devices by name or ID:

```ts
mobai({ platform: 'ios', device: 'iPhone 17' });                 // one device
mobai({ platform: 'ios', device: ['iPhone 17', 'iPhone Air'] }); // selected devices
mobai({ platform: 'ios' });                                      // all available iOS devices
```

When multiple devices are selected, `e2e` runs test files in parallel, one test file per device at a time. Parallel execution requires Pro. The Free plan runs on one device at a time.

### Run on a device farm

Provision a device for the duration of the run:

```ts
engine: mobai({
  platform: 'ios',
  cloud: {
    provider: 'browserstack',
    device: 'iPhone 15 Pro',
    os: '17',
  },
}),
```

Supported `provider` values are `'browserstack'`, `'saucelabs'`, and `'awsdevicefarm'`. Use device and OS names from the provider's catalog.

The app comes from the target's `.ipa` or `.apk`, unless you set `cloud.app` to a local build or an uploaded app reference (`bs://...`, `storage:...`, or `arn:...`). Set `virtual: true` to use the provider's simulators or emulators. Pass provider-specific capabilities through `options`. A list of cloud configurations opens one device per entry.

The MobAI host reads provider credentials from its environment:

| Provider | Environment variables |
| --- | --- |
| BrowserStack | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| Sauce Labs | `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`, optional `SAUCE_REGION` |
| AWS Device Farm | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

If a farm device is already saved in the MobAI app, select it directly using `device`, e.g. `'browserstack:iPhone_15:17'`.

Device farm support requires Pro.

### Use devices on another host

Devices exposed by another MobAI host on your network or tailnet appear alongside local devices.

On a machine that hasn't run the MobAI app, specify remote hosts with:

```bash
MOBAI_NODES=mac-mini=<token>,10.0.0.5:8686=<token>
```

You can also connect to a specific host with the `baseUrl` and `localApiToken` engine options.

Devices on other hosts require Pro.

## Debug failures without losing device state

### Hold the device on failure

Instead of tearing down a failed session, MobAI can leave the device on the screen where the test stopped:

```ts
engine: mobai({ platform: 'ios', holdOnFailure: '10m' }),
reporters: ['list', mobaiReporter()],
```

Open the held device in the MobAI desktop app under **CI Devices** to inspect the failed test, step, and error. Release it manually, or let the hold expire after the configured period of inactivity. The run summary shows which devices are held, or why none could be held.

`holdOnFailure` accepts seconds or duration strings such as `'90s'`, `'10m'`, and `'1h'`, up to two hours. It requires Pro and `mobaiReporter()` in your reporter configuration. You can also set it through `MOBAI_E2E_HOLD`.

### Publish results to the testing dashboard

`mobaiReporter()` uploads test runs to the [MobAI testing dashboard](https://mobai.run/testing), including screenshots, videos, and captured device logs.

```ts
reporters: ['list', mobaiReporter({
  apiKey: process.env.MOBAI_API_KEY,
  projectId: '<project id>',
})],
```

The API key defaults to `MOBAI_API_KEY`. The project ID defaults to `MOBAI_PROJECT_ID`, then to the project recorded in `mobai.json`. Linking a project in the MobAI app creates `mobai.json`. Commit that file so the reporter can find the project automatically.

Dashboard uploads require a Pro API key and a linked project.

### Capture device logs

Enable logs for each test:

```ts
engine: mobai({ platform: 'ios', deviceLogs: true }),
```

MobAI collects warnings and errors from iOS syslog, simulator logs, or Android logcat. Entries are attached to the step that was running when they occurred. The reporter uploads captured logs with failed tests.

Use `deviceLogs: { process, level }` to filter the output. On iOS, `process` is the app's executable name. On Android, it's a log tag. Supported levels are `'error'`, `'warning'`, and `'info'`.

## Control the device from tests

Alongside `app` and `screen`, `@mobai-app/e2e` provides a `device` fixture for device-level actions: installing apps, changing system settings, gestures, permissions, and more.

Create a typed fixture once:

```ts
// tests/fixtures.ts
import { test as base } from 'e2e';
import type { Device } from '@mobai-app/e2e';

export const test = base.extend<{ device: Device }>();
export { expect } from 'e2e';
```

Then use it in tests:

```ts
// tests/settings.e2e.ts
import { expect, test } from './fixtures';

test('dark mode', async ({ app, device, screen }) => {
  await device.setAppearance('dark');
  await app.open();
  await expect(screen.getByText('Settings')).toBeVisible();
});
```

### Device API

| Method | Description |
| --- | --- |
| `installApp(path?)` | Install an `.app`, `.ipa`, or `.apk` (defaults to the target's `app.appPath`) |
| `openApp(app, { relaunch?, launchArguments?, launchEnvironment? })` | Bring an app to the foreground, or restart it with this launch's arguments and environment variables (environment: iOS) |
| `closeApp(app?)` | Close an app |
| `clearAppState(app?)` | Erase app data |
| `clearKeychain()` | Clear the keychain (iOS simulators) |
| `openLink(url, { app? })` | Open a deep link or URL |
| `foregroundApp()` | Get the foreground app |
| `installedApps()` | List installed apps with bundle ID, name, and version |
| `home()`, `back()` | Go home or back |
| `dismissKeyboard()` | Dismiss the keyboard |
| `clipboard()`, `setClipboard(text)` | Read or write clipboard text |
| `setLocation({ latitude, longitude })`, `clearLocation()` | Set or clear the simulated location |
| `setAppearance('light' \| 'dark')` | Change appearance |
| `setOrientation(orientation)` | Rotate the device |
| `fold(pose)` | Change a foldable's pose: `'closed'`, `'half-open'`, or `'open'` |
| `alert('accept' \| 'dismiss')` | Respond to a system alert |
| `setPermission(name, 'grant' \| 'deny' \| 'reset')` | Set app permissions (not on physical iPhones) |
| `setNetwork('online' \| 'offline')`, `setAirplaneMode(on)` | Control network state (Android) |
| `setBiometrics(sensor, 'match' \| 'nonmatch')` | Simulate a biometric match or mismatch (not on physical iPhones) |
| `enrollBiometrics(sensor, enrolled)` | Enroll or clear biometrics (iOS simulators) |
| `drag(points)` | Drag a finger along a path |
| `pinch(scale, { at? })` | Pinch to zoom (above 1 zooms in, below 1 zooms out) |
| `twoFingerTap(at?)` | Tap with two fingers |
| `collectList(list?)` | Scroll to the end of a list and collect row text |
| `siri(command)` | Send a Siri command and return the response (iOS) |
| `locator(selector)` | Create a locator using MobAI syntax, e.g. `id=login` or `text~=Sign` |

The `at` argument accepts a locator (its center is used) or a screen point. Coordinates can be absolute screen points or percentages.

Each point of a drag path can set `durationMs` (300 ms by default) and `holdMs`:

```ts
await device.drag([
  { x: 2, y: '50%' },
  { x: '40%', y: '50%', durationMs: 400, holdMs: 200 },
  { x: '90%', y: '50%', durationMs: 150 },
]);
```

To assert that an action actually changed the screen:

```ts
await expect(device).toChangeScreen(() => screen.getByText('Continue').tap());
```

If the selected device doesn't support a requested operation, the method throws `UNSUPPORTED_CAPABILITY`.

### Supported `e2e` features

The engine supports all `screen` queries and locator actions except `hover`, `secondaryTap`, and `setInputFiles`. It also supports keyboard input, `app.open()`, `app.restart()`, `app.clearState()`, screenshots with secure fields masked, and video recording.

`selectOption` works with iOS picker wheels and Android number pickers.

## Host and CI setup

The engine uses a local or remote MobAI host. It connects to the [MobAI desktop app](https://mobai.run) if it is running. Otherwise, it uses `mobai serve` from the [MobAI CLI](https://mobai.run/cli). With `autoStart` enabled (the default), the engine starts a host automatically when none is available.

In CI, set `MOBAI_API_KEY` so the host can use your MobAI plan without an interactive sign-in.

### Engine options

| Option | Default | Description |
| --- | --- | --- |
| `platform` | Required | `'ios'` or `'android'` |
| `device` | All devices on the platform | Device name, ID, or array of names or IDs |
| `apiKey` | `MOBAI_API_KEY` | API key for a host started by the engine |
| `baseUrl` | `http://127.0.0.1:8686` (`MOBAI_HOST_URL`) | Address of a MobAI host |
| `localApiToken` | `MOBAI_LOCAL_API_TOKEN` | API token for a host on another machine |
| `autoStart` | `true` | Start `mobai serve` if no host is running |
| `deviceLogs` | Off | Capture device logs for each test, optionally filtered by `process` and `level` |
| `holdOnFailure` | Off (`MOBAI_E2E_HOLD`) | Keep the failed device session open for inspection |
| `cloud` | None | Request a session from a supported device farm |
| `transition` | `500` | Milliseconds to let a control introduced by the previous action settle before acting on it |
| `settle` | `150` | Milliseconds after an agent action before the next screen inspection, or `false` |
| `keyboardNodes` | `false` | Include soft-keyboard keys in the screen tree |
| `launchEnvironment` | None | Environment variables for every fresh launch of the target's app (iOS), as `app.launchArguments` are for arguments |

## Run tests from the MobAI editor

The MobAI desktop app recognizes `*.e2e.ts` files alongside `.mob` tests. Run a test on the device selected in the app, and the result appears in **Local runs**.

## License

[Apache 2.0](LICENSE)
