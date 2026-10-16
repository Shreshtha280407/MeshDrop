# MeshDrop Phase 3 report — verified streaming protocol v1

Date: 2026-10-16. Source of truth: P3.1–P3.6 and the strict P3 exit gate in the supplied phase-wise plan, together with the architecture's control/data-plane boundary. Work remains local and uncommitted for the user's review. No GitHub push, deployment or submission action was performed.

**Delivery:** real, consented, memory-bounded browser file transfer with verified storage progress and terminal receipts. The mandatory **1 GiB** transfer passed independent source/download SHA-256 comparison, intermediate committed progress and the fixed memory budget. P0–P2 remain available. This phase deliberately has no crash recovery or reconnect resume; P4/P5 own those requirements.

## Implementation against the plan

| Ticket | Delivered behavior                                                                                                                                                 | Main implementation                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| P3.1   | Owner file selection, strict manifest/file UUIDs, safe normalized paths, exact totals, signed offer, explicit receiver acceptance of browser-temporary destination | `Manifest.ts`, `file-messages.ts`, `TransferPanel.tsx`       |
| P3.2   | Versioned binary DATA type 2 with explicit fragment index/count and 72-byte header; default 16 KiB total frame bounded by negotiated SCTP/message maxima           | `FrameCodec.ts`, `PeerSession.ts`                            |
| P3.3   | 1 MiB verification blocks; incremental source, block and complete stored-file SHA-256 in dedicated workers; pinned `@noble/hashes`                                 | `HashWorker.ts`, `hash-storage.worker.ts`                    |
| P3.4   | One block in flight, 512 KiB/128 KiB channel watermarks, drain event, abort/stall handling and bounded receive queue                                               | `SenderScheduler.ts`, `PeerSession.ts`                       |
| P3.5   | Exact frame assembly, duplicate/gap/bounds rejection, hash/write/flush before ACK, exact ACK validation before source confirmed progress                           | `ReceiverAssembler.ts`, `TransferMachine.ts`, storage worker |
| P3.6   | Independent pause flags, live-session resume, cancel/decline/timeouts, idempotent terminal controls, full-file readback, finalize/receipt/ACK, scoped cleanup      | `TransferMachine.ts`, `RoomClient.ts`, transfer UI           |

The engine is independent of React. The peer adapter signs controls with the authenticated room/peer/epoch/transcript and shared sequence; binary frames remain on the same reliable ordered data channel. Both local comparison and signed remote confirmation are required before transfer, followed by receiver consent for the particular manifest. File data, labels, manifests, hashes and receipts do not enter Worker routes or SQLite. The historical P0 frame fixture remains unchanged; P3's explicit fragment fields use a separate DATA type.

The temporary OPFS sink is the minimum disk-backed prerequisite for the P3 memory gate. It writes only into locally generated transfer directories and UUID file entries. Its commit frontier is volatile. No IndexedDB ledger, cross-store crash reconciliation, durable checkpoint or reopen claim is included; these remain P4.

## User workflow and behavior

1. Create/join/approve a private room, then independently compare and confirm the pairing code on both devices.
2. The owner chooses up to 16 files. Worker hashing prepares the manifest without a whole-file main-thread buffer. The receiver sees names/sizes and chooses Accept or Decline. Bytes remain unconfirmed until accepted and stored.
3. A verified/flushed 1 MiB block advances committed progress. A pause may allow the current block to finish; either participant's pause holds future work until that participant resumes. Cancel stops the transfer and removes only its temporary directory.
4. The receiver rereads each complete stored file and verifies its full SHA-256. Both sides finish the manifest-bound receipt exchange before success/download actions appear. A failed commit, corruption, incomplete file or failed finalization cannot show success.
5. Save each completed file and receipt, then Clear transfer. Completed downloads remain available after room revocation until cleared. Browser Save dialog behavior controls any collision in the user's external Downloads folder.

## Large-file exit gate

Final run: Chromium 156.0.8078.4, Linux laptop, two independent persistent on-disk profiles, real WebRTC. Run completed at `2026-10-16T17:17:32.181Z`. Fixtures contain deterministic varied nonzero data, rather than relying on sparse/zero files. Node streaming hashes independently validate the downloaded output and receipt.

| Metric                                  | 100 MiB                    | 1 GiB                      |
| --------------------------------------- | -------------------------- | -------------------------- |
| Bytes                                   | 104,857,600                | 1,073,741,824              |
| Exact source/download SHA-256           | Passed                     | Passed                     |
| Intermediate committed progress         | Observed                   | Observed                   |
| Measured transfer/verification duration | 13.805 s                   | 135.776 s                  |
| Baseline combined JS/backing storage    | 25,088,317 B               | 47,577,215 B               |
| Peak combined JS/backing storage        | 161,746,599 B (154.25 MiB) | 231,539,177 B (220.81 MiB) |
| Growth from baseline                    | 136,658,282 B              | 183,961,962 B              |
| Peak sender channel buffer              | 524,144 B                  | 524,260 B                  |
| Peak source and receiver logical block  | 1,048,576 B each           | 1,048,576 B each           |
| Peak receiver adapter queue             | 16,384 B                   | 16,384 B                   |
| Dedicated-worker samples                | 49                         | 490                        |

The fixed combined budget is 256 MiB; sender/channel budget 512 KiB; logical block budget 1 MiB each; adapter receive queue ceiling 2 MiB. CDP `Runtime.getHeapUsage` samples both page isolates and their dedicated workers every 500 ms without forced garbage collection, including ArrayBuffer/external-string backing storage and the initial source-hash period. This measures JavaScript-owned memory, **not total browser RSS, native WebRTC allocation or OS file cache**. Sampling is evidence for this tested workload, not a mathematical maximum between samples. Throughput is local-test timing, not a cross-network performance promise.

1 GiB exact SHA-256:

```text
bafa6507e9866ce146f467b7143686d3ffb3022ae1396881fb0dff0d24493bca
```

Evidence: [full large-file metrics/progress](evidence/phase-3-streaming.json), [100 MiB completion](evidence/phase-3-100mib.png), [1 GiB completion](evidence/phase-3-1gib.png), [100 MiB receipt](evidence/phase-3-100mib-receipt.json), [1 GiB receipt](evidence/phase-3-1gib-receipt.json).

## Complete validation

The complete gate passed from a fresh source copy with no private environment files or existing dependencies, after a frozen offline install. All 90 application/package/test/script source files matched the delivered workspace. **345 automated tests passed** (268 unit + 39 integration + 8 faults + 30 browser), with no retries, plus the separate 100 MiB/1 GiB live gate. Hosted CI has not run because nothing was pushed.

| Gate                                                 | Result                |
| ---------------------------------------------------- | --------------------- |
| Frozen offline installation                          | Passed                |
| All package/root strict TypeScript, ESLint, Prettier | Passed                |
| Secret/environment ignore guard                      | Passed                |
| Unit tests                                           | 268 passed            |
| Worker/SQLite integration tests                      | 39 passed             |
| Lifecycle fault tests                                | 8 passed              |
| Browser acceptance tests                             | 30 passed, no retries |
| Web build and Worker dry run                         | Passed                |
| Live 100 MiB + 1 GiB gate                            | Passed                |

New coverage includes safe paths and manifest conflicts; malformed/oversized frames; fragment gaps/duplicates/bounds; scheduler backpressure/abort; commit-barrier ACK timing; forged/duplicate ACK; corrupt blocks; failed finalization; premature finalize including empty files; unanswered-offer timeout; independent pause and terminal idempotency. Browser tests verify exact 0 B, 1 B and 17 KiB downloads, a corruption fault injected at the storage boundary, pause/resume/cancel, decline/retry, completed-file retention after revocation, receipts and cleanup. Existing P0/P1/P2 authorization, hibernation, isolation, relay credential and pairing regressions remain in the complete gate.

The suite uses actual Chromium, Firefox and WebKit engines on Linux, plus an explicit Pixel 7 viewport. WebKit uses a fresh persistent profile because this environment's private context exposes the OPFS API but rejects opening its root. The product fails visibly when storage is unusable. On this Arch host, WebKit compatibility libraries live only under `/tmp`; supported Ubuntu CI installs browser dependencies normally. The Linux WebKit pairing and two-process large-file harness use the documented test-only Chromium mDNS compatibility flag; the application preserves browser defaults. These tests do not substitute for physical iPhone/Windows/Mac/Android file-transfer validation. The user's phone stayed disconnected during P3.

Evidence: [frozen install](evidence/phase-3-install.txt), [complete gate log](evidence/phase-3-checks.txt), [desktop files](evidence/phase-3-desktop.png), [mobile viewport files](evidence/phase-3-mobile.png), [Firefox file transfer](evidence/phase-3-firefox.png) and [WebKit file transfer](evidence/phase-3-webkit.png).

## Security and changes to configuration

No new server/provider secret is needed. Static keys stay in ignored `apps/signaling/.env`, with private file permissions; `.env`/variants and `.dev.vars`/variants remain ignored at every depth. Only empty-secret `.env.example` templates may be tracked. Temporary non-extractable connection signing keys remain in browser memory. No private key, bearer, SDP, ICE address or user filename is copied into report evidence. Test screenshots mask invitation credentials; live traces remain off.

Strict path validation and locally generated storage keys prevent peer labels from selecting arbitrary OPFS entries. Hashes protect against corruption; they cannot attest that a malicious peer actually saved data. Local origin-private OPFS is not an encrypted vault against local profile access. Quota/write/flush/readback failure aborts without false success. Generic DOM storage errors avoid local-path disclosure. The [threat model](../threat-model.md), [secret handling](../security/secrets.md), README, protocol and runbooks now describe P3.

## Reproduce and handoff

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
pnpm dev
# In a second terminal while the development server is running:
pnpm bench:p3
```

Open <http://127.0.0.1:5173> in two independent regular profiles for the manual workflow. Keep several GiB free for the benchmark. Reproduction details and exact memory scope are in the [streaming runbook](../runbooks/streaming-verification.md); wire/ACK/lifecycle contracts are in the [P3 engineering note](../protocol/transfer-p3.md).

P4 must add persistent manifests/checkpoint ledger, trustworthy reopening, cross-store crash reconciliation, retention and crash-orphan cleanup. P5 must add authenticated revalidation and reconnect resume. Reload/connection loss currently aborts unfinished transfers. Browser eviction, power loss, background execution, direct-save picker integration, huge-file limits above the tested 1 GiB, public relay/hostile NAT and the remaining physical browser matrix are not certified by this phase. Schema allowance up to 64 GiB is a validation ceiling, not measured support.

## Commit command

From the repository root after reviewing the changes:

```sh
git add .
git commit -m "feat: implement phase 3 verified streaming file transfers"
```

No `git push` is included or performed.
