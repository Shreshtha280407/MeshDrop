# Mobile and PWA verification

Run the normal [local setup](../../README.md). Use regular browser profiles over HTTPS or loopback. Keep both peers open. A regular LAN HTTP address is not a secure context on a phone; USB reverse gives an authorized Android phone access to the laptop's loopback preview.

## Automated checks

```sh
pnpm check
pnpm bench:p7
pnpm test:pwa
```

`pnpm check` includes all earlier phase tests, mobile hardening and production PWA acceptance. `bench:p7` runs focused mobile browser checks and the PWA suite. These are browser-engine/viewport checks, not a substitute for physical iPhone/Safari results. PWA checks start separate local servers on 4173/8788, isolate Worker persistence, build real production assets and test a real service worker. The update test temporarily changes only ignored build output and restores it in `finally`. It runs serially. No test deploys anything.

The production offline scenario transfers 5 MiB, verifies it, revokes the room, takes the receiver offline, reloads the cached shell, revalidates the checkpoint and downloads matching bytes. Cache inspection confirms only public shell assets. Native export API boundary tests use mocked share/picker responses to verify transient activation, cancellation and bytes; they do not claim actual OS share-sheet behavior.

## Authorized Android device

Enable USB debugging on the unlocked test device, accept the laptop authorization, connect to the same Wi-Fi as the laptop and leave Chrome open. Use the actual serial shown by `adb devices`; do not copy another user's serial.

```sh
adb devices -l
adb -s YOUR_SERIAL reverse tcp:5173 tcp:5173
adb -s YOUR_SERIAL forward tcp:9223 localabstract:chrome_devtools_remote
adb -s YOUR_SERIAL shell am start -n com.android.chrome/com.google.android.apps.chrome.Main
MESHDROP_ANDROID_SERIAL=YOUR_SERIAL \
MESHDROP_MOBILE_INTERRUPTION=1 \
MESHDROP_MOBILE_LARGE=1 \
node scripts/local-dev/verify-mobile.mjs
```

Keep `pnpm dev` running. The script creates only its own phone tab, never enumerates personal tabs, uses synthetic files and writes evidence to `/tmp/meshdrop-p7-android` by default. `MESHDROP_EVIDENCE_DIR` can change this destination. Its scoped CDP transport attaches only newly created test targets, avoiding initialization of existing phone tabs. Playwright `noDefaults` preserves native Android download and focus behavior, so lifecycle observations are real. It uses the device's Chrome, not a desktop mobile viewport.

The basic test transfers 8 MiB in each direction. Android exports are read only at the exact unique synthetic filename in Downloads and pulled for independent SHA-256 verification. Desktop exports use Playwright downloads. The optional recovery test switches to Home while paused, returns, explicitly resumes and checks retained verified data after reload. The large test receives 320 MiB and asserts the extra acknowledgement before saving and hashing the actual Android download. These sizes establish observed successes, not the largest supported size. Synthetic downloads are left on the phone for review; remove only those test files when no longer needed. No personal files are read or deleted.

`MESHDROP_MOBILE_LIFECYCLE=1` adds screen sleep/wake while paused, scoped CDP offline/online injection on the actual handset, reload, renewed admission/comparison and exact source/range recovery, followed by a real camera open/stop check. This is not physical Wi-Fi roaming or a physical optical QR scan. It does not bypass a PIN/keyguard; unlock the device yourself if needed. Only the test origin's browser camera permission is temporarily overridden and restored. `MESHDROP_MOBILE_SKIP_BASIC=1` skips the two basic transfers for a focused opt-in rerun. Keep enough free space for synthetic sources, retained browser copies and exports.

## Real iPhone cloud automation on a free account

The owner authorized a free BrowserStack account. Its plan API reports `Free`.
Keep its automation username/key only in ignored
`.meshdrop-artifacts/device-cloud/.env` with mode 0600, using
`BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY`. Never paste keys in chat,
source, command arguments, screenshots or public evidence. Account signup may
require human verification in a regular browser. Closing dashboard tabs does not
stop a test runner's independent device session.

BrowserStack's verified support table currently ends at Playwright 1.63. The
project's 1.64 client failed provider initialization, so use a separate supported
client without changing application dependencies:

```sh
npm install --prefix .meshdrop-artifacts/device-cloud/tooling --no-audit --no-fund --save-exact @playwright/test@1.63.0
pnpm verify:ios
MESHDROP_CLOUD_FIXTURE_MIB=2 MESHDROP_IOS_RECOVERY=true pnpm verify:ios
MESHDROP_IOS_DIRECTION=iphone-to-laptop pnpm verify:ios
MESHDROP_IOS_DIRECTION=iphone-to-android MESHDROP_ANDROID_SERIAL=YOUR_SERIAL pnpm verify:ios
MESHDROP_IOS_DIRECTION=android-to-iphone MESHDROP_ANDROID_SERIAL=YOUR_SERIAL pnpm verify:ios
```

The runner refuses a provider plan other than `Free`, requires an exact HTTPS
origin (`MESHDROP_TEST_URL` optionally overrides the public preview), uses one
real iPhone 15 Pro Max/Safari session, requests optional provider video/visual/
network recording off, and closes its synthetic room and browsers. Provider command
processing still sees synthetic test interactions; never use personal files or
invitations. Raw provider artifacts are not public release evidence. The isolated
client uses `playwright-core` so two test-runner versions are not loaded together.

Android directions require the owner's connected, unlocked, USB-debug-authorized
phone with Chrome open. The runner waits for its Chrome debug socket, creates a
temporary forward on an unused local port, and attaches only to its own new tab
through the scoped CDP adapter. It removes that forward and closes its tab
afterward. It does not reverse-forward application traffic, inspect personal
tabs, change network settings or open unrelated files. A synthetic source may
be seeded through debugging. In the iPhone-to-Android case, the exact uniquely
named Android download is pulled for independent hashing; that 1 MiB test file
is left for review in Android Downloads.

The receive scenario defaults to 1 MiB; recovery defaults to 8 MiB.
`MESHDROP_CLOUD_FIXTURE_MIB` permits 1–8 MiB (2–8 MiB for recovery); the passing
recovery/export demonstration uses 2 MiB. Recovery presses the real Pause
control at observed committed progress, revokes the room, reloads both browsers,
rehashes the surviving checkpoint, renews admission/comparison, reselects the
original source and checks missing-only resume. It does not simulate screen
lock, physical radio handover, quota pressure or a native file picker. Reverse
direction generates a synthetic File in the real iPhone input, so it tests the
sender engine while retaining the explicit native-picker limitation.

The runner reports success only after obtaining an actual exported file and
independently hashing it. It tries the Playwright download event and the
provider's file-retrieval executor, with an authenticated WebDriver fallback
restricted to its exact test session. If these cannot return an iPhone native
download, it records `IOS_NATIVE_DOWNLOAD_NOT_OBSERVABLE` and exits nonzero even
when device transfer/recovery passed. Browser-store verification or clicking
Save does not satisfy the native export gate. Reports stay in the ignored cloud
directory; publish only reviewed evidence. The current 1 MiB receive/export and 2 MiB recovery/export pass; 8 MiB normal/recovered
exports remain unverified. All results are retained in [the evidence record](../reports/evidence/phase-7-ios-cloud.json).

Official references: [real iOS setup](https://www.browserstack.com/docs/automate/playwright/playwright-ios/nodejs),
[supported versions](https://www.browserstack.com/docs/automate/playwright/browsers-and-os),
[iOS command coverage](https://www.browserstack.com/docs/automate/playwright/references/supported-ios-commands),
[plan API](https://www.browserstack.com/docs/automate/api-reference/selenium/plan),
[native Safari capabilities](https://www.browserstack.com/docs/automate/selenium/select-browsers-and-devices),
and [download retrieval](https://www.browserstack.com/docs/automate/selenium/test-file-download).

Additional opt-in profiles reuse the same runner and plan check:

```sh
MESHDROP_CLOUD_PROFILE=ipad pnpm verify:device-cloud
MESHDROP_CLOUD_PROFILE=windows pnpm verify:device-cloud
MESHDROP_CLOUD_PROFILE=windows-chrome pnpm verify:device-cloud
MESHDROP_CLOUD_PROFILE=macos-webkit pnpm verify:device-cloud
MESHDROP_CLOUD_PROFILE=macos-safari pnpm verify:device-cloud
MESHDROP_CLOUD_PROFILE=windows MESHDROP_CLOUD_PEER=cloud pnpm verify:device-cloud
```

The iPad profile requests real iPad Pro 13 2025 hardware. Windows requests
Windows 11 Chromium; `windows-chrome` selects branded Chrome. macOS requests Tahoe Playwright WebKit, which is separate
from native Safari. The `macos-safari` profile uses native Safari through a small
W3C WebDriver adapter and the provider's documented download-retrieval executor;
no extra SDK or paid service is installed. The Windows `cloud` peer option is a network control using
two separate browser contexts on one cloud host, so it cannot certify a
laptop-to-Windows internet path. See the [additional device evidence](../reports/evidence/phase-7-device-cloud-matrix.json).

## Manual physical gates

### Task 13 isolated cloud matrix

`pnpm verify:platform-cloud` adds named, opt-in cases using the same Free-plan
guard and isolated Playwright 1.63 client. It requires both
`MESHDROP_TEST_URL` (an exact disposable HTTPS `trycloudflare.com` origin) and
`MESHDROP_DEVICE_TEST_IDENTITY` (a local JSON identity file). There is no deployed
application default for this command. Missing scope is rejected before credentials
are loaded or any browser starts.

Serve only a reviewed production build's static inventory and isolated local
signaling state, with the actual same-origin gateway/security headers. Do not put
a public tunnel in front of a workspace/Vite filesystem server, credential
directory or production Worker. Use a fresh temporary origin and disposable test
data, direct-only configuration and no production TURN/operator credentials.
The `/__meshdrop_test_identity` endpoint and local identity must agree on
`purpose=isolated-task13-test`, `sourceCommit`, `sourceDiffSha256`, `buildSha256`
and `productionApproved=false`. Both peers check the build identity. These local
fingerprints prevent accidentally testing a stale build; they are not provider
attestations or release authorization. Stop the tunnel and runtime afterward.

```sh
MESHDROP_TEST_URL=https://YOUR-TEMPORARY-HOST.trycloudflare.com \
MESHDROP_DEVICE_TEST_IDENTITY=/absolute/path/test-identity.json \
pnpm verify:platform-cloud iphone-normal iphone-recovery iphone-reverse \
  ipad-recovery ipad-reverse windows-normal windows-recovery windows-reverse \
  macos-normal macos-recovery macos-reverse
```

Each child rechecks Free, uses synthetic data, has recording disabled and owns
only its own room/session. At most two cases run concurrently. Results stay in
ignored `.meshdrop-artifacts/device-cloud/task13/`; export only reviewed sanitized
JSON. iPhone normal/recovery use 8 MiB; reverse and other targets use 2 MiB. A case
only passes after transfer completion and independently hashed exported bytes.
An iPhone export observation failure exits nonzero, even after a verified transfer.

`windows-sender-engine` is an explicit alternative control when true cross-network
reverse negotiation cannot be established. It uses two contexts on the same native
cloud Chrome host and says so in evidence. It is never cross-network proof and
does not erase the failed reverse attempt. Synthetic source injection in every
reverse case does not certify the native picker. Native macOS Safari uses the
W3C profile; Playwright WebKit remains a separate engine result.

The [Task 13 evidence](../reports/evidence/task-13-device-cloud.json) records
matching iPad/Windows/macOS exports and iPhone reverse, but both 8 MiB iPhone
download gates remain **NATIVE_EXPORT_NOT_OBSERVABLE**. Do not increase retries,
buy a provider upgrade or label a click/OPFS hash as native export verification.

For each physical browser, record OS/browser version, usable storage results, quota estimate, export route, tested size and result. Start with a small file, then a larger file appropriate to available space. Confirm actual destination bytes after the native save/share flow, not just a returned promise.

On iPhone Safari, test laptop-to-iPhone and reverse roles. Accept, store, verify and export a file to Files; independently compare bytes. Repeat with pause/resume if local browser storage survives. Also test Android-to-iPhone and reverse. Test Safari on macOS separately. Linux Playwright WebKit is useful engine coverage but does not establish these OS results.

Exercise screen lock, app switch, a network change and reload separately. Return both peers to the foreground. A surviving pause needs explicit Resume transfer. Lost transport requires new comparison and authenticated saved-transfer recovery; reload also requires admission and exact source reselection. Record whether storage survived rather than promising it will. Do not weaken checks when a platform cannot support a workflow: report the observed capability limit.

Test camera grant/deny/cancel, optical QR scanning, stopped camera tracks, storage permission denial, quota rejection, destination disk pressure, visible large-file warnings and dark/light touch layouts. Automated injection must be labelled separately from real OS permission or disk tests. Never fill a user's device to manufacture disk pressure.

For install/offline checks, use a production HTTPS origin or a production loopback preview with its exact origin allowlisted at the Worker. Install from the browser's menu or iOS Safari Share → Add to Home Screen. Verify standalone mode, offline shell reload and retained-file export. No closed-browser delivery is supported. No public deployment is required for local acceptance.
