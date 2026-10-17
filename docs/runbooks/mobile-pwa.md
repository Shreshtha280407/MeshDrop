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

## Manual physical gates

For each physical browser, record OS/browser version, usable storage results, quota estimate, export route, tested size and result. Start with a small file, then a larger file appropriate to available space. Confirm actual destination bytes after the native save/share flow, not just a returned promise.

On iPhone Safari, test laptop-to-iPhone and reverse roles. Accept, store, verify and export a file to Files; independently compare bytes. Repeat with pause/resume if local browser storage survives. Also test Android-to-iPhone and reverse. Test Safari on macOS separately. Linux Playwright WebKit is useful engine coverage but does not establish these OS results.

Exercise screen lock, app switch, a network change and reload separately. Return both peers to the foreground. A surviving pause needs explicit Resume transfer. Lost transport requires new comparison and authenticated saved-transfer recovery; reload also requires admission and exact source reselection. Record whether storage survived rather than promising it will. Do not weaken checks when a platform cannot support a workflow: report the observed capability limit.

Test camera grant/deny/cancel, optical QR scanning, stopped camera tracks, storage permission denial, quota rejection, destination disk pressure, visible large-file warnings and dark/light touch layouts. Automated injection must be labelled separately from real OS permission or disk tests. Never fill a user's device to manufacture disk pressure.

For install/offline checks, use a production HTTPS origin or a production loopback preview with its exact origin allowlisted at the Worker. Install from the browser's menu or iOS Safari Share → Add to Home Screen. Verify standalone mode, offline shell reload and retained-file export. No closed-browser delivery is supported. No public deployment is required for local acceptance.
