# Task 06 — Mobile peer connection recovery race

## A. Investigation verdict

**Production controller bug**, not an invalid expected epoch. The original
`1 → 2 → 3` assertions remain intact. The initial working tree was clean on main
at `fd44a45b39e272a81ab28d1ed6dc61c51c3e058e`; 443 tracked-file hashes were
captured before modification.

The reported failure was in the mobile Chromium case “signed peer hello,
independent comparison, epoch restart and fresh connection” in
`tests/e2e/peer-connect.spec.ts`. It observed epoch 4 instead of 3 after a receiver
requested a new connection following an ICE restart. A previous run also timed
out during cleanup. Neither a changed expected epoch nor increased retries or
timeouts is an appropriate repair.

## B. Root cause and event sequence

`SessionRoom` correctly owns epoch allocation: only the approved owner can issue
the compare-and-swap HTTP request. Epoch 1 initializes the connection, 2 restarts
ICE, and 3 replaces the transport. The receiver requests replacement over its
authorized signaling socket; the owner submits the epoch-2 CAS request.

The race occurs after the server admits epoch 3:

1. Owner `handleSignal(CONNECTION_EPOCH)` clears a prior retry, records status
   epoch 3, and awaits its ICE-credentials response.
2. Receiver initializes epoch 3 first and retires the old epoch-2 transport.
3. The owner's still-current epoch-2 data channel closes. This is a legitimate
   close event, not evidence that the newly admitted epoch 3 has failed.
4. Previously, `peerChanged()` scheduled automatic recovery without checking
   which admitted epoch owned that callback.
5. After one second it issued `expectedEpoch: 3, mode: ice-restart`, allocating
   epoch 4 before epoch 3 finished initialization. Restarting an unready transport
   can fail and trigger the later new-connection fallback to epoch 5.

A local diagnostic copy delayed only the owner's third ICE-credentials response
by 1.5 seconds. The original controller failed at expected 3 / observed 5. Its
sanitized trace records owner admission of 3 at 3815ms, old epoch-2 closure at
3885ms, and the unintended recovery request at 4886ms. This demonstrates the
extra epoch-4 request rather than inferring it from a DOM assertion alone.

The same diagnostic passed after the fix and retained exact epochs 1, 2 and 3.
Both peers were actually mobile-emulated: viewport 412×839 and one touch point.
No duplicate React handler, invalid viewport setup or server CAS defect was
identified. React observes RoomClient through `useSyncExternalStore`; the
incorrect recovery decision originates in the controller before rendering.

The first natural baseline sample passed ten executions with zero retries; the
controlled delay makes the otherwise intermittent ordering reproducible. The
earlier Task 05 failure lacks a complete event trace, so this does not prove
that every historical browser timeout has the same cause.

Related deterministic tests also exposed two socket-ownership defects: a late
ICE response from a replaced socket could instantiate another peer, and a late
failure from that socket could schedule recovery for its replacement.

## C. Fix and changed files

| File                                          | Change / reason                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/features/pairing/RoomClient.ts` | A peer interruption schedules recovery only when its epoch equals the current admitted epoch. After awaiting ICE credentials, verify signaling-socket identity before initializing. Guard asynchronous failure handling with socket identity and room generation. Explicitly schedule genuine initialization failure after the existing fail-closed error path, since the peer may not yet have reached the admitted epoch. |
| `tests/unit/room-recovery.spec.ts`            | Nine controller tests with controlled promises, socket events and virtual time. Four fail against original logic and all pass after repair. Covers stale closed/reconnecting callbacks, current-epoch recovery exactly once, real initialization failure, duplicate/out-of-order epochs, disposal, late socket success/failure and comparison rejection.                                                                    |
| `tests/e2e/peer-connect.spec.ts`              | Retains the original scenario and every epoch/pairing assertion; adds exact connection-request counts. Adds a shared scenario variant that holds replacement ICE credentials across the 1s retry boundary after observing actual retiring-channel closure. It also changes viewport while initialization is pending. Both desktop and mobile execute it.                                                                    |
| This report                                   | Reproduction, causal evidence, validation and limits.                                                                                                                                                                                                                                                                                                                                                                       |

This confines automatic recovery to the attempt that actually failed. It does
not suppress genuine failure of the current peer or initialization attempt.
Late work from a retired socket cannot mutate its replacement. Server epochs,
signaling schemas/sequences, DTLS binding, signatures, replay checks, independent
pairing confirmation, timeouts and retry policy are unchanged.

## D. Reproduction and stress

Environment: Node 24.22.2, pnpm 10.34.7, existing local Chromium/workerd tooling.
All testing uses local Vite/Miniflare and disposable sessions. Diagnostic output
contains only role, event type, epoch, state, readiness and relative time; never
room IDs, credentials, pairing codes, SDP, candidates or private payloads.

Baseline sample:

```sh
CI=true pnpm exec playwright test tests/e2e/peer-connect.spec.ts --project mobile-chromium --grep 'signed peer hello, independent comparison' --repeat-each 10 --retries 0 --workers 2 --max-failures 1
```

Result: 10/10 passed, zero retries, 33.4s. An earlier anchored grep selected no
tests; it is not counted as an execution. The original-code controlled browser
diagnostic failed; the identical diagnostic passed after the production fix.
The deterministic unit run against original controller logic had four failures
and five passes; after repair it passed all nine.

Repeatable repository regression commands:

```sh
CI=true pnpm exec playwright test tests/e2e/peer-connect.spec.ts --grep 'delayed admitted epoch' --retries 0
pnpm exec vitest run --project unit tests/unit/room-recovery.spec.ts
```

Related peer suite: `CI=true pnpm exec playwright test tests/e2e/peer-connect.spec.ts --retries 0`
passed all 12 cases, including comparison mismatch and replay rejection, with
zero retries (32.2s).

Primary stress command:

```sh
CI=true pnpm exec playwright test tests/e2e/peer-connect.spec.ts --project mobile-chromium --grep 'signed peer hello, independent comparison' --repeat-each 50 --workers 1 --retries 0 --max-failures 1 --output /tmp/meshdrop-task06-_na2zbnm/stress-results
```

**50/50 consecutive first-attempt passes, zero retries, zero failures, zero
unexpected epoch transitions and zero unhandled page errors (5.1 minutes).**
One worker gives consecutive runs and avoids shared
rate-bucket contention; each execution still runs two real peers concurrently.
Normal CI concurrency/retry settings are unchanged. The scenario checks no
unhandled page errors and exact owner connection requests at expected epochs
0, 1 and 2, in addition to both peers' exact resulting epochs.

An additional diagnostic ran three mobile executions with 4× CPU throttling,
the same 1.5s ICE delay and a viewport change. All three passed on their first
attempt, with zero retries (27.2s). This uses local Chromium DevTools emulation,
not a physical mobile device. Diagnostic instrumentation remains only under
`/tmp/meshdrop-task06-_na2zbnm/`; no diagnostic hooks were added to production.

## E. Full regression

`CI=true pnpm check` exited 0 in **454.604 seconds (7m34.6s)**. All **868 cases
passed**, comprising the existing 857 plus nine unit cases and two browser
project cases. The full browser/PWA run reported no retries or flaky cases.
No existing assertion was removed or weakened.

| Exact command                                                          | Result | Evidence                                                                                |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `pnpm verify:rollback`                                                 | PASS   | Original P8 local persistence round trip; four runtimes disposed; private files removed |
| `pnpm -r typecheck`                                                    | PASS   | Ten workspace packages/apps                                                             |
| `pnpm typecheck`                                                       | PASS   | Root scripts/tests                                                                      |
| `pnpm lint`                                                            | PASS   | ESLint and formatting                                                                   |
| `pnpm check:secrets`                                                   | PASS   | Also checked after final report updates                                                 |
| `pnpm audit:release`                                                   | PASS   | No known vulnerabilities; unchanged low threshold                                       |
| `pnpm test:unit`                                                       | PASS   | 620 cases, 27 files; 15.22s                                                             |
| `pnpm test:security`                                                   | PASS   | 42 cases, five files; 1.23s                                                             |
| `pnpm test:integration`                                                | PASS   | 75 cases, ten files; 17.93s                                                             |
| `pnpm test:faults`                                                     | PASS   | 18 cases, two files; 3.07s                                                              |
| `pnpm build`                                                           | PASS   | Production build; Worker dry run only                                                   |
| `pnpm test:e2e`                                                        | PASS   | 108 cases; 6.0 minutes; zero retries/flakes                                             |
| `pnpm test:pwa`                                                        | PASS   | Five cases; zero retries                                                                |
| `CI=true pnpm check`                                                   | PASS   | Complete chain, exit 0                                                                  |
| `pnpm exec vitest run --project unit tests/unit/room-recovery.spec.ts` | PASS   | Nine focused cases; original logic failed four of these                                 |

The package scripts, workspace builds, Playwright configuration and local
rollback implementation were inspected before execution. There were no remote
deployment side effects. Hosted GitHub Actions was not triggered or certified.
The audit threshold, dependency lock and overrides remain unchanged.

## F. Security impact

Only the owner still advances epochs through the existing server CAS and
authorization checks. Stale signaling, identity/DTLS binding, signing, replay
protection and independently confirmed pairing are unchanged. The browser
scenario retains its code-change, verification-reset, signed-ping and room
revocation assertions. Comparison rejection still suppresses recovery.

Tasks 03–05 validators, provenance records, read-only preflight, secrets handling
and the blocked publishing boundary are untouched. No release is prepared,
approved or deployed by this work.

## G. Limits

This is bounded local Chromium/mobile-emulation evidence, not a physical Android
or iOS/Safari validation, real-world TURN/NAT test or hosted deployment drill.
Stress passes cannot prove absence of every possible WebRTC race. The diagnostic
does not establish the cause of every historical timeout.

Unit transport doubles isolate controller scheduling; they do not stand in for
the real-browser proof. The real WebRTC diagnostic, repository regression,
50-run stress and full suite provide separate evidence. Temporary instrumentation
is outside the repository and can be removed independently of the fix.

## H. Repository safety

Commits: 0. Pushes: 0. Pull requests: 0. Deployments: 0. Remote modifications: 0.
No live Cloudflare account, production session, migration or secret was accessed
or modified. All changes remain local, unstaged and uncommitted. No branch or
history was changed. Existing artifacts and unrelated local services are retained.

Final hashes preserve 441 of the initial 443 tracked files exactly. Only the
client and affected E2E file changed; the new unit file and report are untracked.
HEAD remains the expected `fd44a45b39e272a81ab28d1ed6dc61c51c3e058e`; nothing is
staged. Tasks 03–05, all workflow files and release-security settings are unchanged.
Local evidence is retained in `/tmp/meshdrop-task06-_na2zbnm/`, including the
original/fixed diagnostic traces, before/after unit results, stress log, related
suite log, audit, rollback result and complete acceptance log/result.

## I. Verdict

**PASS — READY FOR REVIEW.** The supported race and stale-socket failures are
fixed locally, the affected scenario passed 50 consecutive first attempts, and
the full regression passed. This is bounded local evidence, not a universal
WebRTC or production deployment guarantee. Stop after Task 06 for review.
