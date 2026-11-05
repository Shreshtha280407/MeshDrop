# Trusted release verification and recovery integration

Task 08 implements real offline Sigstore verification, scoped read-only GitHub
review inspection and a PostgreSQL recovery adapter. **Production publication and
acceptance remain disabled.** Neither hosted factory is automatically configured.
No setting, token, fixture flag or successful signature enables a release.

## Provider investigation and trust anchors

| Mechanism                                 | Documented interface / permission                                                                                                                                                                                             | Evidence and limits                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actions OIDC                              | [OIDC claims](https://docs.github.com/en/actions/concepts/security/openid-connect); producer needs `id-token: write`                                                                                                          | GitHub issuer signs job identity, immutable repository/owner IDs, workflow/source/run claims. Triggering actor is not the human reviewer. Claims/subject policy must be independently pinned, including the current subject format.                                                        |
| Environment protection                    | [Environment rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments); settings require a separately authorized administrator                                                  | Required reviewers gate jobs/secrets; one listed reviewer can release the gate. Enable self-review prevention, selected branch/tag restrictions and disable administrator bypass. YAML cannot establish that these settings exist. Availability depends on repository visibility and plan. |
| Artifact attestation                      | [GitHub attestation concepts](https://docs.github.com/en/actions/concepts/security/artifact-attestations); producer `attestations: write`, `id-token: write`, narrowly scoped `contents: read`                                | Sigstore authenticates the artifact digest and certificate claims. Public/private GitHub instances have different trust material/transparency behavior. A predicate is workflow-controlled; compromised build instructions can attest false assertions.                                    |
| Offline verification                      | [GitHub offline procedure](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline), [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify) | Local bundle plus independently acquired trusted roots; no login or API lookup. Check immutable certificate IDs as well as names. Offline roots do not reveal revocation since acquisition.                                                                                                |
| REST reviewer history                     | [GET `/repos/{owner}/{repo}/actions/runs/{run_id}/approvals`](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run); Actions read                                                  | GitHub HTTPS response exposes actual reviewer `user.id`, decision, comment and environment IDs. It does not document review timestamp, review ID or attempt binding. Environment creation/update times are not approval times. No signed portable approval/revocation receipt is returned. |
| GraphQL reviewer history                  | [`DeploymentReview`](https://docs.github.com/en/graphql/reference/deployments#deploymentreview); authenticated repository access                                                                                              | Adds `databaseId`/node ID, user, state, comment and environments. The documented type still lacks review time and run-attempt binding. This cannot fill Task 07's validity/revocation contract. No GraphQL adapter is invented here.                                                       |
| Repository/run/workflow/environment scope | [Workflow-run APIs](https://docs.github.com/en/rest/actions/workflow-runs), [environment API](https://docs.github.com/en/rest/deployments/environments); Metadata read and Actions read for the implemented GET endpoints     | Match numeric repository/owner IDs, run/attempt/source, initiator, exact workflow path, environment ID/name and configured direct reviewer IDs. A current configuration observation does not prove its historical state.                                                                   |
| Actions artifacts                         | [Artifact v4 contract](https://github.com/actions/upload-artifact/blob/v4/README.md)                                                                                                                                          | Immutable artifact contents/IDs do not prevent retention expiry, deletion, missing upload or replay of an older artifact. Existing 30-day upload is useful evidence, not an independent durable latest-head authority.                                                                     |

The reviewer API gap is a confirmed capability limit, not a missing JSON field to
guess. Do not substitute `environment.created_at`, OIDC `actor_id`, run start time,
attestation signing time or list position for human approval time/revocation.
Do not reinterpret an old review as approval for a rerun.

## Actual signature verification

`scripts/deploy/github-attestation.ts` executes the installed maintained GitHub CLI
with argument arrays, no shell, a private temporary directory, empty login
configuration and no inherited tokens. Inputs are bounded; verification has a
15-second timeout and bounded output. The owned directory is removed on success
and failure. No verifier output, certificate bundle or raw stderr is printed.

Required trusted policy fields are defined by `AttestationPolicy`:

- Immutable repository and owner IDs plus repository name.
- Exact signer workflow and commit; exact source commit/ref/workflow.
- Exact workflow run and attempt, pinned from certificate `runInvocationURI`.
- Exact SHA-256 of the artifact, trusted root file and installed `gh` executable.
- Explicit root review/valid-until times, with a maximum seven-day review window.

The root-review window is a local operator policy. It is not evidence of fresh
revocation. Obtain refreshed roots using the documented TUF procedure through a
separately authorized, trusted channel; review their digest outside the submitted
artifact. Protect policy, verifier binary and roots against the artifact producer.
A self-computed digest authenticates none of these inputs.

Verification enforces the GitHub OIDC issuer, exact certificate SAN, signer and
source digests/ref, SLSA v1 predicate, GitHub-hosted runner, immutable certificate
IDs, caller workflow and invocation. It requires one verified attestation and
one subject with the pinned digest plus witnessed signature timestamps. It uses
verified certificate extensions, not similarly named predicate fields.

For approval evidence, the artifact bytes are the canonical Task 07
`ApprovalClaim`. Its digest binds repository/environment/source, manifest, Worker
and Pages IDs, provider observation, run/attempt, reviewer, purpose, decision,
validity and checklist references. Changing any field changes the signed bytes.
`inspectApprovalEvidence` performs real signature verification before reviewer
readback and requires compatible source/signer/repository pins across adapters.

The included upstream fixture proves actual historical signature verification
for **malancas/attest-demo**, not MeshDrop. Its wheel is never executed. See
`tests/fixtures/sigstore/README.md` and the upstream MIT license. Its root is never
selected by a hosted factory. Automated tests make no authenticated account calls.

## Human review inspection, without invented authorization

`GitHubReviewReader` accepts explicit application environment, distinct review
environment ID/name, purpose, source workflow, immutable resource IDs, role policy
and a separately supplied read credential. It never reads an environment file or
process token. It uses GET only against `https://api.github.com`, refuses redirects,
caps each response at 256 KiB and each request at ten seconds, and sanitizes errors.
An incomplete/paginated result is rejected rather than silently truncated.

It reads these exact documented paths:

1. `/repos/Shreshtha280407/MeshDrop`
2. `/repos/Shreshtha280407/MeshDrop/actions/runs/RUN/attempts/ATTEMPT`
3. `/repos/Shreshtha280407/MeshDrop/actions/workflows/WORKFLOW_ID`
4. `/repos/Shreshtha280407/MeshDrop/environments/EXACT_REVIEW_ENVIRONMENT`
5. `/repos/Shreshtha280407/MeshDrop/actions/runs/RUN/approvals`

It validates source/run/workflow/repository identities, explicit application
environment, reviewer role and self-review separation, configured direct-user
reviewer membership and `prevent_self_review`. Team membership is unsupported
and fails closed. Display names are not identities. Matching review comments must
contain exactly `meshdrop-approval-v1:APPROVAL_UUID:CANONICAL_CLAIM_SHA256`; this binds
the content the operator selected, but is not a custom signature protocol.
Missing, rejected, conflicting or copied comments fail. Claims must remain within
their existing validity window. Public REST observation is not a signed receipt.

Even a matching authenticated observation returns **UNVERIFIED** with explicit
missing review-time, attempt-binding and revocation evidence. Injected transport
or clock is permanently marked as a fixture, even if its public label is changed.
No result is an `ApprovalAuthority` receipt, restores a Task 07 capability, accepts
a release or approves rollback. `hostedApprovalAuthority()` remains unavailable.

Publication and post-publication acceptance still require different purposes and
reviewers, fresh Cloudflare observations, exact provider pair and complete record.
Task 07's one-time consumption, revocation/freshness checks, admission-preserving
policy and explicit reopening acknowledgement remain unchanged. Partial publication
never becomes accepted. An independently authenticated review authority/broker
with the missing validity and revocation guarantees is still required; it is not
created, configured or represented by these diagnostics.

## Recovery storage selection

| Candidate                          | Decision                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner files/local SQLite          | Existing local integrity tests remain useful; no independent hosted durability or trust anchor. No fallback.                                                                                                                                                                                              |
| GitHub artifacts                   | Retained evidence, not transactional ownership/replay storage or independent latest-head authority.                                                                                                                                                                                                       |
| S3 conditional objects/Object Lock | [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) can protect retained versions. It does not give one transaction across environment ownership, head and global replay objects. Useful as a separately administered checkpoint/archive witness; not implemented here. |
| Cloudflare D1                      | Transactional operations exist, but independent administration, credential blast radius and [backup retention](https://developers.cloudflare.com/d1/reference/time-travel/) need separate review. No new account/database is provisioned.                                                                 |
| **Dedicated PostgreSQL**           | Selected for atomic row locks/transactions, unique constraints, cross-client consistency and granular function/table permissions, testable on an actual isolated server. Hosted durability and independent witnesses still require configuration.                                                         |

`PostgresRecoveryStore` uses `recovery-postgres.sql`. Installation is explicit;
application/deployment code never installs or migrates a database. No production
SQL was executed. The `psql` client requires explicit host/port/database/user,
trusted executable, CA path and protected password-file path. It uses
`sslmode=verify-full`, bounded connection/query/lock timeouts, no password prompt,
no psql startup scripts and no inherited PostgreSQL variables. JSON is encoded as
hex data, never interpolated as SQL syntax. No credentials enter arguments/logs.

The append function is one transaction covering:

1. Exact pinned store UUID and allowed scope/login principal.
2. Exclusive repository/environment ownership for a fresh attempt.
3. Row lock and exact compare-and-swap of attempt/head/sequence/hash.
4. Globally unique approval-ID consumption and immutable event insertion.
5. Attempt-head advancement and receipt only after commit.

It requires `fsync` and `full_page_writes`, and sets synchronous commit on. These
protect the server's local commit behavior; they do not establish replica or
provider disaster durability. A lost acknowledgement is uncertain completion:
stop, retain the expected head and reconcile independently. No blind retry occurs.

Separate attempt heads and event keys preserve old attempts. Ownership is retained
after success/failure. Only a separately authorized protected administrator may
reconcile and hand off ownership; no production unlock or automatic recovery command
is provided. Such a handoff must preserve prior attempts and the global approval
ledger. Old clients cannot append after a handoff.

Reads return history and head from a consistent statement snapshot. The client
validates strict events, canonical hashes, sequence, scope and receipt identity;
Task 07 recovery compares an independently supplied expected head. A cloned/rolled
back database cannot prove that its own head is newest. Inspection continues to
report `authenticated: false`, `offRunDurable: false` and `productionApproved: false`.
TLS authenticates the configured database endpoint, not the truth of every event.

## Exact operator setup prerequisites — no automatic changes

These are separately authorized operations. Do not apply them merely because this
document exists. Keep the current publisher/acceptance guards in place.

1. In repository **Settings → Environments**, inspect/create separate preview and
   production review environments, including separate publication and acceptance
   gates. Select authorized direct user reviewers, prevent self-review, disable
   administrator bypass and restrict deployment branches/tags to the exact reviewed
   references. Inspect actual rules/IDs with authorized API reads. Do not infer
   protections from `deploy.yml`; no hosted settings were inspected here.
2. Protect source and reusable attestation workflow changes through repository
   rulesets/review. Pin the producer workflow commit, immutable repository/owner IDs,
   source/caller workflow and run/attempt. Do not run a trusted signer on arbitrary
   untrusted build inputs. Scope future producer permissions to `contents: read`,
   `id-token: write`, `attestations: write`; do not grant those to unrelated jobs.
   The current workflow permissions are unchanged.
3. Independently install/review GitHub CLI (2.102.0 was tested), obtain current
   Sigstore roots through TUF and pin their digests in protected configuration.
   Establish root refresh/revocation handling. Verification needs no GitHub token.
   Reviewer readback needs a separately authorized least-privilege GitHub App/PAT
   with Metadata read and Actions read for the implemented repository/run/workflow/
   environment/review GET endpoints. It must have no write/admin or secret-read
   permissions.
4. Establish an authenticated human-review authority with documented timestamps,
   immutable review/attempt/content binding, current revocation and retention.
   Current REST/GraphQL observations alone cannot meet this contract. Until then,
   authorization must remain disabled even if all signature checks pass.
5. Provision a **separate evidence PostgreSQL database**, protected administrator/
   owner principal and separate preview/production writer and reader login roles.
   Apply `recovery-postgres.sql` only after review. Insert one independently pinned
   UUID into `meshdrop_recovery.identity`. Bind each actual login role to the exact
   `recoveryScope(manifest)` in `meshdrop_recovery.access`, with `can_append` false
   for readers. Scope IDs derive from repository + explicit application environment.
6. Give clients `USAGE` on `meshdrop_recovery` and only `EXECUTE` on
   `append_event(uuid,text,text,jsonb)` and/or `read_history(uuid,text,uuid)`.
   Grant **no table writes, ownership, schema CREATE, superuser or role-management
   privileges**. Keep function owner privileged and non-login; fixed search paths
   and revoked PUBLIC permissions are part of the installed SQL. Do not give the
   CI writer backup/restore or ownership-release authority.
7. Configure verified TLS CA/hostname, protected mode-0600 libpq password file and
   short-lived/scoped credentials through a separately reviewed mechanism. No
   credential is installed/read by this task. Do not connect to an app/session
   database or silently use an existing `PG*` environment/connection string.
8. Set provider backups, point-in-time recovery, deletion protection, audit access,
   retention and replication/RPO policy. Maintain a separately administered,
   authenticated latest-head witness and retained canonical claims, bundles and
   review receipts. Retain the approval ledger for the whole replay-prevention
   horizon. TLS + store UUID + local hash chain do not replace that witness.
9. Validate role permissions, forced disconnect/lost acknowledgements, rollback of
   backups, runner termination, concurrent attempts and independently anchored
   restore in an authorized hosted drill with disposable data. Check actual provider
   identities/artifacts, admission state and complete acceptance evidence separately.

Existing environment-scoped workflow concurrency with `cancel-in-progress: false`
is retained. It is not a distributed lock against dashboard/CLI operators. Database
ownership adds a separate boundary, but provider changes outside it still require
fresh readback and an exclusive operational window.

## Cost and availability

PostgreSQL has no database license charge; hosting, storage, HA, retained WAL,
backups and independent archives cost depend on the chosen service and region.
For comparison, [Neon's published pricing](https://neon.com/pricing) offers a free
development tier and paid usage plans. That is not a guarantee of sufficient
retention, independent administration or production recovery on a free tier.
No vendor account or paid resource was created. Public-repository required reviewers
and artifact attestations are available on current GitHub plans. On Free/Pro/Team,
these features are restricted to public repositories; private/internal artifact
attestations require Enterprise Cloud according to the [current feature contract](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).
Verify the actual account plan and repository visibility before selecting a paid
configuration. No production cost promise is made from local container tests.

## Local checks and safe diagnostics

Use Node 24/pnpm 10.34.7 and installed GitHub CLI. PostgreSQL tests require Linux
Docker's local Unix socket and this independently checked official image:

```sh
docker pull postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
pnpm test:release-store
```

The setup pull is separate from tests. The tests use `--pull never`, a new labeled
container, no network/host ports/user mounts, read-only root and disposable tmpfs
database. They remove only their owned container. Actual PostgreSQL transactions,
two concurrent client processes, privilege denials, lost acknowledgements, retained
history and replay ledger are exercised. This is not a hosted durability drill.
The check is included in `pnpm check`; CI core caches the same image before it.
No existing test is skipped or removed.

Read-only inspection commands:

```sh
pnpm inspect:release-trust attestation ARTIFACT BUNDLE ROOTS TRUSTED_POLICY
pnpm inspect:release-trust history MANIFEST EVENTS EXPECTED_HEAD ATTEMPT_UUID
```

Both print sanitized JSON and return nonzero **UNVERIFIED**, even when the signature
or local history integrity passes. They never deploy, approve, connect to a hosted
store, change admission or accept a release. Never treat an input policy or expected
head downloaded with the artifact as independent trust.

After failure, preserve exact identities/heads and stop writes. Independently
reconcile the active Worker/Pages pair and store state; keep a verified admission
pause. Reissue fresh approved evidence only after conflict resolution. Prefer a
reviewed forward fix if compatible accepted rollback cannot be proven. Do not
restore capabilities from JSON, erase history, expire ownership automatically or
reopen admission based on a successful signature. Hosted approval, storage recovery,
artifact/provider correlation and release readiness remain unverified here.
