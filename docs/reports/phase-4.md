# MeshDrop Phase 4 report — crash-safe local file storage

Date: 2026-10-17. Source of truth: P4.1–P4.6 and the strict P4 exit gate in the supplied phase-wise plan, together with the architecture's receiver-owned checkpoint boundary. P0–P3 remain available. Work stays local and uncommitted for the user's review; no GitHub push, cloud deployment or submission action was performed.

**Delivery:** persistent receiver storage with conservative restart reconciliation, quota pause/retry, retention/cleanup, saved-file export and exact source reselection. The mandatory live demonstration restored **314,572,800 bytes (300 MiB)** after all transfer browser processes closed, with independently matching SHA-256 and no signaling or further file transfer after reopen. Network reconnect/resume remains P5.

## What was implemented

| Plan ticket | Delivered behavior                                                                                                                                                          | Main implementation                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P4.1        | Typed prepare/write/read/commit/finalize/purge/close receiver interface; capacity, checkpoint, retention and error contracts                                                | `packages/storage/src/ReceiverStore.ts`                    |
| P4.2        | Worker-only OPFS partial files isolated by validated transfer/file UUID and local storage UUID; exact offsets and lengths; exclusive store locks                            | `OpfsReceiverStore.ts`, `locks.ts`                         |
| P4.3        | IndexedDB v1 manifests, block/digest rows, transfer state/timestamps/receipt and source manifests; derived compact verified ranges                                          | `CheckpointDB.ts`, `LedgerReconciler.ts`                   |
| P4.4        | Write → readback SHA-256 → flush → strict ledger transaction completion → ACK; startup rehash, conservative crash-window reconciliation and deletion tombstones             | Store/reconciler, transfer worker and `TransferMachine.ts` |
| P4.5        | Estimated-capacity margin, unknown/large-file/eviction warnings, persistence request, storage-full pause without false ACK, retry and explicit 24-hour/7-day/discard policy | `QuotaManager.ts`, receiver UI, saved transfers UI         |
| P4.6        | Retained source manifests with name/size/full-hash reselection; finalized, file-backed downloads after live transfer or restart, without requiring a save picker            | `SaveAdapters.ts`, `StorageClient.ts`, recovery worker/UI  |

The storage package is independent of React and the server. The live P3 worker now delegates to `OpfsReceiverStore`; it no longer advances a volatile-only frontier. Binary framing, signed peer controls, consent, negotiated bounds, one-block flow control and terminal receipt semantics remain compatible. The receiver persists completed receipt state after processing its acknowledgement and before showing success.

IndexedDB transactions resolve only at completion and request strict durability. OPFS and IDB are still separate stores: a crash before ledger commit cannot turn orphan bytes into confirmed progress, while a crash after ledger commit but before ACK can leave a recoverable block the sender has not counted. Startup checks the stored manifest digest, rereads and rehashes ledger-backed blocks, discards missing/corrupt/out-of-bounds rows and trims uncommitted tails. Complete files also need full manifest SHA-256 before export. Exclusive Web Locks stop competing tabs from reopening or deleting an active transfer.

## User workflow

1. Create/join/approve a room and independently compare/confirm both pairing codes. The owner selects and offers files as in P3.
2. The receiver reviews capacity/eviction warnings, chooses retention, then accepts. Only verified, flushed, ledger-committed blocks advance progress.
3. If storage fills, the current block gets no ACK. Earlier committed blocks stay valid. Free space and choose Retry storage to commit the pending block and release the flow pause. Cancel explicitly deletes scoped data.
4. Reload or close/reopen on the same origin/profile. Saved transfers rehashes surviving bytes and shows verified byte counts/ranges. It does not recreate room credentials or reconnect the sender.
5. Export only fully revalidated individual files; an interrupted checkpoint is never presented as a completed transfer. Delete saved removes scoped bytes/metadata and remains deleted after another reload.
6. On the source browser, reopen the retained manifest and reselect the original file. A same-name/same-size wrong file fails full SHA-256. Matched access remains in the page's worker session; P5 will use renewed source access for network resume.

Retain interrupted files defaults to 24 hours after the last committed block; 7 days and discard are explicit alternatives. Completed browser copies share the selected expiry. Cleanup happens on the next startup/check, not in a background service. Source manifests default to 24 hours and can be forgotten separately. Exported downloads are outside application cleanup. Legacy P3 temporary data has no durable ledger and is not silently migrated or deleted on P4 startup.

## Mandatory 300 MiB exit gate

The final run used actual WebRTC between isolated owner/receiver contexts, a disk-backed persistent receiver profile and Chromium 156.0.8078.4 on the supplied Linux laptop. A deterministic varied **384 MiB** fixture was paused after exactly 300 committed 1 MiB blocks. The owner context and entire transfer browser process closed. A fresh receiver process reopened the same profile while no sender remained online.

| Measurement                                   | Result                  |
| --------------------------------------------- | ----------------------- |
| Source fixture                                | 402,653,184 B (384 MiB) |
| Confirmed before closing                      | 314,572,800 B (300 MiB) |
| Reopened, rehashed checkpoint                 | 314,572,800 B           |
| Verified inclusive ranges                     | `[[0,299]]`             |
| Schema / logical block                        | Version 1 / 1,048,576 B |
| Reopen + UI rehash time                       | 5,074 ms                |
| Signaling requests after reopen               | 0                       |
| Additional transferred file bytes             | 0                       |
| Node prefix hash vs reopened OPFS prefix hash | Exact match             |
| Partial file offered as completed download    | No                      |
| Explicit deletion survived another reload     | Yes                     |

Exact 300 MiB prefix SHA-256:

```text
2114245cd64cd1ad3a4c3ddaa90e5d3e615a5fd24eaed4f6f7efb3e50d3cf881
```

This verifies the retained **prefix**, not successful completion of the entire 384 MiB file. The page/assets still need to load; zero signaling requests is not a claim of an offline-installable PWA. Browser API commits/reopening are not a physical power-loss or eviction guarantee.

Evidence: [restart metrics/checkpoint](evidence/phase-4-storage.json), [before browser close](evidence/phase-4-before-close.png) and [fresh-process checkpoint](evidence/phase-4-after-reopen.png).

## 1 GiB streaming regression

The existing P3 correctness/memory harness also passed against the P4 ledger-backed engine, using two isolated persistent Chromium processes. Both 100 MiB and 1 GiB downloaded files matched their independent Node streaming SHA-256 and receipt digests, with visible intermediate committed progress.

| Measurement                              | 100 MiB                    | 1 GiB                      |
| ---------------------------------------- | -------------------------- | -------------------------- |
| Download/receipt full SHA-256            | Exact match                | Exact match                |
| Measured transfer/verification duration  | 18.114 s                   | 152.716 s                  |
| Baseline page/worker JS + backing stores | 34,276,017 B               | 53,440,757 B               |
| Peak page/worker JS + backing stores     | 176,813,548 B (168.62 MiB) | 259,436,207 B (247.42 MiB) |
| Sender channel peak                      | 524,288 B                  | 524,288 B                  |
| Source/receiver logical block            | 1,048,576 B each           | 1,048,576 B each           |
| Receiver adapter queue peak              | 16,384 B                   | 16,384 B                   |
| Worker samples                           | 133                        | 1,157                      |

The fixed combined JavaScript budget remains 256 MiB. Sampling covers both page isolates and dedicated workers every 500 ms without forced GC, including ArrayBuffer/external-string backing stores. This is sampled JavaScript-owned memory for the tested workload, not total browser RSS, OS file cache, native WebRTC memory or a mathematical between-sample maximum. Additional hash readback buffers/ledger metadata are bounded by the selected block and manifest limits. Timing is local-test evidence, not public-network throughput certification.

Evidence: [streaming metrics and progress](evidence/phase-4-streaming-regression.json), [1 GiB completion](evidence/phase-4-1gib.png) and [1 GiB receipt](evidence/phase-4-1gib-receipt.json). The reused JSON retains its original `P3` gate label; it was run against the delivered P4 source.

## Complete validation

The final complete `pnpm check` passed from a fresh source copy without private environment files or preinstalled dependencies, following a frozen offline install. All 107 application/package/test/script source files and seven root configuration/lock files matched the delivered workspace. **374 automated tests passed** (275 unit + 39 integration + 8 faults + 52 browser/storage), with no retries. The separate 300 MiB restart and 100 MiB/1 GiB streaming gates also passed.

| Gate                                                 | Result                |
| ---------------------------------------------------- | --------------------- |
| Frozen offline installation                          | Passed                |
| All package/root strict TypeScript, ESLint, Prettier | Passed                |
| Environment/secret guard                             | Passed                |
| Unit tests                                           | 275 passed            |
| Worker/SQLite integration tests                      | 39 passed             |
| Lifecycle fault tests                                | 8 passed              |
| Browser acceptance/storage tests                     | 52 passed, no retries |
| Web build + Worker dry run                           | Passed                |
| Required >=300 MiB receive/close/reopen              | Passed                |
| P3 100 MiB/1 GiB hash and memory regression          | Passed                |

`tests/storage/crash-consistency.spec.ts` kills real browser workers after write, after digest, after flush and before/after metadata commit. It verifies restored ranges again after a page reload. The after-ledger case preserves the committed block despite losing its return/ACK eligibility; earlier windows preserve only the previous committed block. A separate actual IDB transaction abort rolls back both block and transfer writes. Missing files, changed blocks, orphan ledger entries, retention/discard, unrelated-origin-file preservation and second-tab exclusive access have browser coverage.

Quota coverage injects a real `QuotaExceededError` at the browser worker write boundary, avoiding filling the user's disk. The engine pauses with the earlier 1 MiB intact and completes the two-block file after retry. This tests error handling, not a claim that physical storage exhaustion was forced. Reopen/export tests download and hash exact bytes, restore receipt state, reject a wrong same-size source and verify the correct full source SHA-256. Desktop and explicit Pixel 7 viewport cases are included. P0–P3 regressions remain in the full gate.

The expanded localhost suite initially shared one per-IP request bucket across unrelated cases. The transfer-test helper now supplies a distinct documentation IPv6 address per case; both peers in a case still share that address. This models the Cloudflare client-address header only in local tests. Application limits are unchanged, and integration tests still verify denial/rate enforcement. The final full run completed normally without test retries.

The browser matrix uses Chromium, Firefox and WebKit engines on Linux. WebKit uses a fresh persistent test profile because private mode denies usable OPFS on this host. Compatibility libraries are isolated under `/tmp`; supported Ubuntu CI installs browser dependencies normally. The large-file/restart harnesses use the documented test-only Chromium mDNS compatibility flag; application defaults are unchanged. These engine/viewport tests do not replace physical Android/iPhone/Windows/Mac validation. The phone stayed disconnected, and no phone test is claimed for P4. Hosted CI has not run because nothing was pushed.

Evidence: [frozen offline install](evidence/phase-4-install.txt), [complete clean gate](evidence/phase-4-checks.txt), [desktop reopened export](evidence/phase-4-reopened-desktop.png), [mobile reopened export](evidence/phase-4-reopened-mobile.png), [desktop quota retry](evidence/phase-4-quota-retry-desktop.png), [mobile quota retry](evidence/phase-4-quota-retry-mobile.png), [Firefox](evidence/phase-4-firefox.png) and [WebKit](evidence/phase-4-webkit.png).

## Security and documentation

No new static provider key is needed. Static secrets remain in ignored `apps/signaling/.env` with private permissions; `.env`/variants and `.dev.vars`/variants remain ignored at every depth. Only empty-secret `.env.example` templates may be tracked. The local database stores no room/invitation capability, socket ticket, TURN shared secret or ephemeral private key. Data and metadata remain origin-private and are not an encrypted vault against a compromised origin/profile.

Validated UUID namespaces and basename-only exports prevent peer labels from escaping destinations. Scoped deletion tombstones support cleanup retry after a crash and orphan collection rechecks the ledger under the same exclusive lock. Failed cleanup stays visible rather than falsely clearing the live transfer. Browser storage errors shown to users do not contain OS paths or raw file data. Test fault hooks exist only in dependency injection/test harnesses, with no remotely enabled product switch. Ignored artifacts hold generated fixtures/profiles; reports retain only reviewed synthetic data and screenshots.

README, storage ADR, protocol/engineering note, runbooks, threat model, secret documentation and benchmark instructions were updated. The [P4 contract](../protocol/storage-p4.md) documents schema, ACK ordering, crash windows and boundaries in detail.

## Reproduce and handoff to P5

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
pnpm dev
# In a second terminal, with several GiB free:
pnpm bench:p4
pnpm bench:p3
```

See the [storage runbook](../runbooks/storage-recovery.md). No cloud account or shared provider secret is required for local direct tests. Keep the same origin/profile when checking saved data. P5 must authenticate returning peers, bind resume to the correct manifest/epoch, revalidate checkpoint ranges and request only missing/corrupt blocks. P4 does not implement that handshake, automatic reconnect, missing-range transport or long-term identity recovery.

Remaining limits: browser quota/eviction, user-cleared site data, denied APIs/private modes, local-profile compromise, background suspension, physical power loss, public hostile-network performance, the remaining hardware/browser matrix and file sizes above the tested 1 GiB. Generic save-picker/direct-save integration is not assumed. A locally stored digest/receipt cannot attest that a malicious remote peer saved data.

## Commit command

From the repository root after reviewing the changes:

```sh
git add .
git commit -m "feat: implement phase 4 crash-safe local storage and checkpoints"
```

No `git push` is included or performed.
