# P2 connectivity verification

Run `pnpm dev`, then open two independent browser profiles at <http://127.0.0.1:5173>. Create/join/approve a room. Both peer cards must become connected and display the same code. Use a separate trusted channel to compare it. Enter the code and select the independent-comparison checkbox to verify locally. Exchange signed pings in both directions and check replies. Restart ICE, then request a new peer connection: epochs advance, codes change and verification resets. Revocation must close both peer cards. A wrong code must show mismatch and close the channel.

## Automated local gates

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
```

The suite includes Chromium/Firefox and Chromium/WebKit pairs, Chromium mobile viewport checks, real RTC timeout, replay/mismatch/restart tests, actual Worker/SQLite epoch authorization and coturn credential contracts. Linux WebKit is additional engine coverage, not physical Safari-on-iPhone evidence. Unsupported Linux distributions may need matching browser compatibility libraries; Ubuntu CI installs the supported dependencies. Never replace incompatible shared libraries in `/usr/lib` to make tests run.

## Physical Android

Enable USB debugging and authorize this laptop on the unlocked device. Connect the phone to the same Wi-Fi as the laptop for the direct-path test. With Chrome open:

```sh
adb devices -l
adb -s YOUR_SERIAL reverse tcp:5173 tcp:5173
adb -s YOUR_SERIAL shell am start -a android.intent.action.VIEW -d http://127.0.0.1:5173 -p com.android.chrome
adb -s YOUR_SERIAL forward tcp:9223 localabstract:chrome_devtools_remote
node scripts/local-dev/verify-android.mjs
```

The script creates a dedicated Chrome test tab and closes only that tab. It tests signed hello/ping/pong, code comparison, ICE restart, receiver-requested fresh connection and revocation. Output defaults to `/tmp/meshdrop-p2-android` (`MESHDROP_EVIDENCE_DIR` overrides). Signaling uses USB port forwarding; WebRTC selects its network path independently. Same Wi-Fi is not a guarantee against AP isolation. Keep the phone awake; background/mobile policies are P7. Remove the task's forwards when finished:

```sh
adb -s YOUR_SERIAL forward --remove tcp:9223
adb -s YOUR_SERIAL reverse --remove tcp:5173
```

## Optional real TURN relay test

Production relay requires a reachable coturn server or another deliberately implemented provider, bandwidth capacity and quotas. Configure `TURN_URLS` and a random `TURN_SHARED_SECRET` only in ignored `apps/signaling/.env`, matching coturn's TURN REST shared secret. Defaults disable TURN; direct failures then remain visible. Never put this key in Vite or committed config. Temporary browser relay credentials expire; coturn cannot immediately revoke an individual room through this shared-secret scheme.

For isolated local verification, install/build coturn outside this repository and run:

```sh
MESHDROP_TURNSERVER=/path/to/turnserver pnpm exec tsx scripts/local-dev/verify-relay.ts
```

With the Vite dev server running, this script starts coturn on loopback port 13478 with relay ports 13500–13520, a generated secret in a private `/tmp/meshdrop-p2-relay/.env`, short allocation limits and tiny quotas. It uses actual Worker admission/temporary credentials/signaling, two real browser `PeerSession`s with `iceTransportPolicy: relay`, and confirms relay selection and signed ping/pong. It stops the relay afterward. The loopback-peers exception is only for this isolated test and must never become production relay configuration. Output is sanitized JSON, no secrets/addresses. This proves relay transport, not a restrictive external-network or cellular deployment.
