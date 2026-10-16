# P3 file-transfer verification

Run `pnpm dev` and open <http://127.0.0.1:5173> in two independent regular browser profiles. Create/join/approve the room. Independently compare and confirm the code on **both** devices. The owner selects files and clicks Offer files; confirmed progress remains zero while the receiver considers the offer. The receiver chooses Accept files to prepare temporary browser storage. Verify visible committed bytes, final SHA-256 values and successful receipt on both devices. Save each received file and receipt, then Clear transfer to remove temporary browser data. A completed file can still be saved after room revocation.

Pause/resume/cancel and decline are real protocol actions. An in-flight block may finish after pause. Corrupt, incomplete, refused or cancelled transfers must never show completion or expose partial downloads. Private browsing/browser mode may deny OPFS even when the API exists; use a regular supported browser and check free disk space. Storage failure must remain visible, with no false ACK.

## Normal gates

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
```

The suite includes exact 0 B/1 B/17 KiB downloads, Firefox and WebKit file transfer, explicit mobile viewport cases, storage-commit barriers, corruption, pause/cancel/decline, terminal retry/idempotency, bounded frame queues and all P0–P2 regressions. Linux WebKit's private context cannot open OPFS in this environment; its file test uses a fresh persistent test profile and removes it afterward. These engine/viewport tests do not certify physical Safari/iPhone or Android file transfer.

## Mandatory large-file gate

With the development server running:

```sh
pnpm bench:p3
```

This generates independent deterministic 100 MiB and 1 GiB fixtures in `.meshdrop-artifacts/phase-3-streaming`, sends them through actual browser WebRTC channels to separate persistent on-disk Chromium profiles, downloads the result, and independently checks the full SHA-256 with Node streams. It also verifies receipt digests, intermediate committed-byte progress and the owned queue bounds. Fixtures/downloads and successful browser profiles are removed after each run; sanitized reports/screenshots/receipts remain in the ignored artifact directory. Playwright's `test-results/` cleanup does not erase them. Keep several GiB free on the workspace filesystem. Profiles/fixtures intentionally use disk rather than the `/tmp` RAM filesystem.

For a shorter local diagnostic, set `MESHDROP_BENCH_BYTES=104857600`. `MESHDROP_TEST_URL` overrides the frontend URL, and `PLAYWRIGHT_BROWSERS_PATH` can select your installed browser cache. A smaller diagnostic does not satisfy the 1 GiB exit gate.

Memory sampling uses Chromium CDP `Runtime.getHeapUsage` every 500 ms across both page isolates and their dedicated workers, including ArrayBuffer/external-string backing stores, without forcing garbage collection. It covers initial hashing and streaming. The test checks a fixed combined 256 MiB JavaScript budget, a 512 KiB send watermark, 1 MiB logical-block buffers and 2 MiB receive-queue ceiling. These are measured JavaScript/owned-buffer limits, not total browser RSS or OS cache/native-network-memory claims. The JSON contains the measured maxima and progress samples.

Two separate persistent Chromium processes need the same local mDNS compatibility flag described in P2 on this host: `--disable-features=WebRtcHideLocalIpsWithMdns`. It applies only to the isolated benchmark browsers. The application preserves browser default privacy/network policy. This is a local correctness/memory test, not a public-relay, hostile-NAT, cellular, throughput recommendation or cross-device performance promise.

No source fixtures, browser profiles or secrets belong in Git. Copy only the sanitized report and selected screenshots into `docs/reports/evidence` after reviewing them. `.env` and all provider keys remain ignored. The complete contract is [transfer-p3.md](../protocol/transfer-p3.md).
