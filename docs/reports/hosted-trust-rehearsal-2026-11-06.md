# Task 09 — Hosted trust rehearsal investigation and validation

**PASS — READY FOR HUMAN HOSTED REHEARSAL**

Local acceptance gates pass. Hosted execution was not performed and release
authorization remains unestablished.

## A. Investigation verdict

MeshDrop can prepare a non-deploying, human-dispatched hosted rehearsal using
official artifact attestations and the existing transactional PostgreSQL
recovery engine. Real MeshDrop attestation production, hosted database access,
GitHub environment configuration, human authorization and an independent latest
recovery-head witness were not exercised or authenticated during this task.

The actual clean starting checkout was `main` at
`b791fd40b4bfa78158576d4804d7b33f0f66af42`. The requested
`6c30b19f42dc02211cfbd2d4c10fb810701ed5ed` was absent locally. After the
operator confirmed the local code was current, work continued on the existing
branch without changing history. Initial tracked and untracked status was clean.

Before modification, these release blockers were verified and preserved:

- `hostedProvider()` throws `HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED`.
- Hosted publication rejects with `HOSTED_PUBLICATION_DISABLED`.
- Hosted acceptance rejects with `HOSTED_ACCEPTANCE_AUTHORITY_NOT_CONFIGURED`.
- `hostedApprovalAuthority()` and `hostedRecoveryStore()` remain unconfigured.
- Rollback diagnostics retain unconditional `productionApproved: false`.
- Offline provider/approval fixtures cannot be promoted to authenticated evidence.

## B. Workflow design

The new workflow has only `workflow_dispatch`, explicit preview/production
inputs, independently expected SHA/ref, environment-scoped concurrency and
`cancel-in-progress: false`. Six maintained official action versions are pinned
to exact commits. It never invokes the deployment workflow or application build.

| Job       | Permissions                                                | Function                                                                                                                             |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `inspect` | `contents: read`, `actions: read`                          | GET existing dedicated environment; check identity and reviewer policy before emitting its name                                      |
| `produce` | `contents: read`, `id-token: write`, `attestations: write` | Environment gate; canonical metadata; official attestation; offline verification; immutable upload                                   |
| `recover` | `contents: read`, `actions: read`                          | Separate environment gate; exact artifact-ID download; repeated signature verification; rehearsal-only evidence transaction/readback |

No deployment permission or Cloudflare credential is requested. The dedicated
database password is exposed only to the recovery step. Normal CI runs the new
tests, not a hosted rehearsal. No repository environment or settings were changed.

## C. MeshDrop attestation

The canonical artifact has a version, purpose `trust-rehearsal`, exact repository,
numeric repository/owner IDs, environment, source SHA/ref, workflow, run/attempt,
UUID, optional prepared-manifest reference, UTC timestamp, payload fingerprint
and false publication/acceptance/production flags. It is bounded to 8 KiB.

Actual `gh attestation verify` verifies signature, chain, signed timestamp,
reviewed trusted roots, GitHub OIDC issuer, GitHub-hosted runner, exact workflow
SAN/build signer URI, immutable signer digest, source repository/owner IDs,
source/workflow SHA/ref, run/attempt, SLSA v1 predicate and complete file digest.
Canonical metadata and independently supplied expectations are then checked.

A real ordinary-workflow certificate uses a ref in its signer URI, with a
separate signer commit digest. The original Task 08 fixture used a SHA-pinned
reusable workflow URI. A version 2 policy supports exact signer ref **and** exact
signer commit; version 1 behavior and all old identity checks remain intact.

Positive cryptographic tests use real public upstream GitHub CLI fixtures:
`actions/attest-demo` and the existing reusable-workflow fixture. They are not
MeshDrop attestations. No custom signer or fabricated MeshDrop certificate was
created. Public roots were fetched read-only with an empty authentication
environment; automated verification is offline.

Every successful rehearsal verification still returns signature verification
only, with `authorizationVerified`, `publicationEnabled`, `acceptanceEnabled`
and `productionApproved` all false. Serialized flags cannot create the private
in-process receipt required to select hosted rehearsal storage.

## D. Recovery rehearsal

The adapter requires explicit host, port, database, user, TLS CA, password file,
store UUID, environment, attempt UUID, CA hash and client binary hash. The
workflow uses a dedicated environment secret to create a private password file.
There is no local fallback or schema installation.

Every session checks the exact database/user, primary status and actual TLS
state. Libpq uses hostname/CA verification and bounded timeouts. The existing
SQL functions enforce scope ACLs, store identity, transactional ownership,
head compare-and-swap and unique attempt IDs. The rehearsal scope includes
`purpose: trust-rehearsal`, separating it from production release scopes.

Exactly three events are written: RESERVED, EVIDENCE, CLOSED. Every record stays
PREPARED, has a null approval and false capability flags. Receipts and the full
history are checked. Partial writes remain owned for operator reconciliation;
no automatic retry, unlock, rollback, publication or acceptance exists. Success
files/status are emitted only after private credential cleanup succeeds.

Hosted destructive replay/concurrency probes are intentionally NOT RUN; those
failure cases are tested against isolated PostgreSQL. The summary states this
explicitly and never turns a normal hosted append into a claim that every
failure-injection scenario was exercised.

## E. Independent witness

`RecoveryWitness` defines independently authenticated latest-head expectations,
including scope/run/attempt and freshness. Its hosted factory deliberately
throws `INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED`.

An Actions artifact or a signed historical head can authenticate retained bytes,
but does not establish latest-head completeness or retention. Object-lock
versions also require additional trusted latest-head semantics. A second store
under the same administrator is not independent. Operator-provided storage,
access controls, backups, retention and a separately administered witness remain
external requirements. No hosted durability claim is made.

## F. Files changed

| File                                                         | Justification                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `.github/workflows/release-trust-rehearsal.yml`              | Manual, least-privilege, environment-scoped three-job rehearsal                                     |
| `scripts/rehearsal/contract.ts`                              | Exact bounded canonical artifact, identity expectations and false capability flags                  |
| `scripts/rehearsal/preflight.ts`                             | Read-only environment inspection and exact GitHub runtime identity checks                           |
| `scripts/rehearsal/verification.ts`                          | Exact MeshDrop attestation policy and private verification receipt                                  |
| `scripts/rehearsal/recovery.ts`                              | Separate rehearsal domain, explicit TLS database configuration, receipt/history validation          |
| `scripts/rehearsal/witness.ts`                               | Strict independent-witness interface with disabled hosted implementation                            |
| `scripts/rehearsal/cli.ts`                                   | Sanitized preparation/verification/rehearsal/history commands; no deploy verbs                      |
| `scripts/deploy/github-attestation.ts`                       | Versioned ref-based signer policy; extracted post-crypto identity guard for negative tests          |
| `scripts/deploy/postgres-connection.ts`                      | Existing bounded libpq transport isolated from release lifecycle imports                            |
| `scripts/deploy/postgres-recovery.ts`                        | Re-export the extracted transport without changing existing store behavior                          |
| `tests/unit/rehearsal.spec.ts`                               | 68 canonical identity, configuration, negative policy, environment and CLI tests                    |
| `tests/unit/rehearsal-workflow.spec.ts`                      | 14 workflow mutation and executable import-boundary tests                                           |
| `tests/unit/rehearsal-attestation.spec.ts`                   | 6 real offline ref-based certificate verification/substitution tests                                |
| `tests/release-trust/rehearsal.spec.ts`                      | 12 real local TLS PostgreSQL success, isolation, conflict, interruption and tampering tests         |
| `tests/release-trust/postgres.spec.ts`                       | Capture narrowed Docker configuration across an asynchronous closure; existing assertions unchanged |
| `tests/fixtures/rehearsal.ts`                                | Explicit offline fixtures; shape-only certificates never issue authenticated receipts               |
| `tests/fixtures/rehearsal-workflow.ts`                       | Restricted YAML parsing and action/permission/command/output allowlists                             |
| `tests/fixtures/sigstore/workflow-artifact`                  | Public upstream wheel bytes, never installed or executed                                            |
| `tests/fixtures/sigstore/workflow-attestation.sigstore.json` | Real upstream ref-based workflow attestation                                                        |
| `tests/fixtures/sigstore/workflow-roots.jsonl`               | Public verification roots snapshot for the upstream fixture only                                    |
| `tests/fixtures/sigstore/README.md`                          | Fixture origin, byte preservation and trust limitations                                             |
| `.gitignore`                                                 | Keep generated rehearsal evidence out of source control                                             |
| `.prettierignore`                                            | Preserve exact upstream JSONL root bytes                                                            |
| `docs/hosted-trust-rehearsal.md`                             | Seven-step operator runbook, exact external configuration and threat model                          |
| `docs/reports/hosted-trust-rehearsal-2026-11-06.md`          | Investigation, safety boundaries and validation evidence                                            |

No application, protocol, schema, lockfile, normal CI or deployment-workflow
changes were made. No dependency was added. The minimatch override and all
existing release gates are preserved.

## G. Testing

| Exact command                                                                                                                                                              | Result | Cases / evidence                                                                        | Seconds |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ------- |
| `pnpm verify:rollback`                                                                                                                                                     | PASS   | Current → historical → current; authorization/drain pass; 4/4 runtimes disposed         | 4.08    |
| `pnpm -r typecheck`                                                                                                                                                        | PASS   | All workspace projects                                                                  | 7.04    |
| `pnpm typecheck`                                                                                                                                                           | PASS   | Root TypeScript                                                                         | 3.82    |
| `pnpm lint`                                                                                                                                                                | PASS   | ESLint and Prettier                                                                     | 8.48    |
| `pnpm check:secrets`                                                                                                                                                       | PASS   | No findings                                                                             | 0.32    |
| `pnpm audit:release`                                                                                                                                                       | PASS   | No known vulnerabilities; existing low threshold                                        | 1.22    |
| `pnpm test:unit`                                                                                                                                                           | PASS   | 829 passed                                                                              | 20.52   |
| `pnpm test:security`                                                                                                                                                       | PASS   | 42 passed                                                                               | 1.78    |
| `pnpm test:integration`                                                                                                                                                    | PASS   | 75 passed                                                                               | 17.99   |
| `pnpm test:faults`                                                                                                                                                         | PASS   | 18 passed                                                                               | 3.79    |
| `pnpm test:release-store`                                                                                                                                                  | PASS   | 30 passed                                                                               | 17.86   |
| `pnpm build`                                                                                                                                                               | PASS   | Successful workspace build; Worker dry-run only                                         | 11.01   |
| `pnpm test:e2e`                                                                                                                                                            | PASS   | 108 passed                                                                              | 349.23  |
| `pnpm test:pwa`                                                                                                                                                            | PASS   | 5 passed                                                                                | 21.83   |
| `CI=true pnpm check`                                                                                                                                                       | PASS   | All 1,107 tests repeated; type/lint/secrets/build also pass                             | 463.54  |
| `actionlint -config-file /tmp/meshdrop-task01b-aTvOk3/actionlint.yaml .github/workflows/ci.yml .github/workflows/deploy.yml .github/workflows/release-trust-rehearsal.yml` | PASS   | Actual executable: `/tmp/meshdrop-task01b-aTvOk3/actionlint/actionlint`; no diagnostics | —       |

All 1,007 existing cases and 100 additive cases pass: 829 unit, 42 security,
75 integration, 18 faults, 30 release-store, 108 E2E and 5 PWA = **1,107**.
The new cases comprise 68 rehearsal unit cases, 14 workflow/import tests,
6 real certificate verification cases and 12 TLS PostgreSQL cases. The full
CI-style check repeated all 1,107 successfully after the final CLI cleanup
change. Both browser runs and both PWA runs had zero failed cases/retries.
No CI retry or timeout settings were changed. Local success is not hosted CI
or hosted rehearsal success. Node 24.22.2 and pnpm 10.34.7 were used.

Additional read-only rollback diagnostics intentionally exited 1:

```sh
pnpm verify:rollback-target b791fd40b4bfa78158576d4804d7b33f0f66af42 e108e7a1f59bc37f41ba703240e08f176d47b33c
pnpm verify:rollback-target b791fd40b4bfa78158576d4804d7b33f0f66af42 b791fd40b4bfa78158576d4804d7b33f0f66af42
```

The first correctly rejected missing OperationsMonitor/RelayPool, bindings,
gateway, migration and source incompatibilities. The second reported source
compatibility but rejected missing complete release archives/provenance. These
are PASS for the expected fail-closed behavior, not successful rollback approval.

| Hosted check                                | Result  | Reason                                        |
| ------------------------------------------- | ------- | --------------------------------------------- |
| MeshDrop self-attestation production        | NOT RUN | Human dispatch explicitly out of scope        |
| Real GitHub environment/reviewer inspection | NOT RUN | No authenticated external account calls       |
| External recovery store append/readback     | NOT RUN | Operator configuration/authorization required |
| Independent latest-head witness             | NOT RUN | Hosted implementation disabled                |
| Authenticated human release approval        | NOT RUN | Existing authority remains unconfigured       |
| Cloudflare publication/acceptance           | NOT RUN | Prohibited and blocked                        |

Development checks caught and corrected a fixture setup problem copying into a
read-only container, a quoted-string error in the new database session guard,
and the need for matching GitHub roots for the real ordinary-workflow fixture.
Sandbox-denied child processes were rerun with permission. None of those failed
or skipped attempts is counted as a passing acceptance run. During browser
network/reload fault scenarios, local dev servers emitted broken-pipe/reset
warnings; the case results still passed without retries.

Detailed command logs, durations, source hash comparisons and cleanup evidence
are retained locally under `/tmp/meshdrop-task09-vvq_3j90` (`results.json`,
`source-review.json`, `cleanup.json` and individual command logs). No sensitive
provider/database values are included in this report.

## H. Security boundaries

Structural mutation tests reject added deployment commands/permissions,
Cloudflare credentials, registry publication, wildcard uploads, artifact
substitution, unprotected environments and ignored failures. A TypeScript import
graph test rejects executable paths to lifecycle, provider or deployment modules.
Forbidden deploy/publish/accept/migrate/rollback CLI verbs fail closed.

Existing Tasks 03–08 tests preserve rollback rejection, provenance, admission,
read-only provider, approval, journal and WebRTC protections. Historical P8 is
still rejected for missing newer actors/bindings/gateway and incompatible
migration history. Source equality still cannot authorize rollback without
release archives and provenance. Both diagnostic cases retain
`productionApproved: false` and intentionally return nonzero.

The exact completion message remains:

`HOSTED_TRUST_REHEARSAL_COMPLETE — RELEASE AUTHORIZATION NOT ESTABLISHED`

## I. Hosted operator requirements

Follow [the seven-step runbook](../hosted-trust-rehearsal.md): configure dedicated
protected environments and immutable identity pins; independently review source,
roots and tool binaries; separately provision a scoped TLS evidence database;
then a human may dispatch, export, verify offline, reconcile history and review
limitations. No automated configuration or hosted dispatch was performed here.

Human release authorization, live provider/admission observations and an
independent latest-head witness remain unresolved release prerequisites.
GitHub job approval alone is insufficient. A successful future rehearsal cannot
approve publication or acceptance and cannot prove production rollback safety.

## J. Git safety

Commits: 0. Pushes: 0. Pull requests: 0. Deployments: 0. Cloudflare mutations: 0.
Hosted rehearsal executions: 0. Remote settings/resources modified: 0.

All 25 changed/new files remain local, unstaged and uncommitted. HEAD remains
`b791fd40b4bfa78158576d4804d7b33f0f66af42` on `main`; there are no staged changes.
Baseline hashes confirm all tracked application/package sources, lockfile, audit policy,
normal CI, deploy workflow, lifecycle/approval/Cloudflare/rollback protections
and recovery SQL schema remain unchanged. Initial user modifications: none.

Rollback runtimes: 4 started, 4 disposed; private rollback files removed.
Task 08/09 test containers remaining: 0. Temporary test ports 5173, 8787, 4173
and 8788 are closed. Pre-existing services on 8794 and 9222 remain untouched.
No persistent manual application services were started.

## K. Final verdict

**PASS — READY FOR HUMAN HOSTED REHEARSAL**

The reviewed local implementation and all defined local acceptance cases pass.
A human must separately configure, review and authorize the future rehearsal.
This is not release approval, proof of hosted durability, authenticated human
authorization, a hosted CI result or permission to deploy. Publication,
acceptance, automatic rollback and production approval remain disabled.
Task 09 stops here.
