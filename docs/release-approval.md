# Release approval and recovery evidence

Task 07 adds local verification contracts and failure tests. **Hosted publication
and hosted acceptance remain disabled.** `hostedApprovalAuthority()` and
`hostedRecoveryStore()` throw because neither a trusted GitHub approval authority
nor independently durable storage is configured. No credentials, signing keys,
approver IDs or external authority are provisioned by this work.

The contracts are in `scripts/deploy/release-approval.ts` and
`scripts/deploy/recovery-evidence.ts`. They support a future reviewed integration;
they are not an executable hosted release or approval command. An implementation
of a TypeScript interface is a trusted dependency, not authentication by itself.
There is no environment variable that enables publication or approval.

## Trust boundaries and documented GitHub guarantees

| Boundary                        | Present evidence                                                                                | What is still required                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Git source → preparation        | Exact commit/tree and canonical manifest/artifact hashes                                        | Independently trusted builder, source review and artifact provenance                                               |
| Prepared artifacts → runner     | Strict manifest and inventories                                                                 | Authenticated producer and protected workflow/toolchain; unsigned downloaded JSON is untrusted                     |
| Runner → Cloudflare observation | Task 05 validates scope, active IDs and explicit admission; injected transports remain fixtures | Authorized authenticated readback, provider-to-artifact correlation and runtime checks                             |
| Human → approval                | Release-bound claim parser and verification interface                                           | Independently authenticated human review, immutable actor IDs, role policy, revocation and pinned trusted verifier |
| Approval → decision             | Purpose, release, provider, role, freshness and replay checks                                   | Trusted authority and atomic durable consumption; no self-asserted boolean                                         |
| Runner → recovery store         | Write-ahead sink, sequence/hash chain, CAS interface, local SQLite tests                        | Authenticated off-run storage, independent head/checkpoint, retention and atomic environment ownership             |
| Archive → rollback eligibility  | Existing provenance checks and unconditional CLI `productionApproved: false`                    | Authenticated complete archive, compatible target and authorized hosted validation                                 |

[GitHub environment reviews](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)
gate job progress and access to environment secrets. They do not sign a downloaded
JSON record. Protection configuration and reviewer eligibility were not inspected
against this repository's hosted settings.

[GitHub OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect)
authenticates workflow execution claims. The triggering actor is not necessarily
the approving reviewer. Verify the actual repository's subject configuration;
do not infer an immutable repository identity from a display name or assume one
universal subject format.

[Artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
can authenticate an artifact digest and producer identity. They do not make an
arbitrary predicate truthful or establish a human's authorization. A compromised
producer can sign misleading contents. The future authority must independently
verify both the pinned producer and human review/revocation evidence.

The documented [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify)
supports offline bundles and explicit trusted-root, issuer, certificate identity,
signer workflow/commit and source constraints. Those constraints, trust roots and
verified output schema must be reviewed before an adapter is installed. No `gh`
verifier, OIDC exchange, signing service or authenticated account request was
executed in this task. No GitHub authority is simulated as production trust.

## Versioned approval contract

Canonical JSON uses the existing sorted-key serializer. `ApprovalClaim` version
1 accepts only these fields; unknown fields and secret-bearing extras fail:

| Fields                                                      | Binding                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `approvalId`                               | Version 1 and unique UUID, consumed atomically across attempts                                                  |
| `repository`, `environment`, `sourceCommit`, `manifestId`   | Exact repository, preview/production, 40-character commit and manifest digest                                   |
| `attemptId`, `runId`, `runAttempt`, `requestedById`         | Exact attempt UUID, workflow run/attempt and immutable initiator ID                                             |
| `purpose`, `decision`                                       | Publication: `AUTHORIZE`/`REJECT`; acceptance: `ACCEPT`/`REJECT`                                                |
| `workerVersion`, `pagesDeployment`, `providerObservationId` | Exact current provider pair and stable scoped observation digest                                                |
| `recordSha256`                                              | Exact reviewed lifecycle snapshot; editing it invalidates approval                                              |
| `approverId`                                                | Immutable authorized reviewer ID; cannot equal initiator; acceptance reviewer differs from publication reviewer |
| `admissionAction`, `observedAdmissionPaused`                | Exact requested action and observed live boolean                                                                |
| `issuedAt`, `expiresAt`                                     | Canonical UTC timestamps, positive lifetime no longer than ten minutes                                          |
| `evidence`                                                  | Exact checklist of SHA-256 references, never raw evidence, credentials or session payloads                      |

Publication references `prepared-artifacts`, `previous-acceptance`, and
`recovery-plan`. Acceptance references the existing seven checks:
`artifact-identity`, `admission`, `authorization`, `persisted-state`,
`transfer-receipt`, `operations`, and `recovery-plan`. A hash identifies evidence;
it does not prove the evidence was produced honestly or reviewed by an operator.

Publication approval reviews the deployed pair **before** mutation. Acceptance
separately reviews the newly published pair and complete `PUBLISHED` record.
Publication authorization cannot be reused for acceptance. The old boolean
callback API is now restricted to offline lifecycle simulations; it cannot
authorize hosted publication or hosted acceptance.

`checkApproval` requires protected policy: immutable repository/owner IDs, exact
signer workflow and commit, and role-specific immutable reviewer allowlists.
These pins must be independent of the submitted bundle/artifact. An authority
must verify the canonical payload signature, producer identity, independent human
review and current revocation. Its response binds the exact decision and review
ID to a fresh random challenge; the revocation check must be within five seconds.
Exceptions become safe diagnostic codes.

At verification and use, the code re-reads Task 05 observations, applies the
60-second freshness limit and admission policy, and checks exact pair, scope and
stable observation identity. The digest excludes only its sampling timestamp;
each sample is separately freshness-checked. Readback cannot prove artifact
correlation or authorize acceptance. Hosted candidates require an unmodified
in-process observation issued by the actual adapter; injected transport/clock
fixtures cannot be promoted.

Checked approvals are process-local capabilities backed by a private WeakMap.
Cloning, deserializing or modifying a result destroys that capability. Use
rechecks authorization, revocation and provider identity. Consumption is one-time
within the process; uncertain failure requires reconciliation. **Cross-process
replay protection requires the configured store's atomic approval ledger.**
A new verifier call alone is not durable replay protection.

All checked results retain `publicationEnabled: false`, `releaseAccepted: false`
and `productionApproved: false`. No hosted acceptance method is wired to this
contract yet. Historical unsigned records gain no trust through parsing,
rehashing, timestamps, this interface or a newer Git commit.

Recovery checkpoints also reject `hosted-observation` snapshots until a real
independent hosted evidence adapter exists. Merely labeling a storage port
`external-authenticated` cannot authorize recording self-asserted provider proof.

## Recovery journal and concurrency

`RecoveryLog` emits strict version-1 events containing repository/environment
scope digest, attempt, manifest/source identity, monotonic event sequence,
previous event hash, lifecycle snapshot and optional checked approval reference.
Kinds are `START`, `CHECKPOINT`, `APPROVAL_CHECKED`, and `APPROVAL_REJECTED`.
Snapshot and event sequences are separate: approval events do not mutate the
lifecycle snapshot.

The store contract must perform one atomic transaction that:

1. Reserves repository/environment ownership on `START`.
2. Compares the expected attempt/head/sequence with the authoritative head.
3. Uniquely consumes approval IDs across attempts, when present.
4. Appends the event and advances the head before acknowledging it.

A future external store must also authenticate its replies/readers, retain
immutable records independently of the runner, expose a trusted latest
checkpoint, prevent unauthorized deletion/rollback, define backup/retention and
ownership reconciliation, and tolerate failures. An adapter's `scope` string is
not proof that these requirements are met.

The test-only SQLite implementation uses real transactions, unique constraints,
WAL and synchronous writes. It survives database reopen and deletion of a
separate simulated runner directory. This proves local behavior only; it is not
independently trusted or durable after host loss.

`ReleaseJournal.create(..., evidenceSink)` writes evidence before local snapshots
and simulated provider mutation. Failure to record or acknowledge intent stops
progress. A commit followed by a lost response is uncertain: do not retry blindly.
A local snapshot sequence advances only after its checkpoint succeeds.

Using `RecoveryLog` requires checked publication approval at `worker-intent`.
Recording acceptance requires separate checked approval with exact reviewer,
timestamp and checklist. Incomplete or rejected attempts cannot be promoted.
Rejection is an explicit terminal event. No automatic resume, acceptance,
rollback or lock expiry is implemented.

Inspection checks order, hashes, snapshot sequences, duplicate approvals and an
independently supplied expected head. It reports content integrity, not
authenticity: rewriting a whole untrusted chain and its head is not prevented by
hashes. It always reports `authenticated: false`, `offRunDurable: false`,
`releaseAccepted: false`, `productionApproved: false`, and
`publicationEnabled: false`. Accepted offline snapshots remain simulations.
Recovery returns no restored approval or publication capability.

Local publication exclusively creates a persistent repository/environment lock
beside release directories, in addition to its per-release lock. Use one
protected shared root; separate roots, machines and untrusted writers can bypass
a filesystem lock. Locks are retained on failure and success. Reconcile an
attempt before a separately reviewed lock release; no unsafe unlock command is
provided here.

The existing workflow serializes each explicit environment with
`cancel-in-progress: false`; it was preserved. [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
is repository-local scheduling, not a universal distributed lock. Pending runs
may be replaced under the default queue behavior. Dashboard changes, external
CLI writes, another repository, runner failure and manual cancellation are
outside that guarantee. Hosted mutation needs independent environment ownership
and fresh checks between operations.

[Actions artifacts v4](https://github.com/actions/upload-artifact/blob/v4/README.md)
have immutable contents/IDs, but retention and deletion still apply. The existing
workflow uploads JSON for 30 days after preparation and cannot upload after
complete runner loss. Artifacts are useful evidence; they are not a trusted
independently durable latest-head store or authenticated human approval. A
downloaded artifact must not supply its own trust policy.

## Threat model and regression evidence

`tests/unit/release-controls.spec.ts` covers these defined guarantees. Each has
a rejection test; none depends on a production approval flag.

| Threat/failure                               | Gate and negative test                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Forged payload/reviewer                      | Two independently verified test signatures; substituted keys/modified payload rejected                       |
| Approval copied across releases/environments | Exact manifest/source/snapshot/attempt/run/environment tests                                                 |
| Old Worker or wrong Pages                    | Exact IDs and observation identity; signed wrong-ID tests                                                    |
| Replay                                       | Fresh verifier challenge, one-time consumption and unique SQLite ledger tests                                |
| Revoked/expired approval                     | Revocation rechecked at use, bounded validity and verifier age tests                                         |
| Modified manifest/evidence                   | Manifest/record digest and signed evidence; changed checklist rejected                                       |
| Untrusted producer/artifact                  | Pinned issuer/repository/owner/workflow/commit; wrong pins/missing authority rejected                        |
| Spoofed operator                             | Independent reviewer receipt, immutable role, no self-review, distinct acceptance reviewer                   |
| Provider pair changes after approval         | Fresh Task 05 readback at use; changed active version rejected                                               |
| Concurrent releases                          | Environment ownership/CAS; competing writers/manifests and operation races rejected                          |
| Incomplete publication                       | Intent/failure records, approval-free acceptance rejected, hosted guards                                     |
| Journal modification/gap/replay/truncation   | Strict events, sequence/hash chain and expected head tests                                                   |
| Runner interruption/lost acknowledgement     | Local reopen/directory deletion and committed-intent/lost-response tests                                     |
| Admission reopening                          | Existing preservation policy plus reviewed intent and explicit acknowledgement tests                         |
| Fabricated hosted trust                      | Fixture taint, modified/serialized checks rejected, unconfigured authority/store and blocked publisher tests |

Ed25519 keys, fake IDs, signed reviews, provider transport and SQLite store exist
**only in fixtures**. They are not GitHub attestations, real operator identities,
authenticated Cloudflare responses or production roots. Existing provenance
tests cover cleanup, readiness, partial publication and archive failures.
Existing rollback and WebRTC race regressions remain required.

## Operator procedure and external prerequisites

Before hosted enablement, obtain separate authorization to configure and validate:

1. A protected independently reviewed approval producer/verifier, real immutable
   repository/owner IDs, pinned workflow/commit/identity and trusted roots.
   Review the actual attestation schema; unavailable fields must fail closed.
2. Protected environment policy, eligible publication/acceptance reviewers,
   self-review prevention, role separation and an independently authenticated
   human review evidence source. Establish revocation and replay rules. A workflow
   input or triggering OIDC actor is insufficient.
3. Authenticated off-run storage with atomic ownership, approval ledger, append/
   head CAS, independent checkpoints, retention and auditing. No service is
   selected or configured here.
4. Authenticated provider readback and independent artifact-to-provider
   association, runtime readiness/authorization/persistence tests using disposable
   data, prior accepted archive and compatible recovery plan.
5. Authorized cancellation, lost-response, runner-loss, concurrent-operator,
   revocation/acceptance and restore drills. Review credentials, permissions and
   admission behavior before implementing any publisher.

After interruption/conflict, stop mutations; preserve manifests, events, receipts
and independent checkpoints; retain a verified admission pause. Obtain separately
authorized readback of both active components. Compare the observed pair and
last acknowledged intent with the independent store. A missing response or
artifact does not prove non-publication. Resolve ownership/conflicts through the
approved recovery authority. Issue fresh reviewed evidence after reconciliation;
never restore an approval capability from JSON or silently reopen admission.

Prefer a reviewed forward fix when rollback eligibility cannot be proven. Any
rollback still needs Task 03 compatibility and independent accepted provenance.
No command in this task performs recovery, changes admission or enables releases.
Passing local tests does not establish production release readiness.
