# Task 10B — rehearsal fault harness and operator readiness

**PASS — READY TO RE-RUN TASK 10 HOSTED REHEARSAL**

All defined local acceptance checks pass. Hosted execution remains NOT RUN;
this document is not release authorization.

## A. Investigation verdict

Initial HEAD exactly matched `068789cd32a8a7ee1c0086cf2c6f7ccdc3ab0467` on main,
with a clean working tree and staging area. No initial user edits were present.
The Task 09 manual-only workflow and Task 10 findings were inspected before editing.
Publication/acceptance/hosted approval blockers and `productionApproved:false`
remained intact. The deployment workflow is separate and unchanged.

Implementation gaps were the five hosted-style fault modes, a structural
pre-dispatch checker, diagnostic evidence/verification integration and witness
contract detail. Operator gaps remain the protected preview environment,
authorized reviewers, real roots/client pins, external TLS stores/roles,
retention/backups and an independently trusted witness. No code pretends to
configure those external dependencies.

## B. Fault harness

The CLI accepts `fault-test replay`, `concurrency`, `lost-ack`, `reconnect` and
`history-integrity`, plus `all` to run the five sequentially in distinct scopes.
Every actual transport operation starts/exits a psql client process. No in-process
lock is used as evidence of database ownership arbitration.

- Replay confirms initial append, duplicate reservation/event rejection, stale-head
  rejection, duplicate evidence rejection and a forged next-attempt claim rejection.
  The cross-attempt probe is deliberately untrusted, not a fabricated second
  authenticated workflow. Human approval IDs are null and NOT APPLICABLE.
- Concurrency races independent clients. Exactly one reservation must win and
  one receive a confirmed server rejection. Losers cannot append/reuse ownership.
  Both clients are joined even on failure before reconciliation can begin.
- Lost-ack saves proposed bytes before mutation, executes a real append, waits for
  client process exit, discards the application acknowledgement and uses a new reader
  to discover committed state. It performs no blind retry. This is a controlled
  post-commit boundary, not a claim that a network partition was induced.
- Reconnect reconstructs history from store/scope/attempt identity after writer
  processes exit; no cached writer head is supplied to the reader and no mutation
  is automatically resumed.
- History integrity rejects missing/deleted-copy, modified, reordered, previous-hash,
  scope, store, attempt, stale-anchor and duplicate variants. These probes mutate
  reader-side copies only; actual stored history is preserved.

All owners remain reserved. Normal completed modes retain three events;
lost-ack/reconnect retain two for reconciliation. Full five-mode execution retains
five owners and thirteen events. No reset, unlock, deletion or automatic rollback
command is implemented.

## C. Hosted workflow

`fault_tests` is a boolean input defaulting to false. The original inspect/produce/
recover path remains available. Opt-in adds a preview-only `faults` job and a
separate `attest-faults` job. Database passwords are mapped only to the fault
command; neither signing job receives them. The fault writer has contents/actions
read only. The fault attester additionally needs OIDC/attestations write.

The workflow remains manual-only, environment-scoped, cancellation-disabled and
pinned to immutable action commits. Exact evidence paths and artifact-ID downloads
are enforced. No deployment aliases, provider mutation imports or Cloudflare
credentials were added. Normal CI validates code and structure without dispatch.

Fault summaries use only PASS, FAIL or NOT_RUN for replayCheck, concurrencyCheck,
lostAckCheck, reconnectCheck and historyIntegrityCheck. Partial failures stop
further modes and preserve available diagnostics; they do not reach the completion
attestation job. Runtime credential cleanup precedes completion output.

The fault report binds original artifact/UUID, repository/source/run/attempt,
store UUID, derived recovery attempt, final head, event counts and result digests.
The separate official attestation signs its exact bytes. Offline `verify-faults`
verifies both parent and fault signatures, certificate identities and payload
binding. Digests alone are not authentication. No real MeshDrop signature was
fabricated for local tests.

## D. Production isolation

Fault mode requires explicit rehearsal-only mode, preview artifact/environment,
exact dedicated environment name/ID, distinct writer/reader configuration and
a `meshdrop_rehearsal_*` database name. Separately configured production
environment/database/store identities are denied before connection.

An administrator-installed server marker additionally pins fault-test-only purpose,
preview, actual database, environment/repository/owner/store IDs, TLS, primary
status and restricted runtime privileges. Superuser/database owner/schema owner,
schema CREATE, generic release append and direct history/ownership writes are
rejected. The existing production recovery SQL was not altered.

These controls assume honest reviewed operator configuration and administrator
ownership. A deliberately mislabeled or compromised administrator is not made
trustworthy by a marker. This task never accessed such an external store.

## E. Witness status

The interface now binds store/head/scope/attempt/sequence, original artifact/UUID,
witness identity/time and a monotonic counter expectation. Known same-database,
history-blob, unsigned-file and fixture proposals are rejected. An unconfigured
external proposal still fails closed. No signature scheme, hosted service or
independent authority was invented. `independentWitnessVerified` remains false.

## F. Files changed

| File                                                 | Reason                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.github/workflows/release-trust-rehearsal.yml`      | Default-off fault input, isolated writer and signing jobs, whitelisted exports           |
| `package.json`                                       | Add read-only `rehearsal:check-config` alias; no dependency change                       |
| `scripts/rehearsal/cli.ts`                           | Guarded fault modes, configuration diagnostics, report signing/verification entry points |
| `scripts/rehearsal/configuration.ts`                 | Structural readiness and exact missing names, credential presence only                   |
| `scripts/rehearsal/fault-contract.ts`                | Preview target guards, scopes/attempts, event/history validation                         |
| `scripts/rehearsal/faults.ts`                        | Stateless database clients, five real fault scenarios and guarded hosted factory         |
| `scripts/rehearsal/fault-report.ts`                  | Artifact binding, result digests, check states and report validation                     |
| `scripts/rehearsal/fault-store.sql`                  | Manual-install-only isolated marker and restricted fault RPCs                            |
| `scripts/rehearsal/preflight.ts`                     | Reject production plus fault input before environment GET                                |
| `scripts/rehearsal/recovery.ts`                      | Explicit NOT_RUN fields for all optional faults in normal summaries                      |
| `scripts/rehearsal/witness.ts`                       | Expand future witness contract and reject untrusted proposals                            |
| `tests/fixtures/rehearsal-faults.ts`                 | Explicit offline fixture settings and public certificate material                        |
| `tests/fixtures/rehearsal-workflow.ts`               | Extend strict job/action/permission/secret/command rules                                 |
| `tests/unit/rehearsal-faults.spec.ts`                | Production/configuration/history/witness/CLI and real fixture-promotion rejection tests  |
| `tests/unit/rehearsal-workflow.spec.ts`              | Keep existing assertions, add optional-job mutation cases and import checks              |
| `tests/release-trust/rehearsal-faults.spec.ts`       | Real isolated TLS database fault, privilege, rollback and no-retry cases                 |
| `docs/hosted-trust-rehearsal.md`                     | Describe optional jobs and correct canonical repository URL in normal scope example      |
| `docs/hosted-rehearsal-faults.md`                    | Exact Task 10 operator configuration, dispatch, download and verification steps          |
| `docs/reports/hosted-rehearsal-faults-2026-11-07.md` | Investigation and validation evidence                                                    |

Application features, WebRTC/protocol assertions, production persistence schemas,
security overrides, lockfile, normal CI and deployment workflow were not changed.
All existing 1,107 tests are preserved. Existing workflow-structure expectations
were extended to cover additional optional jobs without removing old safety cases.

## G. Tests

| Exact command                                                                                                                                                                                                    | Final result           | Evidence                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `pnpm verify:rollback`                                                                                                                                                                                           | PASS                   | Current/historical/roll-forward, authorization/drain; 4/4 runtimes disposed |
| `pnpm -r typecheck`                                                                                                                                                                                              | PASS                   | All workspace projects                                                      |
| `pnpm typecheck`                                                                                                                                                                                                 | PASS                   | Root TypeScript                                                             |
| `pnpm lint`                                                                                                                                                                                                      | PASS                   | ESLint and Prettier                                                         |
| `pnpm check:secrets`                                                                                                                                                                                             | PASS                   | No matching credentials                                                     |
| `pnpm audit:release`                                                                                                                                                                                             | PASS                   | No known vulnerabilities; existing low threshold                            |
| `pnpm test:unit`                                                                                                                                                                                                 | PASS (unchanged rerun) | 896 passed                                                                  |
| `pnpm test:security`                                                                                                                                                                                             | PASS                   | 42 passed                                                                   |
| `pnpm test:integration`                                                                                                                                                                                          | PASS                   | 75 passed                                                                   |
| `pnpm test:faults`                                                                                                                                                                                               | PASS                   | 18 passed                                                                   |
| `pnpm test:release-store`                                                                                                                                                                                        | PASS                   | 46 passed                                                                   |
| `pnpm build`                                                                                                                                                                                                     | PASS                   | Workspace production build; Worker dry-run only                             |
| `pnpm test:e2e`                                                                                                                                                                                                  | PASS                   | 108 passed                                                                  |
| `pnpm test:pwa`                                                                                                                                                                                                  | PASS                   | 5 passed                                                                    |
| `CI=true pnpm check`                                                                                                                                                                                             | PASS                   | All 1,190 tests; browser/PWA no retries                                     |
| `/tmp/meshdrop-task10b-tools/actionlint/actionlint -config-file /tmp/meshdrop-task10b-tools/actionlint.yaml .github/workflows/ci.yml .github/workflows/deploy.yml .github/workflows/release-trust-rehearsal.yml` | PASS                   | All three workflows                                                         |

Final total: **1,190 cases** — 896 unit, 42 security, 75 integration, 18 faults,
46 release-store, 108 E2E and 5 PWA. All 1,107 original cases remain intact.
The 83 additive cases are 61 fault unit cases, 6 workflow mutation cases and
16 real local TLS PostgreSQL fault/privilege cases. Existing test assertions,
security threshold and normal CI retries/timeouts were not weakened.

The initial `pnpm test:unit` invocation exited 1: one unchanged network-history
case exceeded its existing 5,000 ms limit; 895 cases passed. The exact standalone
command then passed all 896 without a source/configuration change (that case
3,616 ms). `CI=true pnpm check` also passed all 1,190, including that unchanged
case in 3,556 ms. No automatic unit retry was added. The initial batch exit 1
and original logs remain retained; final per-check success incorporates the
explicit rerun. The transient timeout's cause was not conclusively established.

Both E2E runs passed 108 cases and both PWA runs passed 5 without browser retries.
The Task 06 peer/reconnect assertions and application code remain unchanged.
Full CI-style check completed successfully in 475.35 seconds.

The read-only configuration command was also executed with no credentials.
It correctly exited 1 with NOT_READY_FOR_HOSTED_REHEARSAL, exact missing names,
all three secret presence indicators false and databaseConnectionAttempted false.
Positive structural READY and negative production/credential/fixture cases pass
in automated tests. READY is not a claim that external settings were configured.

Actionlint 1.7.7 uses a local configuration recognizing only the repository's
existing ubuntu-26.04 label; syntax/expression/permission checks are not ignored.
Official Node/actionlint checksums were verified when temporary tools had to be
restored after interruption. Node 24.22.2 and pnpm 10.34.7 were used. No global
package was installed. Validation logs and initial/final status records are in
ignored `.meshdrop-artifacts/task10b-validation`, including `results.json`,
`final-results.json`, `unit-rerun.log`, `missing-configuration.json`,
`source-review.json` and `cleanup.json`. Raw browser logs are not release evidence
and are not uploaded by the rehearsal.

## H. Operator configuration

Follow [the operator runbook](../hosted-rehearsal-faults.md). The human must create/
review the dedicated preview environment, reviewers/self-review prevention and
main-ref restrictions; pin immutable IDs and reviewed roots/tools; configure
normal and separate fault stores with TLS, restricted roles and reviewed schema
installation; establish retention/backups; and run `pnpm rehearsal:check-config`.

The checker is read-only and structural. READY does not authenticate GitHub
settings or a provider. Missing inputs return exact names and nonzero status;
secrets are only present true/false. Real signature/file/marker/role checks still
execute before database writes in a future human-run workflow.

After separate review and authorization of publishing these source changes, the
human may dispatch preview with fault_tests:true and the exact new reviewed
source SHA/ref. Task 10B does not commit, push, change pins to bypass failures or
dispatch. The older baseline SHA does not contain these uncommitted additions.

## I. Hosted rehearsal status

**NOT RUN.** No authenticated GitHub account request, environment/secret creation,
hosted attestation, external database connection or hosted fault test occurred.
All database writes were confined to disposable local fixtures. Local fixtures
retain their offline label and cannot become provider-confirmed hosted success.
Human authorization, hosted root/configuration and independent witness evidence
remain unverified. Publication/acceptance/production approval remain false.

## J. Git and production safety

Commits: 0. Pushes: 0. PRs: 0. Deployments: 0. Cloudflare mutations: 0.
GitHub settings changes: 0. Hosted workflow dispatches: 0. Production migrations,
admission changes, live-session access and production-secret changes: 0.

All changes remain local, unstaged and uncommitted on the requested main baseline.
No history reset, rewrite or branch switch was performed. All test containers were disposed and temporary browser ports 5173, 8787, 4173
and 8788 are closed. Final source review confirms no staged changes and the
requested HEAD is unchanged. Protected application/package/E2E/PWA/deployment
files, original recovery SQL, dependency versions/overrides and audit threshold
are unchanged. Only the nineteen listed local files changed or were added.

## K. Final verdict

**PASS — READY TO RE-RUN TASK 10 HOSTED REHEARSAL**

The local implementation gaps and defined automated cases are complete. The
operator must separately review these uncommitted changes, authorize any future
source publication, configure the preview environment/stores and manually run
Task 10 on the exact reviewed source commit. The first timing-sensitive unit
failure is disclosed above; unchanged rerun and full CI-style validation pass.

Real MeshDrop hosted attestation, external store behavior, authenticated human
authorization, hosted configuration and independent witnessing remain unverified.
No local result or signature fixture approves publication, acceptance, rollback
or production deployment. Task 10B stops here.
