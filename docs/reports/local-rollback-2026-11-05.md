# Legacy local rollback verification — 5 November 2026

## Verdict and original failure

**CONFIRMED HARNESS INCOMPATIBILITY — repaired locally.**

Investigation started on branch `main`, HEAD
`b103d568d7d2bed62957f4c129dc238a5b7752f6`, with a clean working tree.
Validation uses Node 24.22.2 and the repository's pnpm 10.34.7.
The Task 01 minimatch 11.0.1 override, lockfile and security documentation
remain unchanged.

Before modification, `pnpm verify:rollback` exited 1:

```text
Uncaught TypeError: Class extends value undefined is not a constructor or null
  at __mf_do_wrapper.js:40:6 in createDurableObjectWrapper
  at __mf_do_wrapper_entry.js:6:26
MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start.
```

The original script's first historical status request (then line 55) triggered
lazy initialization. The failure happened before any historical persistence
assertion. The harness configured `SessionRoom`, `RelayPool` and
`OperationsMonitor` even when supplied the historical script. Its wrappers tried
to extend undefined exports for the two newer classes.

The baseline is still exactly
`e108e7a1f59bc37f41ba703240e08f176d47b33c`. Its signaling entry exports only
`SessionRoom`; its Wrangler configuration declares only `SESSION_ROOMS` and the
v1 SQLite migration. It has neither newer actor class. Comparing its
`SessionRoom.ts` with the current source shows the added operator-revoke branch,
with no change to the session SQL schema. The shared protocol and shared-types
sources are byte unchanged. Actual persisted-state tests establish compatibility
for the session scenario below.

## Focused changes

- `tests/integration/harness.ts`: optional typed `durableObjects` configuration.
  Omitting it preserves all three existing bindings and all other defaults.
- `scripts/deploy/verify-rollback.ts`: retains the existing command and baseline
  override environment variable, calling an importable local verifier.
- `scripts/deploy/local-rollback.ts`: explicit room-only historical binding map,
  baseline/export preflight, real SQLite assertions, authorization/drain checks,
  isolated resources and a sanitized report. No version-name matching.
- `tests/unit/local-rollback.spec.ts`: seven focused preflight/cleanup tests.
- `tests/integration/local-rollback.spec.ts`: seven real local runtime scenarios.
- `.github/workflows/ci.yml`: full history for the core job's checkout, so its
  integration tests can compile the exact historical commit. Browser checkout,
  job dependencies, timeouts, security policy and release gates are preserved.
- This report: investigation, reproduction, results and scope limits.

No production source, persisted schema, dependency, lockfile, security threshold,
README or media changed. No new package was installed.

## What the rollback proof exercises

Each invocation uses its own generated `run-*` directory. The verifier compiles
the exact historical signaling sources using read-only Git operations. It
checks the resulting exports before starting the historical runtime. It fails
before runtime creation if the baseline is unavailable or the shared source
contracts differ, rather than silently compiling a hybrid historical Worker.

The four runtimes use the same local persistence directory and Worker name.
Each previous runtime is disposed before the next starts. Outbound Worker
network requests are blocked. No Wrangler deployment or Cloudflare API is used.

1. Start the current Worker with all three default Durable Object bindings;
   await runtime readiness and a successful health response.
2. Create a room, admit and approve a receiver. Read and validate both owner and
   receiver status against the real protocol schema. Capture all rows and table
   definitions for `room_meta`, `invites`, `peers`, `ticket_nonces` and
   `security_windows` in memory.
3. Stop the current Worker; start the original P8 Worker with only
   `SESSION_ROOMS`. Before the first room HTTP read, require the actual persisted
   rows and schema to equal the preceding snapshot. Read the approved room with
   both valid capabilities. Check room/peer identity, roles, membership, approval,
   expiry, epoch and the complete status against the original approved status.
4. Stop P8; start the current Worker with all default bindings. Repeat the exact
   persistence, approved-status and authorization checks.
5. Restart the current Worker with `ADMISSION_PAUSED=true`. Repeat persistence
   and authorization checks; require room creation to return 503. The existing
   owner can still read and close the room; closure returns state `closed` and
   subsequent owner/receiver status requests return 410.
6. Dispose the last runtime and remove only this invocation's extracted source
   and private state. Retain a sanitized `report.json` with stage names, baseline,
   result and cleanup counts, without capabilities, session IDs or SQL contents.

At every session-reading stage, missing authorization returns 401, fabricated
and invitation capabilities return 403 for status, fabricated/invitation and
receiver capabilities cannot close the room, and the receiver cannot exercise
owner approval. The owner status is unchanged after these denied operations.

The CLI successfully reported all six stages, four runtimes started and four
disposed, with both cleanup flags true. The integration proof also checks that
runtime health ports no longer respond after disposal and that an unrelated
artifact sentinel survives.

## Failure behavior and regression coverage

The focused tests verify that missing `SessionRoom` exports, malformed or
unavailable baseline commits, latest-only historical bindings, mismatched
persistence, corrupted roll-forward approval, failed admission drain and failed
runtime initialization cannot produce a successful result. Failed assertions
and startup failures dispose the runtime and remove private test resources.

The pinned Miniflare version finishes disposal, prioritizes any independent
cleanup error, then rethrows its original readiness error after failed startup.
The verifier recognizes only that exact recorded error object as completed
disposal; the original startup failure still fails verification. A separate
cleanup error, even one with the same message, propagates. Unit tests cover this
distinction. A real-runtime integration fixture disposes its runtime then
injects an independent cleanup error: the verifier reports failure, does not
claim cleanup succeeded, retains private files when disposal cannot be
confirmed, and keeps the error canary out of the report. The test's own cleanup
removes only its disposable directory.

## Reproduction and local validation

Use Node 24, pnpm 10.34.7, the frozen repository dependencies, and local
Playwright engines/host libraries. Existing local browser installations were
used in this session. Ensure the baseline commit is available in the local Git
object database; the verifier never fetches history automatically.

```bash
git cat-file -e e108e7a1f59bc37f41ba703240e08f176d47b33c^{commit}
pnpm verify:rollback
pnpm audit:release
CI=true pnpm check
```

`pnpm check` executes the repository's package/root type checks, lint, secret
check, unit, security, integration, fault, build, browser and PWA scripts. Worker
build uses `wrangler deploy --dry-run`; browser servers are local Wrangler/Vite
servers. No remote verification, operation or deployment script is run.

The full `CI=true pnpm check` pipeline passed with exit 0 in **6m57.6s**.
Its constituent scripts were executed by the existing script chain, rather
than substituting new commands. No test was skipped or weakened.

| Check                 | Command                               | Result                      | Evidence                                                                     |
| --------------------- | ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| Original reproduction | `pnpm verify:rollback` before changes | FAIL, expected reproduction | Historical initialization, `ERR_RUNTIME_FAILURE`                             |
| Repaired rollback     | `pnpm verify:rollback` after changes  | PASS                        | Original baseline; four runtimes started/disposed; private resources removed |
| Package TypeScript    | `pnpm -r typecheck`                   | PASS                        | All ten workspace packages/apps                                              |
| Root TypeScript       | `pnpm typecheck`                      | PASS                        | No diagnostics                                                               |
| Lint and formatting   | `pnpm lint`                           | PASS                        | ESLint and Prettier                                                          |
| Secrets               | `pnpm check:secrets`                  | PASS                        | Rechecked after adding this report                                           |
| Unit                  | `pnpm test:unit`                      | PASS                        | 413 tests, 23 files; 4.90s                                                   |
| Security              | `pnpm test:security`                  | PASS                        | 42 tests, 5 files; 1.19s                                                     |
| Integration           | `pnpm test:integration`               | PASS                        | 72 tests, 8 files; 12.65s                                                    |
| Fault injection       | `pnpm test:faults`                    | PASS                        | 18 tests, 2 files; 2.89s                                                     |
| Production build      | `pnpm build`                          | PASS                        | Workspace build; Worker dry run only                                         |
| Browser               | `pnpm test:e2e`                       | PASS                        | 106 tests; 5.7 minutes                                                       |
| PWA                   | `pnpm test:pwa`                       | PASS                        | 5 tests; 20.1s                                                               |
| Release audit         | `pnpm audit:release`                  | PASS                        | No known vulnerabilities; unchanged low threshold                            |
| Aggregate validation  | `CI=true pnpm check`                  | PASS                        | Entire existing chain completed; exit 0                                      |

In total, **656 tests passed**, including the fourteen new rollback tests.
`pnpm why minimatch` confirms a single resolved version, **11.0.1**.
Actionlint 1.7.12 also passed both workflow files, using the existing temporary
runner-label configuration that recognizes `ubuntu-26.04`. No workflow gate or
dependency was removed.

Final tracked-file hashes matched the initial snapshot for all 414 files
outside the three intentional tracked edits. The four added files are the
verifier module, its two test files and this report. HEAD remained unchanged;
nothing was staged. Private data left by this task's original failed
reproduction was removed from that invocation alone; older artifact runs were
preserved.

## Limits and repository safety

This is a **local Miniflare/workerd session SQLite compatibility proof**. It
does not execute a Cloudflare deployment rollback, reverse a migration, certify
database backup restoration, preserve live WebSockets, or cover every session
state and distributed timing scenario.

Current hosted configuration includes v2 `RelayPool` and `OperationsMonitor`
actors. The historical v1-only Worker is **not a valid unchanged target for
that v2 configuration**. The compatible historical binding map is deliberately
local. Production rollback requires a separately verified compatible v2 target
or compatibility adapter retaining required actor exports and bindings; this
task neither implements nor deploys such a strategy. Existing hosted rollback
evidence and release requirements are not reclassified by this local test.

No hosted CI run was triggered. Local checks cannot establish hosted CI success
or production rollback readiness. No commits, pushes, pull requests,
deployments, publications or remote resource changes were made. All changes
remain local and uncommitted. Task 02 stops for review here.
