# MeshDrop Phase 5 report — authenticated missing-block resume

Date: 2026-10-17. Implementation source: P5.1–P5.6 and the P5 contracts/exit gate in the supplied phase-wise plan, together with the architecture's receiver-owned recovery boundary. Baseline: the user's Phase 4 commit `9db7bdc`. Work remains local and uncommitted; no GitHub commit/push, deployment or submission was performed.

**Delivered:** authenticated foreground resume after connection loss, reload or renewed room admission. The required **1 GiB** demonstration interrupted at the first whole block boundary above 70%, changed the actual selected WebRTC subnet inside a private Linux network namespace, authenticated a fresh epoch and completed with an exact independent SHA-256. **717 MiB were reused and only 307 MiB of file payload were sent after resume.**

## Implementation against the plan

| Ticket | Delivered behavior                                                                                                                                                                                          | Main code                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P5.1   | Monotonic admitted connection epochs, refreshed socket tickets, ICE restart first, new peer connection fallback; fresh bilateral comparison before file traffic                                             | `PeerSession.ts`, `RoomClient.ts`, `EpochManager.ts`                               |
| P5.2   | Revalidated receiver block proofs, deterministic checkpoint digest, persisted non-secret resume identity/epoch binding, exact manifest and source identity                                                  | `CheckpointDB.ts`, `LedgerReconciler.ts`, hash/storage worker, `Reconciliation.ts` |
| P5.3   | Signed RESUME_HELLO → MANIFEST_CONFIRM → HAVE_RANGES → NEED_RANGES → RESUME_ACCEPT with attempt UUID, ordered 32-proof pages and bounded controls                                                           | Protocol schemas, `ResumeMachine.ts`, `TransferMachine.ts`                         |
| P5.4   | Sender rereads source hashes before accepting reuse; corrupt/missing/unconfirmed/forged-proof blocks are requested; arbitrary holes, fully reused files and tails still undergo final verification          | Recovery engine, worker, receiver block admission and sender scheduler             |
| P5.5   | Exponential 1/2/4/8/16-second delays, five automatic attempts, visible manual retry, exact source reselection and fresh-room recovery after lost/expired/revoked admission                                  | `RetryPolicy.ts`, `SourceReselect.ts`, room adapter and saved transfers            |
| P5.6   | Revalidation/proof/source-required/reconnect states, reused bytes, per-attempt source payload and receiver committed payload, recovery events, retained data on interruption and explicit terminal deletion | Live transfer panel, saved transfers and pairing/retry controls                    |

The recovery package now contains working implementations rather than its P0 placeholder. It remains independent of React and the signaling backend. Existing P0–P4 authorization, signed peer controls, storage ordering, quota recovery and terminal receipt checks remain in the application. The backend gains no file-storage/upload route and receives no file manifest or block proof.

No new external package version was introduced: the existing pinned SHA-256 dependency is reused, with explicit workspace dependencies and an updated lockfile. The local Worker health label is P5. The UI points next to P6 network intelligence/local reports.

## Recovery and trust behavior

The owner prepares the exact original source under the original transfer/file IDs. Full-file SHA-256 is recomputed in a worker, so same-name/same-size wrong content is refused. Live reconnect keeps accessible File objects in memory; reload requires explicit reselection. Source manifests do not preserve filesystem permissions or source file bytes.

The receiver holds the exclusive store lock, validates manifest/retention, rereads ledger-backed blocks and discards missing/changed/uncertain rows. Each surviving block proof is then checked against a newly read source block over the freshly signed, independently compared peer channel. A forged local digest can pass local rehash but is rejected when it differs from the original source. The sender and receiver agree on the exact accepted proof-set digest and byte count before data starts.

A single proof page is outstanding at a time. Missing manifest blocks plus rejected proofs form the complement of the accepted set. This represents fragmented progress without a giant control message or full-file buffer. The sender skips accepted indexes, and the receiver advances over reused ranges while admitting only the missing indexes. New progress still waits for verified write/readback, flush and strict ledger transaction completion.

Backward-compatible optional IndexedDB fields store the checkpoint digest and last accepted `{roomId, epoch, attemptId, checkpointDigest, reusedBytes}`. Same-room acceptance requires a fresh higher epoch. A different approved room has a separate epoch namespace and fresh transcript. No room capability, ticket, TURN shared secret or signing key is persisted. Existing P4 checkpoints remain usable without migration.

Every completed file, including empty or fully reused files, still needs final stored-file SHA-256 verification. The new receipt binds the current epoch; receipt acknowledgement and receiver persistence remain mandatory. A recovered byte count or old receipt cannot manufacture completion. Distinct stale/replayed handshake pages fail closed, ordinary old wire epochs/sequences are rejected earlier, and identical engine message IDs are idempotent.

A new comparison authenticates the human peer through the user's independent trusted channel. This is not persistent device identity, remote hardware attestation or an encrypted local vault. Fresh-room recovery explicitly renews authorization; it does not resurrect an expired invitation or lost browser credential.

## User workflow

1. Keep both devices online. Pair/approve, independently compare both codes, offer and accept files with a retaining policy.
2. On connection loss, the old attempt stops while retained checkpoints remain. Connection retries try ICE restart then a fresh connection, stop after five attempts, and can be reset with Retry connection.
3. Confirm the new code on both devices. The owner chooses Prepare original source and waits for Source ready; the receiver chooses Resume saved transfer.
4. After reload/expiry, create/join/approve a fresh room first. In Saved transfers, reselect every original source and prepare it on the owner, then resume the saved checkpoint on the receiver.
5. Observe source-checked reused progress and new payload. Save the verified final file/receipt. Cancel/Clear/Delete saved explicitly removes scoped local data, while retry/interruption preserves the selected policy.

Trying to resume before source preparation produces a visible source-required error and retains data. Damaged/evicted bytes can legitimately reduce reusable progress; neither stored file length nor an old counter is treated as evidence. Cancellation is terminal for the attempt; an offline remote browser's retained copy cannot be deleted remotely.

## Mandatory 1 GiB network-change gate

Final run: Chromium 156.0.8078.4, two independent persistent browser processes, deterministic varied file content, real WebRTC and disk-backed OPFS/IndexedDB on the supplied Linux laptop. A guarded private user/network namespace ran its own loopback app servers and isolated Worker state. At the interruption boundary, the test removed its `10.90.0.2/24` dummy interface and introduced `10.91.0.2/24`; selected candidate statistics prove the changed source/remote addresses. The laptop's host Wi-Fi, routes and other applications were untouched.

| Measurement                                        | Final result                                                  |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Original file                                      | 1,073,741,824 B (1 GiB)                                       |
| Interrupted/reused verified bytes                  | 751,828,992 B (717 MiB; 717 blocks)                           |
| Interruption fraction                              | 70.01953125% — first whole 1 MiB boundary at/above 70%        |
| Candidate path before                              | `10.90.0.2` ↔ `10.90.0.2`, host/UDP                           |
| Candidate path after                               | `10.91.0.2` ↔ `10.91.0.2`, host/UDP                           |
| Resumed admitted epoch                             | 3; fresh code comparison on both peers                        |
| Existing peer connection reused                    | Yes; one connection object before/after in this migration run |
| File payload emitted after resume                  | 321,912,832 B (307 MiB), exactly total minus reused           |
| Reused valid blocks resent as file payload         | 0                                                             |
| Resume revalidation/transfer/finalization duration | 76,105 ms                                                     |
| Independent downloaded-file SHA-256                | Exact match                                                   |
| Receipt epoch/file digest                          | Exact match to current epoch and final file                   |

Exact source/download SHA-256:

```text
bafa6507e9866ce146f467b7143686d3ffb3022ae1396881fb0dff0d24493bca
```

The source payload counter excludes frame headers, proof/control traffic, ICE/DTLS/SCTP overhead and underlying transport retransmissions. It measures emitted file DATA payload; it is not a network wire-byte or throughput claim. The receiver separately reports newly committed payload. The successful run cleaned its generated 1 GiB fixture/download and persistent test profiles, leaving reviewed metrics/receipt/screenshots.

Evidence: [exact metrics and scope](evidence/phase-5-resume.json), [before migration](evidence/phase-5-before-network-change.png), [receiver completion](evidence/phase-5-resumed-complete.png), [sender reused/missing-only counters](evidence/phase-5-sender-missing-only.png) and [new-epoch receipt](evidence/phase-5-receipt.json).

This is actual controlled logical subnet migration, not physical Wi-Fi/mobile roaming or public NAT/TURN certification. The existing test-only Chromium mDNS compatibility flag is confined to isolated browser processes; application defaults are unchanged. A separate real-browser closed-transport case verifies that an unavailable ICE restart falls back to a new peer connection and still requires a new comparison.

## Automated validation

**The final complete `pnpm check` passed: 408 tests (283 unit + 39 integration + 18 faults + 68 browser/storage), with no retries.** All package/root strict types, lint, secret protection, production web build and Worker dry run passed. The browser portion completed in 3.7 minutes. Frozen offline installation was verified against the existing checkout; this is not a claim of a fresh dependency reinstall.

| Gate                                                 | Result                                               |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Frozen lockfile/workspace installation               | Existing checkout verified; no clean reinstall claim |
| All package/root strict TypeScript, ESLint, Prettier | Passed                                               |
| Environment/secret protection                        | Passed                                               |
| Unit tests                                           | 283 passed                                           |
| Actual Worker/SQLite integration tests               | 39 passed                                            |
| Lifecycle/recovery fault tests                       | 18 passed                                            |
| Browser/storage acceptance                           | 68 passed, no retries                                |
| Web production build + Worker dry run                | Passed                                               |
| Required 1 GiB interruption/new subnet/resume        | Passed                                               |

The new engine matrix exercises 0%, 10%, 50%, 70%, 95% and 100% interruption before terminal completion, skips every reusable block, and independently hashes the result. It also covers a delayed old-epoch ACK, same-size changed source, identical/replayed NEED_RANGES, explicit cancellation, and a multi-file resume with a fully reused file, empty file, interior reused range and short final block.

Real-browser cases cover 10/50/70/95% ICE restart on desktop and Pixel viewport, full page reload on both peers, new room approval/code comparison, unavailable/wrong/correct source, corrupt stored bytes, a forged local block digest and closed-transport automatic fallback. Downloads are hashed independently. The inherited suite still covers quota retry, crash windows, actual IndexedDB abort, exclusive locks, expiry/cleanup, real admission/signaling faults and Chromium↔Firefox/WebKit file transfer. The viewport and Linux browser engine cases do not replace physical device validation.

Evidence: [complete local check](evidence/phase-5-checks.txt), [frozen installation](evidence/phase-5-install.txt), [desktop resume](evidence/phase-5-desktop-resume.png) and [mobile viewport resume](evidence/phase-5-mobile-resume.png).

During development, negative tests exposed and corrected retry suppression after React's development cleanup, an invitation helper relying on same-document fragment navigation, and the historical P2 assertion that resume remained unavailable. An interrupted check also left its local Worker port occupied; that identified test server was stopped before the final gate. No production rate limit or identity check was relaxed to pass tests. Per-case documentation IPv6 test buckets remain confined to the inherited local test helper.

## Security, documentation and limits

Static/provider keys remain in ignored `apps/signaling/.env`, mode 0600. `.env`/variants and `.dev.vars`/variants are ignored at every depth; only empty-secret `.env.example` templates may be tracked. P5 introduces no static secret. Reviewed synthetic metrics/receipt/screenshots are retained; raw profiles/fixtures stay ignored. Fault hooks and browser instrumentation are test-only and excluded from production bundles.

The [resume protocol](../protocol/resume-p5.md), [operation/test runbook](../runbooks/resume.md), ADR-004, README, threat model, secret documentation and benchmark instructions describe the final behavior and trust boundaries. The existing storage/streaming contracts remain applicable.

Remaining limits: foreground availability of both peers, exact source access, browser quota/eviction/site-data clearing, unsupported/private modes, suspended pages, local-profile/origin compromise, physical power loss, and untested hardware/network combinations. The phone stayed disconnected; no Oppo/Android/iPhone/Windows/Mac P5 result is claimed. The new gate tests 1 GiB, not 64 GiB or universal browser persistence. P4's sampled memory result remains historical evidence; P5 does not claim a new measured memory/RSS certification. No public deployment or hosted CI was run because nothing was pushed.

P6 is next: measured WebRTC/ACK/storage statistics, bounded local metric history, honest diagnoses and report export. No P6 implementation is included in this phase.

## Reproduce and commit

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
# Linux user/network namespaces; creates its own isolated dev servers:
pnpm bench:p5
```

After reviewing the local changes:

```sh
git add .
git commit -m "feat: implement phase 5 authenticated missing-block resume"
```

No `git push` is included or performed.
