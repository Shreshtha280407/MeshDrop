# MeshDrop Phase 6 report — measured transfer insights and local reports

Date: 2026-10-17. Source: P6.1–P6.6 and the P6 contracts/exit gate in the supplied phase-wise plan, with the architecture's device-owned diagnostics boundary. Baseline: the user's Phase 5 commit `9e8a1db`. Changes remain local and uncommitted. No GitHub commit/push or deployment was performed.

**Phase 6 is complete. The final full `pnpm check` passed 432 tests without retries, including the required real transfer with a measured pause, authenticated recovery and exactly reported reused bytes.**

## Delivery against the plan

| Ticket | Delivered behavior                                                                                                                                                               | Main implementation                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P6.1   | One-second sampling, bounded outstanding probe, stale/unsupported/error fallbacks; stop at terminal/disposal                                                                     | `StatsSampler.ts`, `PeerSession.ts`                      |
| P6.2   | Receiver-confirmed interval/rolling/average throughput, signed application RTT, selected candidate RTT/state/path, local send buffer, successful receiver storage-commit latency | `Aggregator.ts`, peer and transfer adapters              |
| P6.3   | Decimal MB/s versus Mbps, report-relative monotonic timing, exact cumulative counters, bounded rolling ACK window, recent detail plus decimated history                          | `Contracts.ts`, `Aggregator.ts`, `DiagnosticsSession.ts` |
| P6.4   | Measured ACK stalls, sustained buffer pressure, observed relay, connection/recovery events and sampled slow storage; deduplicated explanations                                   | `Rules.ts`, `Events.ts`                                  |
| P6.5   | Separate local IndexedDB history with strict allowlist/redaction, count/byte/retention pruning and explicit deletion                                                             | `MetricsStore.ts`, runtime persistence queue             |
| P6.6   | Typed subscriptions, responsive cards, interactive metric timeline/sample inspection, annotated events, saved report selection and JSON/CSV downloads                            | Network intelligence package and `NetworkPanel.tsx`      |

The P0 diagnostics placeholder is replaced by working code. Sampling, aggregation and file engines remain independent of React; the view subscribes to snapshots. Memoized insights avoid redrawing charts for every file-progress update. The existing pinned Zod 4.6.7 dependency is reused with explicit workspace dependencies and a synchronized lockfile. Worker health and the application label identify P6; the next phase is P7 mobile/PWA hardening.

## Correctness and failure behavior

Speed uses newly receiver-confirmed bytes, with separate interval, ten-second rolling and report-average values. Revalidated reused bytes reset the attempt baseline and never create a throughput spike. A source report observing the settled initial prefix and resumed suffix confirms the file once; a newly opened page measures only confirmations it observes. Confirmed/reused/attempt counters remain separate. Report average includes preparation, pause, interruption and finalization time.

Each sample has an explicit metric name, value, unit, provenance, availability reason and report-relative monotonic timestamp. Frames include elapsed sampling interval, transfer state and admitted epoch. UTC timestamps support retention/order only. Missing values remain null and display Unavailable; an actual measured zero remains zero. Signed application RTT includes channel/peer/signature processing, while ICE RTT comes from the selected pair. Source-only storage timing is unavailable because it is measured on the receiver.

Selected-pair extraction checks the transport-selected pair or one unambiguous nominated/succeeded fallback, then referenced candidate categories. Merely gathering a relay does not label the path relay. Raw candidate dictionaries, addresses and credentials never enter reports. No low-throughput rule diagnoses Wi-Fi congestion, ISP throttling or a remote hardware cause.

The sampler has at most one underlying probe pending, a 200 ms wait budget and a three-second stale cutoff. Captures also occur on critical transitions. Terminal duration freezes; a later room close does not stretch it. A diagnostics quota or statistics failure leaves the transfer engine's commit, final hash and receipt checks independent. Timing replies tolerate the normal file-buffer range and a failed best-effort reply cannot abort file delivery.

Keep recent 120-second detail, approximately five-second durable snapshots and progressively downsampled older frames, bounded to 240 frames/128 events and 512 KiB compact JSON per report. The local database caps aggregate logical JSON at 4 MiB and ten reports, with seven-day expiry from the last captured update. Both writes and history reads prune invalid/expired/excess rows transactionally. Database overhead is outside the logical byte cap. Explicit deletion waits for this page's outstanding writes, including retired sessions. Exported downloads remain outside site cleanup.

## Required live demonstration

The focused gate used two independent Chromium contexts on the supplied Linux laptop, actual WebRTC file transport, receiver OPFS/IndexedDB and a deterministic varied fixture. It paused near one third, waited for a full zero-throughput sample, restarted ICE, required a fresh independently compared pairing code on both peers, prepared the original source and resumed only missing blocks.

| Measurement                                            | Reviewed live gate                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Complete fixture                                       | 25,165,824 B (24 MiB)                                                                                      |
| Authenticated reused prefix                            | 8,388,608 B (8 MiB)                                                                                        |
| New file payload emitted after resume                  | 16,777,216 B (16 MiB), exactly total minus reused                                                          |
| New receiver confirmations over the whole page session | 25,165,824 B; reuse excluded from throughput                                                               |
| Measured interruption to authenticated resume          | 1,792.20 ms                                                                                                |
| Final source/download SHA-256                          | Exact independent match                                                                                    |
| Report frames / events                                 | 23 / 10                                                                                                    |
| Export and history                                     | JSON/CSV parse equal; saved report reopens/exports after reload; explicit deletion survives another reload |

Exact synthetic source and downloaded SHA-256:

```text
ecd0f4218a0ef5b91741f38f05c5e08b36ed6b7ff7eeaa62483d63c0927b144a
```

The chart and event stream show the pause dip, connection interruption, restored connection, source revalidation, authenticated resume with exact reused bytes, final verification and completion. Receiver-confirmed payload counts do not include WebRTC headers or retransmissions and are not a claim about wire throughput.

Evidence: [gate measurements/scope](evidence/phase-6-gate.json), [paused insights](evidence/phase-6-paused-desktop.png), [completed insights](evidence/phase-6-complete-desktop.png), [paused report](evidence/phase-6-paused-report.json), [final JSON](evidence/phase-6-report.json) and [final CSV](evidence/phase-6-report.csv). These are reviewed synthetic artifacts; no user file or real credential is included.

This is a real local transfer with injected pause and ICE restart. It does not establish physical roaming, a new ISP/subnet, actual handset behavior or production bandwidth. P5's separate 1 GiB subnet-migration evidence remains historical; this phase does not claim a new large-file/RSS certification.

## Validation

Focused checks passed: 14 new deterministic unit cases; the desktop live gate; unavailable browser statistics plus a metrics-only quota failure during a separately hash-verified file transfer; a timing reply under injected 96 KiB local buffer pressure; actual IndexedDB count/expiry/privacy-shape/deletion and aggregate 4 MiB-cap enforcement. The latter checks seed over-cap history and verify cleanup even without starting another transfer.

Unit evidence includes exact ACK interval/window/average math, MB/s–Mbps conversion, dense-window overflow, selected host/srflx/prflx/relay categories, ambiguous/missing/nonfinite stats, measured zero, rule deduplication/pause suppression, exact reuse/recovery timing, stopped timers, immediate epoch-cache invalidation with late-probe rejection, failed persistence, bounded history, strict labels/privacy shape and JSON/CSV timestamp/duration equality.

The final complete `pnpm check` passed **432 tests (297 unit + 39 actual Worker/SQLite integration + 18 faults + 78 browser/storage)** with no retries. All package/root strict types, ESLint, Prettier, secret checks, production web build and Worker dry run passed. Browser/storage checks completed in 4.1 minutes and include Chromium desktop, Pixel viewport and Chromium-to-Firefox/WebKit file transfer. The new diagnostics pause/recovery/export/reload/deletion gate passes on desktop and mobile viewports. This is browser-engine/viewport coverage on Linux, not physical phone or OS certification.

| Gate                                                 | Final result                                         |
| ---------------------------------------------------- | ---------------------------------------------------- |
| Frozen offline workspace install                     | Existing checkout verified; no clean reinstall claim |
| Package/root strict TypeScript, ESLint, Prettier     | Passed                                               |
| Environment and secret protection                    | Passed                                               |
| Unit tests                                           | 297 passed                                           |
| Worker/SQLite integration                            | 39 passed                                            |
| Lifecycle/recovery faults                            | 18 passed                                            |
| Browser/storage acceptance                           | 78 passed, no retries                                |
| Production web build and Worker dry run              | Passed                                               |
| Required measured pause/recovery/reuse demonstration | Passed at desktop and mobile viewport                |

Evidence: [complete final check](evidence/phase-6-checks.txt), [existing-checkout frozen installation](evidence/phase-6-install.txt), [mobile paused insights](evidence/phase-6-paused-mobile.png) and [mobile completed insights](evidence/phase-6-complete-mobile.png). Upstream build-annotation/environment warnings were nonfatal; no check failed. Frozen offline installation is not a fresh dependency reinstall claim.

During verification, the live run exposed the inherited signed-PONG control-buffer limit conflicting with active file sends. Replies now use the file-buffer range and best-effort failure handling, automatic probes skip a busy buffer, and a deterministic real-peer pressure regression protects the behavior. Report selection also received explicit accessible labels, verified by reopening the saved report after reload. Final review added immediate invalidation of cached transport observations on reconnect/epoch changes, with a regression proving late old probes cannot repopulate the cache. No admission, pairing or integrity check was relaxed.

## Security, documentation and remaining scope

Static/provider secrets remain only in ignored `apps/signaling/.env` (0600); `.env`/variants and `.dev.vars`/variants remain ignored, with only empty-secret example templates tracked. P6 adds no configuration secret. Runtime capabilities, signing keys, tickets and TURN credentials remain outside reports. No telemetry upload or new file route exists. Reports omit filenames, paths, manifests, file hashes, connection IPs/ports/SDP and raw exceptions. Transfer/report UUIDs, timing and byte counts can still link voluntarily shared reports to a transfer; origin/profile compromise is outside this redaction boundary.

The [typed measurement contract/engineering note](../protocol/diagnostics-p6.md), [operation and reproducible-demo runbook](../runbooks/transfer-insights.md), README, local-development runbook, threat model and secret documentation describe the final interfaces and limits.

Both peers must remain available in the foreground. Browser suspension can delay sampling; gaps are marked and left blank. History can be evicted or cleared, and closing immediately can interrupt the final asynchronous write. Older frames are decimated; the report is a bounded observation record rather than an exhaustive packet/storage trace. No physical Oppo/iPhone/Windows/Mac P6 result is claimed; the phone remained disconnected. No public deployment, hosted CI or GitHub operation was performed. P7 remains next and has not been implemented as part of P6.

## Reproduce and commit

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm check
pnpm bench:p6
```

After reviewing the local phase changes:

```sh
git add .
git commit -m "feat: implement phase 6 measured transfer insights and local reports"
```

No `git push` is included or performed.
