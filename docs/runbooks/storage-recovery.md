# P4 checkpoint verification

Run `pnpm dev` and open two independent regular browser profiles at <http://127.0.0.1:5173>. Create/join/approve, independently compare and confirm both pairing codes, then offer files. The receiver reviews free-space warnings and chooses its retention policy before accepting.

Pause after some committed bytes, then reload/close and reopen the receiver on the same origin/profile. Saved transfers rehashes surviving OPFS blocks against the ledger and shows verified bytes/ranges. This works without the sender online. Room credentials are intentionally lost; a checkpoint is not a reconnected session. Network resume is P5. Clear site data or use another origin/profile and the old checkpoint will not be available.

Completed files can be exported after reopen with full checksum verification. The source browser retains a manifest only; after reload, use Reselect source to check the original file. A wrong same-size file must fail. Delete saved removes the scoped bytes and metadata; reload again to verify removal. Cancel/Clear transfer removes live partial data. Retained data expires on the next startup/check after its deadline. Save important copies outside the browser because eviction and user-cleared data cannot be recovered.

## Automated checks

```sh
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
```

`tests/storage/crash-consistency.spec.ts` terminates real browser workers after write, after digest, after flush and before/after ledger commit, then reopens and rehashes. It also covers actual IDB transaction abort, a deterministic quota error, corruption/missing files, exclusive locks, retention expiry/discard and scoped orphan cleanup. Runtime browser tests cover export/reselection/reload and quota pause/retry on desktop/mobile viewports. Fault hooks exist only in test harnesses or dependency injection; there is no URL/peer switch to enable them in the app.

The expanded local transfer cases use separate simulated client-address buckets per case, while both peers in each case share one bucket. This keeps unrelated cases from exhausting the Worker's per-IP limit; rate-limit denial remains covered by integration tests. Production limits are unchanged. Cloudflare normally supplies the [client-address header](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip) at its edge.

## Required 300 MiB demonstration

With `pnpm dev` running and several GiB free:

```sh
pnpm bench:p4
```

The script creates a varied deterministic 384 MiB fixture on disk, transfers at least 300 MiB over WebRTC between isolated browser contexts, pauses, closes the sender context and **the entire browser process**, and opens a fresh receiver process with the same persistent profile. It checks restored verified ranges/bytes without a sender or any signaling request. An independent Node streaming prefix hash must match the reopened OPFS prefix hash. The partial file is not exposed as a completed download. Explicit deletion is verified across another reload.

Reviewed reports/screenshots remain in ignored `.meshdrop-artifacts/phase-4-storage`; successful fixtures/profiles are removed. The test uses the same isolated-process Chromium mDNS compatibility flag documented for P3 on this Linux host; application defaults remain unchanged. Results demonstrate the tested desktop browser, not physical Android/iPhone/Windows/Mac coverage or hardware power-loss durability. P3's 100 MiB/1 GiB correctness/memory regression remains available through `pnpm bench:p3`.
