# Task 14 — concurrency, load and abuse resilience

Status: **LOCAL HARDENING VALIDATED — HOSTED CI PENDING MANUAL PUSH**.
Final Task 14 PASS requires a manually pushed implementation and successful
core/browser/foundation jobs. The operator explicitly requested that this task
leave changes local and uncommitted and provide Git commands.

## Source and historical status

Starting branch: `main`, initially clean. Local HEAD, origin/main and authenticated
GitHub main matched `d07d11bf79147504a76dead3081b1ed5cd4c7cf3` before editing.
Starting [Phase Gates 43075936777](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43075936777)
passed core, browser and foundation on that exact commit.

Final commit SHA: **not created**. HEAD remains the starting SHA; Task 14 is a
local working-tree patch, not the bytes identified by that commit alone.
New hosted CI run ID and core/browser/foundation: **NOT RUN — awaiting manual push**.
The green starting run does not validate these uncommitted changes.

- Task10D = **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**.
- Task11B = **SKIPPED — HOSTED PREVIEW VALIDATION NOT ESTABLISHED**.
- Task13 = **PARTIAL — APPLICATION HARDENING COMPLETE, EXTERNAL DEVICE EVIDENCE INCOMPLETE**.
- `productionApproved=false`; publication, acceptance and admission-reopening
  authority remain unchanged and blocked.

## Architecture and explicit limits

The audit covered signaling handlers, all three Durable Objects, peer connection,
transfer scheduling/recovery/storage, network diagnostics, existing integration,
fault/security/browser tests, benchmark runners and operations/deploy/TURN docs.

| Resource              | Application scaling and bounds observed in source                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room creation / HTTP  | Separate 30/300-per-minute derived-identity bindings; fail closed if missing; 8,192-byte JSON body ceiling, bounded chunk reads and five-second body deadline.                                                                                                            |
| Room state            | One SQLite SessionRoom actor per room; owner plus one admitted peer. HTTP/ticket/epoch/upgrade budgets are 180/24/12/24 per room per minute. Credentials are verified and persisted as hashes.                                                                            |
| Invitations / sockets | Single-use tickets, 64 ticket nonces, 128 recent message IDs per peer; two current peer sockets. Signal budget 60 per peer per ten seconds; forbidden/replayed/stale/rate-limited traffic is rejected according to existing policy.                                       |
| Expiry / alarms       | Default room/invitation/ticket lifetimes 900/300/30 seconds; 120-second idle socket policy; 30-second housekeeping and 60-second closed-room tombstone. Alarm scheduling is not a hosted punctuality guarantee.                                                           |
| Peer connection       | 128 pending local ICE entries, 64 remote ICE entries, 64 queued outgoing controls, 16 pending pings; receive accounting bounded by 2 MiB and 4,096 messages.                                                                                                              |
| Transfer engine       | 512 KiB send high-water / 128 KiB low-water; one 1 MiB unacknowledged verification block and one storage write per transfer. Manifest limits remain 16 files / 64 GiB; no new size promise is inferred.                                                                   |
| Recovery              | Fresh connection epoch, exact source and rehashed checkpoint identity, paged missing-range proofs, committed ACK accounting and final SHA-256/receipt requirements remain unchanged.                                                                                      |
| Relay                 | One deployment RelayPool, coalesced quota refresh, cached short-lived credentials and existing rotation. Warning at 0.4 GB; issuance stops at 0.45 GB or unknown/unverified free usage. No actual provider request is made by these tests.                                |
| Operations            | Separate counter/journal actors. Minute counters retain at most 1,441 minute slots across three fixed metrics. Pending alert admission now caps at 128; journal already caps at 128 rows / seven days and returns 20. Delivery attempts at most five rows per evaluation. |
| Client diagnostics    | ACK history 4,096, rolling frames/events 240/128, ten saved reports, 512 KiB per report / 4 MiB aggregate. These are application-owned bounds, not browser-process memory caps.                                                                                           |

Cloudflare's rate-limit binding is approximate, local to each Cloudflare location
and asynchronously updated. These tests do not turn it into a strict worldwide
quota. The deterministic reset fixture proves application use of the binding
contract, not provider timing or accuracy. See the
[official rate-limit documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
[Provider Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
are separate from these application ceilings and local measurements.

## Confirmed defects and corrections

1. A saved `onmessage` callback from a retired data channel could charge receive
   accounting before the existing stale-generation check and close its replacement
   epoch. The initial binary-callback regression failed on the original code;
   expanded coverage now checks both binary and text callbacks.
   A channel-ownership/closed-state guard now runs before any queue accounting.
   Active-channel flood rejection and protocol validation remain intact.
2. OperationsMonitor's pending outbox had no count ceiling. Delivery returned
   early for an unsuitable webhook origin before expiring stale entries, and a
   diagnostic alert did not arm its retry alarm. Each original assertion was
   reproduced before implementation. New admission is atomic and capped at 128
   with explicit 429 overload, expired entries are pruned before delivery/admission,
   and diagnostic/evaluation paths arm the existing alarm. Evaluation still drains
   after overload. Relay read failures remain unknown; a queue-full error is no
   longer hidden by the provider-read catch. Legacy queues above 128 are preserved
   and drained under the existing retention policy rather than deleted to fit.

Only these two production modules changed. No session schema, migration, pairing,
authorization, transfer frame, source identity, final-hash gate, provider quota,
release authority, production configuration or CI retry policy changed.

The existing all-actor rollback test also assumed every future Worker would be
byte-identical to `b103d568d7d2bed62957f4c129dc238a5b7752f6`. The Task 14 monitor fix
correctly invalidated that assumption. The test now retains the byte-identical
historical proof against the independently verified starting commit, then runs
today's actual Worker through the unchanged SQL/KV/auth/drain round trip. It also
persists a real undelivered alert across both versions and explicitly requires
`UNREVIEWED_SOURCE_CHANGE` from the release validator. The historical rollback
target is unchanged; local data readability grants no production rollback approval.

## Local evidence scopes and results

The reusable driver bounds HTTP work to eight in-flight operations, while keeping
all requested sockets/rooms alive. Every room uses independent synthetic credentials
and documentation-only IPs for independent local buckets. Cloudflare supplies the
actual client address at its public edge; this fixture does not prove public IP
spoofing or global admission capacity. All Worker outbound requests are contained.

| Case                        | Verified result in focused runs                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Room/socket matrix          | 1/10/25/50/100 paired local SQLite rooms; 2/20/50/100/200 real local TCP WebSockets; three bidirectional exchanges per room; zero isolation/authorization violations and zero forced socket cleanup.                                                                                                                     |
| Concurrent admission        | Fifty rooms race two join candidates each; exactly one admitted, the third peer rejected, peer self-approval denied, duplicate owner decisions idempotent and conflicting decisions rejected.                                                                                                                            |
| Deep isolation              | Fifty live pairs; foreign-room WebSocket routing rejected and offender closed. Revoking/expiring one room each leaves the other 48 functional.                                                                                                                                                                           |
| Signaling flood / fairness  | 500 attempted ICE, offer and answer frames in each of three cases. Exactly 60 forwarded before explicit rate-limit closure; ten normal rooms complete exchanges in each case. Frames after closure are not claimed as individually acknowledged rejections.                                                              |
| Creation rate               | Local native binding allows requests 1–30, rejects request 31 plus a further 100, preserves Retry-After 60 and allows an unrelated identity. Separate deterministic-clock tests cover exact reset, scope isolation and missing-binding rejection.                                                                        |
| Malformed inputs            | Eight classes across 800 HTTP attempts: all 4xx, no 5xx/reflected secret canary, response bodies bounded, healthy room still works. Fifty unknown-room reads leave no application room tables.                                                                                                                           |
| Replay                      | Twenty rooms reject 40 signal replays and 40 ticket reuses/race losers. Concurrent-room admission, closed-room invitations, duplicate receipts and private journal deliveries retain their existing rejection/idempotence semantics.                                                                                     |
| Disconnect/reconnect        | Fifty paired rooms; 25 pairs disconnect together while 25 survive. All interrupted pairs reconnect at epoch 2; stale epoch-1 signals rejected. No unrelated-room state change or cross-room delivery.                                                                                                                    |
| Expiry/cleanup              | Twenty-five of 50 live pairs run real local expiry/purge alarms after test-only SQL expiry-time advancement and a one-second test tombstone. All five application tables empty, no alarm/open socket remains for purged actors; surviving pairs continue. No hosted GC/memory reclamation claim.                         |
| Deterministic schedules     | Seeds 7/19/41/97, 250 precomputed schedules each: 1,000 admission/decision/revocation/expiry/isolation schedules; zero invariant violations. Four reference rooms avoid exceeding unchanged room-local budgets. This is four test cases containing 1,000 schedules, not 1,000 additional test cases.                     |
| Concurrent transfer engines | Ten and 25 file-backed injected-transport transfers reach simultaneous first-write barriers with sender progress zero until receiver commitment. Every completed source and actual output has the exact hash and receipt; duplicate receipt cannot repeat success.                                                       |
| Transfer reconnect storm    | Twenty 4 MiB-plus transfers reuse exactly 1 MiB each after checkpoint rehash, reconnect at epoch 2 and send missing-only payload; no stale mutation or duplicated committed bytes. This simulation starts after pairing and does not independently prove browser authentication.                                         |
| Large/small fairness        | Eight small transfers finish while a 64 MiB logical transfer is deliberately held, then the large transfer finishes; all nine output hashes exact. No global scheduler lock or hardware-speed threshold.                                                                                                                 |
| Concurrent cancellation     | Five of ten busy transfers cancelled; none completes or writes a receipt, while the other five finish correctly. Generated temporary stores are removed in cleanup.                                                                                                                                                      |
| Representative browsers     | Four simultaneous local WebRTC/OPFS transfers per desktop Chromium and mobile-emulated Chromium profile. Real 2 MiB-plus files, independent exported-file hashes, exact room-bound signed messages, no page errors; two first-attempt passes with retries disabled. No physical phone or hosted/NAT/TURN-capacity claim. |
| Relay fixtures              | Six quota states including unknown and exact cutoff; 100 outstanding actor requests per case share one quota read, mint no new key, and issue nothing when unsafe. Twenty delayed room credential requests recheck authorization; ten revoked rooms receive no credentials.                                              |
| Operations load             | 1,000 private events aggregate exactly; unexpected sensitive fields rejected; 20 repeated deliveries do not duplicate the two alerts. A 200-alert journal burst retains 128 / returns 20. Full/legacy queues, stale cleanup, retry alarm and recovery draining have focused regressions.                                 |
| Peer cleanup                | Retired binary/text callbacks ignored; active flood closes at the existing receive bound; 25 pending drain waits reject with all timers/listeners released; 25 independent 64-control queues do not retain rejected work.                                                                                                |

Observed file-backed per-transfer peaks are 524,288 queued bytes and 1,048,576
unacknowledged bytes. Assertions also bound outstanding blocks and receiver writes
to one. These measurements exclude native WebRTC buffers, runtime-native queues,
OS cache and total browser/Worker RSS. There is no claimed fixed global memory
ceiling independent of the number of active transfers.

The [sanitized evidence](evidence/task-14-concurrency-load.json) records per-case
counts and observed p50/p95 HTTP latency, without performance pass thresholds.
Local scheduling/throughput is not a hosted capacity benchmark. A seed fixture
can retain 254 mixed live/closed room records; the largest actively paired matrix
remains 100 rooms / 200 sockets. Hosted concurrency and real relay concurrency
are **NOT RUN** by Task 14.

## Validation

All **1,400 existing test cases** are retained, including every Task 12 case.
The existing all-actor rollback case was extended as described above; no test was
skipped or deleted. Additions: 6 unit + 10 security + 35 integration + 5 fault +
2 browser executions = **58 new tests**, giving **1,458 total passing tests**.
The 1,000 seeded schedules are loops inside four cases, not inflated test totals.

The final full command exited 0 against a byte-matched disposable source snapshot
(`fcbdeb051283876648f99c0b5b46dfc72b0b9559`). This SHA is a **test fixture**, not
this repository's final commit, hosted CI source or authorized release. All runtime,
test and tooling files still match that snapshot; only the final report/evidence
were subsequently updated. The main checkout remains uncommitted by request.

| Exact command                                                                                                                             | Result                          | Executed result                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                                                                                                                       | PASS                            | All ten workspace projects; also in final full check.                                                            |
| `pnpm typecheck`                                                                                                                          | PASS                            | Root TypeScript; also in final full check.                                                                       |
| `pnpm lint`                                                                                                                               | PASS                            | ESLint and Prettier; final report formatting rechecked.                                                          |
| `pnpm check:secrets`                                                                                                                      | PASS                            | Tracked/new source scanned; private environment files ignored.                                                   |
| `pnpm audit:release`                                                                                                                      | PASS                            | Fresh npm advisory response: no known vulnerabilities; existing low threshold unchanged.                         |
| `pnpm test:unit`                                                                                                                          | PASS                            | 1,029 cases.                                                                                                     |
| `pnpm test:security`                                                                                                                      | PASS                            | 81 cases, including Task 12 properties and new queue/rate checks.                                                |
| `pnpm test:integration`                                                                                                                   | PASS                            | 111 cases, including all 1,000 schedules and actual current/historical actor persistence.                        |
| `pnpm test:faults`                                                                                                                        | PASS                            | 56 cases; Task 12 large-file/integrity/recovery cases retained.                                                  |
| `pnpm test:release-store`                                                                                                                 | PASS                            | 46 cases using disposable local PostgreSQL, not hosted trust evidence.                                           |
| `pnpm build`                                                                                                                              | PASS                            | All workspace builds; Worker publication is `--dry-run` only.                                                    |
| `pnpm test:e2e`                                                                                                                           | PASS                            | 130/130, first attempt, no retries used; 8.4 minutes.                                                            |
| `pnpm test:pwa`                                                                                                                           | PASS                            | 5/5, first attempt; 24.3 seconds.                                                                                |
| `CI=true pnpm check`                                                                                                                      | PASS in isolated source fixture | All above local checks in one complete invocation, exit 0; not represented as a pass in the original dirty tree. |
| `pnpm test:load`                                                                                                                          | PASS                            | Dedicated final wrapper: 35 integration + 10 security + 5 fault cases.                                           |
| `pnpm test:load:browser`                                                                                                                  | PASS                            | Dedicated desktop/mobile runs: 2/2 with four simultaneous transfers each, retries forced to zero.                |
| `pnpm verify:rollback`                                                                                                                    | PASS                            | Original local SessionRoom drill, all stages; four runtimes started/disposed, private state cleaned.             |
| `/tmp/meshdrop-task11-tools/actionlint/actionlint -config-file /tmp/meshdrop-task11-tools/actionlint/config.yaml .github/workflows/*.yml` | PASS                            | All workflows; files and reviewed runner-label configuration unchanged.                                          |
| Task 14 hosted Phase Gates                                                                                                                | NOT RUN                         | New run ID/core/browser/foundation pending the operator's manual commit/push.                                    |

Suite totals: unit 1,029 + security 81 + integration 111 + faults 56 + release-store
46 + browser 130 + PWA 5 = **1,458**. The final full browser run used the normal
unchanged two-worker configuration. Both new concurrency cases also pass there;
the dedicated command separately enforces zero retries. No first-attempt failures
or eventual retry passes occurred in this final full run.

Initial test attempts are not erased: the original production regressions failed
before fixes. New fixture development also exposed an unchanged per-room HTTP
budget, a legitimate automatic signed ping, the correct local alarm-inspection
API and asynchronous quota-entry ordering. Fixtures now use independent reference
rooms, verify actual room identity rather than a brittle exact ping count, inspect
alarms through a local-only subclass, and wait for provider-entry causality.
Production limits, existing assertions and retries were not relaxed. One wrapper
attempt failed solely because the sandbox forbade loopback `listen`; it was rerun
with local socket permission.

The initial full check in the dirty working tree passed types/lint/secrets and
1,029 unit plus 81 security cases, then failed two integration cases. The release
archive gate correctly rejected a Worker built from uncommitted code while its
manifest named the unchanged HEAD; this guard was not bypassed. The other case
was a local Miniflare HTTP `ECONNRESET`, which passed in isolation unchanged.
A disposable copy of public source and dependencies was therefore tested with
its own synthetic local Git snapshot, so the same release checks could compare
against the actual source under test without committing this repository. No
private `.env` was copied, no dependency was upgraded and fixture pushing is
disabled. This is test infrastructure, not a release commit or authenticated
provenance. Its first run then exposed the historical byte-identity assumption;
after extending that case, all four focused packaging/preparation/rollback cases
passed. The final full rerun exited 0 with all 1,458 cases passing.
Build output retained existing dependency annotation/chunk-size warnings, and the
PWA offline scenario logged a local WebSocket proxy reset while its assertions
passed. The original packaging `ECONNRESET` cause remains unproven; no retry or assertion relaxation
was added to conceal it. npm audit also required retrying outside the sandbox
after DNS denial; the authorized fresh request found no known vulnerabilities.

## Exact changed files

- `apps/signaling/src/durable/OperationsMonitor.ts` — bounded alert admission,
  unconditional expiry cleanup and reliable retry/drain scheduling.
- `packages/peer-connection/src/PeerSession.ts` — reject callbacks from retired
  channels before queue accounting.
- `package.json` — add the two isolated load aliases.
- `scripts/benchmarks/load.mjs` — fixed local plans, sanitized environment and
  secret-file refusal; no remote target or deploy mode.
- `scripts/benchmarks/README.md` — reproduction commands and evidence boundaries.
- `tests/helpers/control-load.ts` — reusable bounded real local control-plane driver
  and sanitized numeric evidence.
- `tests/integration/concurrency-load.spec.ts` — room/socket/admission/flood/storm/
  malformed/replay and 1,000 seeded schedules.
- `tests/integration/load-cleanup.spec.ts` — real isolated alarm/purge correctness.
- `tests/integration/load-rate-limits.spec.ts` — actual local native binding limits.
- `tests/integration/load-relay.spec.ts` — concurrent quota fixtures and post-await
  authorization recheck; no actual provider traffic.
- `tests/integration/load-operations.spec.ts` — outbox regressions, counters and journal.
- `tests/integration/v2-rollback.spec.ts` — retain the frozen historical equality
  proof while testing today's actual persisted actor state and pending alert;
  explicitly reject unreviewed release-source compatibility.
- `tests/security/peer-reconnect-flood.spec.ts` — callback ownership, receive/control
  bounds, timer/listener cleanup.
- `tests/security/rate-load.spec.ts` — deterministic boundaries/reset/fail-closed scopes.
- `tests/faults/concurrent-transfers.spec.ts` — simultaneous engines/recovery/cancel/fairness.
- `tests/e2e/concurrent-transfers.spec.ts` — four real local browser pairs and exports.
- `tests/unit/local-load-runner.spec.ts` — wrapper cannot accept remote/deploy modes,
  reuse an ambient server or inherit the tested provider credentials.
- `docs/runbook.md` — operational queue overload and honest rate-binding scope.
- `docs/reports/task-14-concurrency-load.md` — this investigation and validation report.
- `docs/reports/evidence/task-14-concurrency-load.json` — reviewed aggregate measurements.

## Safety and remaining work

Commits/pushes/PRs in this repository: **0/0/0**. All changes remain local,
unstaged and uncommitted. Disposable `/tmp` test copies have synthetic local
source snapshots solely to exercise the existing commit-bound release checks;
none is pushed or represents an operator-approved release.
Production deployments/config/secret/DNS/admission/migration/session mutations:
**0**. TURN plan changes and paid services activated: **0**. Task 10D/11B workflows
were not run. The live public service was not load-tested or otherwise contacted.
No secrets, private environment files, raw browser traces or credential-bearing
provider responses are included in public evidence. Disposable PostgreSQL in the
regression suite is local test infrastructure, not hosted recovery evidence.

Review the local diff, commit only the listed files, rerun the commit-bound full
check in the main checkout and push normally; then verify
the new source SHA's Phase Gates core/browser/foundation all complete SUCCESS.
Until then this task does not meet the hosted-CI condition for final Task 14 PASS.
Real hosted/user/relay capacity, provider rate accuracy and native resource
reclamation require separately authorized measurements. Task 15 is not started.
