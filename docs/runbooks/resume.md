# Resume verification and operation

Use a regular supported browser, the same origin/profile for receiver data, and keep both peers online. The owner must still have the exact source. Receiver retention must be 24 hours or 7 days; discard intentionally prevents recovery.

## Live interruption

1. Pair/approve and compare both codes. Offer/accept a file and wait for several committed blocks.
2. Pause or interrupt the connection. Connection changes stop the old transfer attempt without deleting retained checkpoints. Automatic retry starts with ICE restart and falls back to a fresh connection, capped at five attempts. Retry connection resets that budget manually.
3. Compare and confirm the new code on both devices. On the owner choose **Prepare original source**. Wait for Source ready.
4. On the receiver choose **Resume saved transfer**. Observe revalidation, source proof comparison, reused bytes and payload sent this attempt. Only missing/invalid blocks travel again.
5. Save the completed file and receipt. Verify the complete SHA-256 independently. Cancel transfer/Clear transfer/Delete saved are explicit local deletion actions, distinct from retry.

## Reload, missing source or expired admission

Reload loses memory-only room credentials. Create a fresh invitation, join/approve again and compare both codes. On the owner, Saved transfers lists the retained source manifest. Reselect every original file, then choose **Prepare source …**. Same-name/same-size changed bytes fail full SHA-256. On the receiver choose **Resume saved …** from its rehashed checkpoint, after the sender is ready. Trying earlier shows a source-required error while preserving data. A revoked or expired invitation cannot be reused to regain authority; the fresh room is required.

Use Check saved transfers after closing another tab that held the checkpoint. Storage errors or eviction may leave fewer reusable blocks. Corrupt rows are excluded; a whole missing file requires retransmitting that file. Never treat a stored byte counter or file length alone as proof. A completed individual saved file may be exported locally without any network resume.

## Automated gates

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
# With pnpm dev running (unless check manages its own test servers):
pnpm exec playwright test tests/e2e/resume.spec.ts
```

The engine fault matrix includes 0/10/50/70/95/100% interruption, delayed old-epoch ACK, exact source rejection, replayed NEED_RANGES and explicit cancellation. Chromium desktop/mobile-view cases cover real WebRTC at 10/50/70/95%, reload/new admission, unavailable/wrong source, changed stored bytes, a forged local block digest and automatic ICE-to-new-connection fallback. Storage crash-window, quota, lock, expiry and transaction-abort tests remain in the full suite. Test source patches and harness workers are not application runtime switches or production bundle dependencies.

## Required 1 GiB network migration

On Linux with unprivileged user/network namespaces and `iproute2`:

```sh
pnpm bench:p5
# Optional quick harness smoke test (does not replace the 1 GiB gate):
MESHDROP_BENCH_BYTES=20971520 pnpm bench:p5
```

No separately running dev server is needed. The guarded wrapper creates a private user/network namespace and loopback app servers, with fresh local Worker state. It refuses network mutations in the host namespace. A dummy interface initially supplies `10.90.0.2/24`. At 717 committed 1 MiB blocks of a 1 GiB file (70.01953125%, the first block boundary at/above 70%), it removes that private interface and introduces `10.91.0.2/24`. Existing host Wi-Fi, interfaces, routes, firewalls and other projects remain untouched. All test-owned servers are stopped on exit and the isolated interfaces disappear with the namespace.

Two independent persistent Chromium processes use actual WebRTC. The test asserts selected ICE candidate addresses before/after, requires a fresh epoch/comparison, records reused bytes and emitted missing-only DATA payload, downloads/hashes the final file independently, and validates the receipt. Successful runs remove their fixture/download/browser profiles and retain JSON, receipt and screenshots under ignored `.meshdrop-artifacts/phase-5-resume/run-*`. Failed runs retain diagnostic artifacts for inspection; delete only the relevant test run's profiles/fixtures after review. Leave several GiB free.

The test-only Chromium mDNS compatibility flag is documented in the report; application defaults are unchanged. Controlled Linux subnet migration does not replace physical Wi-Fi/mobile roaming, hostile public NAT/TURN, Android/iOS or Windows/Mac testing. No physical phone is needed for this local gate. Resume is foreground work and both peers must stay available. The final report records the exact performed workload and limits.

On an unsupported Arch host, temporary Ubuntu libraries under `/tmp` may be needed for the existing WebKit regression, with `LD_LIBRARY_PATH` set and the cached MiniBrowser wrapper preserving it. This is local tooling only; supported Ubuntu CI uses Playwright's standard `--with-deps` installation. Do not install Arch-incompatible system packages for this workaround.
