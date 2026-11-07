# Hosted trust rehearsal: operator runbook and security boundaries

**A successful Task 09 rehearsal does not authorize production deployment.**

The manual workflow prepares and attests non-secret rehearsal metadata, verifies
the signature offline, and records three rehearsal events in a separately
configured PostgreSQL evidence store. It does not build or publish MeshDrop,
read Cloudflare, change admission, migrate a database, approve a release, or
accept one. Publication and acceptance remain blocked by Tasks 04–08.

Implementation was prepared from the clean local `main` commit
`b791fd40b4bfa78158576d4804d7b33f0f66af42`. The task's expected
`6c30b19f42dc02211cfbd2d4c10fb810701ed5ed` was absent locally; the operator
confirmed the local checkout was current. No branch or history was changed.

## What the rehearsal proves

The default path in `.github/workflows/release-trust-rehearsal.yml` has three jobs:

1. `inspect`: read the existing dedicated GitHub environment and compare its ID,
   direct reviewer IDs, self-review prevention and selected-branch policy mode.
   Only a validated environment name becomes a job output.
2. `produce`: pass that environment's job gate, generate canonical metadata,
   attest its exact bytes using the official pinned `actions/attest`, verify
   using a pinned GitHub CLI and independently reviewed roots, and upload the
   metadata and bundle as an immutable Actions artifact.
3. `recover`: pass the environment gate, download that exact artifact ID,
   repeat signature and identity verification, then reserve the rehearsal scope,
   append evidence, close the rehearsal, and reread the complete history.

An optional, default-off `fault_tests` input adds preview-only `faults` and
`attest-faults` jobs. Follow [the Task 10 operator runbook](hosted-rehearsal-faults.md)
for their separate store, permissions, configuration checker and evidence export.
The only trigger is `workflow_dispatch`. Concurrency is scoped to
`meshdrop-trust-rehearsal-{preview|production}`, with cancellation disabled.
Database ownership and compare-and-swap checks remain authoritative for competing
writers; Actions concurrency is not a distributed lock and may replace pending
runs. A cancelled or interrupted owner is never automatically removed.

Root permissions are empty. `inspect` and `recover` have `contents: read` and
`actions: read`. Only the signing jobs (`produce` and optional `attest-faults`) request
`id-token: write` and `attestations: write`. The optional signing job also needs
`actions: read` to download the exact fault report. No job requests deployment permissions or Cloudflare
credentials. The normal database password is mapped only to the `store` step,
after the producer has completed. Optional fault writer/reader passwords are
mapped only to the separate `faults` job command, never to either signing job. Dependencies install with `--ignore-scripts`.
Normal CI runs structural, unit and isolated database tests, never this workflow.

The environment gate is an operational prerequisite, **not** independently
authenticated human release authorization. OIDC authenticates a workflow
identity; artifact attestation does not prove that a claim about a human is true.

## Step 1 — Configure (separate human authorization)

Do not dispatch until an administrator has reviewed and configured these items.
This task does not create environments, databases, credentials or grants.

### GitHub configuration

Create dedicated `trust-rehearsal-preview` and/or `trust-rehearsal-production`
environments, separate from deployment environments. Enable required **direct
user** reviewers and prevent self-review. Configure selected branch/tag rules
for the exact reviewed rehearsal ref; prohibit administrative bypass where
supported. Review plan/repository availability: environment protection and
attestation capabilities vary by plan and repository visibility. The required
environment GET must be readable by the workflow's read-only token; inability
to read it blocks the rehearsal rather than broadening permissions.

Pin these protected repository variables from independently inspected GitHub
metadata, never from an uploaded artifact:

| Variable                                    | Required value                                                     |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `TRUST_REHEARSAL_REPOSITORY_ID`             | MeshDrop numeric repository ID                                     |
| `TRUST_REHEARSAL_OWNER_ID`                  | Owner numeric ID                                                   |
| `TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID`    | Existing preview rehearsal environment ID                          |
| `TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID` | Existing production rehearsal environment ID                       |
| `TRUST_REHEARSAL_REVIEWER_IDS`              | JSON array of exact authorized numeric user IDs as strings         |
| `REHEARSAL_ROOTS_BASE64`                    | Base64 of independently obtained public trusted-root JSONL bytes   |
| `REHEARSAL_ROOT_SHA256`                     | SHA-256 of those exact decoded bytes                               |
| `REHEARSAL_ROOT_REVIEWED_AT`                | UTC root-review timestamp                                          |
| `REHEARSAL_ROOT_VALID_UNTIL`                | Expiration after review, at most seven days later                  |
| `REHEARSAL_GH_PATH`                         | Absolute path to the independently reviewed installed `gh` binary  |
| `REHEARSAL_GH_SHA256`                       | SHA-256 of that binary on the chosen runner image                  |
| `REHEARSAL_DATABASES_JSON`                  | Explicit database configurations indexed by `preview`/`production` |

Repository settings, variable write permissions, branch protection and reviewer
authorization are external trust assumptions. YAML cannot prove they exist.
Preflight checks policy mode, not every branch pattern or administrative bypass
setting. Freeze/review environment configuration during the run: deletion or
changes between inspection and a job gate are a hosted configuration race.

The runner image must already contain the reviewed `gh` and `psql` versions.
There is no automatic binary download or root refresh in verification. Obtain
roots out of band using the documented GitHub CLI/TUF procedure, review them,
then configure their exact digest. Do not use the historical roots under
`tests/fixtures`. Binary/root changes require independent review and new pins.

### Recovery database

Use a separately provisioned evidence database with TLS, backups, defined
retention and an independently pinned store UUID. Review Task 08's
`scripts/deploy/recovery-postgres.sql` before a separately authorized
administrator installs it into this dedicated database. The rehearsal never
installs that schema. Require `fsync`, `full_page_writes`, synchronous commit,
and an operationally reviewed disaster-recovery policy.

Create a non-owner login with only schema usage and execution of
`append_event(uuid,text,text,jsonb)` and `read_history(uuid,text,uuid)`.
Do not grant table writes, ownership, superuser or schema creation. Configure
`meshdrop_recovery.access` for only the rehearsal scope, computed as:

```ts
fingerprint({
  repository: 'https://github.com/Shreshtha280407/MeshDrop',
  environment: 'preview', // or production, explicitly
  purpose: 'trust-rehearsal',
});
```

This differs from the production release scope. Use distinct credentials and
ACLs for each environment. The dedicated rehearsal role must not have release
scope access. Store its password only as the dedicated environment secret
`REHEARSAL_DB_PASSWORD`; never reuse production publication credentials.

Each environment's entry in `REHEARSAL_DATABASES_JSON` must have exactly:

```json
{
  "environment": "preview",
  "host": "reviewed-evidence-host.example",
  "port": 5432,
  "database": "reviewed_evidence_database",
  "user": "reviewed_rehearsal_role",
  "caPem": "INDEPENDENTLY REVIEWED PUBLIC CA PEM BYTES",
  "caSha256": "EXACT_SHA256_OF_CA_BYTES",
  "storeId": "INDEPENDENTLY_PINNED_STORE_UUID",
  "psqlPath": "/absolute/reviewed/psql",
  "psqlSha256": "EXACT_SHA256_OF_PSQL_BINARY"
}
```

These placeholders are deliberately invalid. The surrounding variable is an
object keyed by `preview` and/or `production`, with no fallback. CA and client
digests are checked before connecting. Password/CA files are created with mode
0600 in a private runner temporary directory outside the checkout and cleaned
on ordinary failure/success; runner destruction must handle forced termination.
Libpq uses `verify-full`, the exact host/port/database/user, a dedicated password
file and bounded timeouts. Every session checks the database, session user,
primary status and actual `pg_stat_ssl` TLS state before journal operations.
The pinned store UUID is checked by the database functions and client receipts.

## Step 2 — Review

Review the complete workflow and its exact action commit pins. Check the source
commit and workflow commit are identical, confirm immutable repository/owner
IDs, environment IDs, direct reviewers, allowed refs, binary hashes, root review
window, store identity and ACL scope. No Cloudflare credentials or deployment
secrets should be available in either dedicated environment. The CLI rejects
unexpected deployment credential/control environment variables, but it cannot
enumerate secrets that GitHub has not exposed to a step.

All output flags must remain false. Existing `hostedProvider()`, hosted
approval/recovery factories, hosted publication/acceptance and the rollback
CLI's `productionApproved: false` are unchanged. The rehearsal has no imports
of the application, lifecycle, provider or deployment entry points. Its command
allowlist has no publish/deploy/accept/migrate/rollback operation.

## Step 3 — Dispatch rehearsal (human only)

After independent review and separate authorization, a human may dispatch the
dedicated workflow for an exact reviewed ref, providing `environment`,
`expected_source_sha` and `expected_ref`. The runtime requires all three to
match GitHub context, including the actual workflow SHA. The optional
`prepared_manifest_sha256` is only a reference to an independently verified
prepared manifest; absence is `null` and does not invent a prepared release.

Approve the dedicated environment job gates according to policy. This task does
not collect authenticated reviewer authorization or convert a job approval into
Task 07 approval evidence. No dispatch was performed during implementation.

The canonical artifact binds schema version, purpose `trust-rehearsal`, exact
MeshDrop repository and numeric IDs, preview/production scope, source SHA/ref,
workflow path, run ID/attempt, random rehearsal UUID, optional prepared-manifest
digest, UTC timestamp and three false capability flags. `artifactId` hashes the
canonical payload; the attestation subject hashes the complete canonical file.
Given identical explicit inputs, serialization is deterministic. Time and UUID
are generated once and are identities, not authorization evidence.

## Step 4 — Export evidence

Download the exact producer artifact ID and recovery artifact ID from that run
attempt. Preserve `rehearsal.json`, `bundle.json`, `events.json`, `head.json` and
`summary.json` byte-for-byte. Producer upload contains only the first two files;
recovery upload contains only the final three. Upload overwrite and hidden files
are disabled; retention is 30 days subject to repository policy and deletion.
Download by ID prevents name substitution. Attestation verification and the
producer's expected digest independently detect payload substitution.

A producer-only artifact, missing recovery summary, failed receipt, interrupted
writer or missing database acknowledgement is **INCOMPLETE**. Never infer a
successful store append from an exited command. A failed recovery step produces
no success summary. Keep the signed producer evidence and reconcile history;
do not blindly rerun, retry writes or remove ownership.

## Step 5 — Verify offline

Use a trusted checkout, Node toolchain, pinned `gh` binary and independently
obtained reviewed roots. Build a `RehearsalExpectation` JSON object containing
exactly `repositoryId`, `ownerId`, `environment`, `sourceCommit`, `sourceRef`,
`runId`, `runAttempt` (number) and `rehearsalId`, from independent run metadata.
Build an `AttestationPolicy` JSON object with these exact fields:

`schemaVersion: 2`, `signerRef`, `repository`, `repositoryId`, `ownerId`,
`signerWorkflow`, `signerCommit`, `sourceCommit`, `sourceRef`, `sourceWorkflow`,
`runId`, `runAttempt`, `artifactSha256`, `trustedRootSha256`, `rootReviewedAt`,
`rootValidUntil`, `ghPath`, `ghSha256`.

The repository is `Shreshtha280407/MeshDrop`; both workflow paths must identify
`.github/workflows/release-trust-rehearsal.yml`. `signerWorkflow` includes the
repository prefix. `signerRef` equals the independently reviewed source ref;
`signerCommit` equals the exact source SHA. `artifactSha256` hashes the complete
downloaded canonical metadata file. Never take expected pins or a trust root
from the artifact being verified.

```sh
pnpm exec tsx scripts/rehearsal/cli.ts verify-files \
  rehearsal.json bundle.json reviewed-roots.jsonl policy.json expectation.json
```

This read-only command checks the actual Sigstore signature, chain, signed
timestamp, GitHub OIDC issuer, exact SAN/build signer URI, immutable signer
digest, numeric source repository/owner IDs, source/workflow SHA/ref, run and
attempt, GitHub-hosted runner, SLSA v1 predicate, and subject digest. It then
checks canonical metadata, exact MeshDrop identity, purpose and false flags.
Policy v1 remains available for Task 08's SHA-pinned reusable workflow fixture;
the MeshDrop rehearsal requires v2's ref plus immutable signer digest.

Exit zero means **signature verification only**. The result still has
`signatureVerified: true`, `authorizationVerified: false`,
`publicationEnabled: false`, `acceptanceEnabled: false`,
`productionApproved: false`. An upstream signed fixture cannot identify
MeshDrop. Local tests use real public upstream signatures, not fabricated
MeshDrop signatures. Offline verification cannot discover later revocation or
prove the root-review configuration was independently authorized.

## Step 6 — Reconcile recovery history

The operation reserves one environment scope and writes exactly
`RESERVED → EVIDENCE → CLOSED`. All records retain `state: PREPARED`, purpose
`trust-rehearsal`, and null approvals. No provider IDs or publication states are
created. The wire field `manifestId` contains the rehearsal artifact ID in this
separate domain; it is never a production manifest or rollback approval.

SQL transactions enforce store identity, ACL, exclusive scope ownership,
monotonic sequence/head compare-and-swap, unique attempt UUID, event hash and
receipt. The client verifies every receipt and rereads the full chain. A
duplicate UUID/evidence event or conflicting writer is rejected. The rehearsal
does not consume human approval IDs; it uses only its own rehearsal UUID and
evidence identifier. Task 08's approval replay ledger remains unchanged.

For an interruption or lost acknowledgement, an authorized operator should use
the reviewed read-only `read_history` function for the exact store, scope and
attempt, and compare it with independently retained head evidence. Keep a
separate read-only login/ACL. Do not grant the runner administrative access or
unlock another attempt. Ownership persists even after CLOSED; a later attempt
requires separately authorized administrative reconciliation, with retained
history and an explicit operator decision. No unlock command is implemented.

Inspect exported history without touching a database:

```sh
pnpm exec tsx scripts/rehearsal/cli.ts history rehearsal.json events.json head.json
```

This returns nonzero deliberately: it verifies internal integrity, not an
independent latest-head witness. A matching head from the same database/archive
cannot establish completeness against an administrator who rewrote both.

The success status is always:

`HOSTED_TRUST_REHEARSAL_COMPLETE — RELEASE AUTHORIZATION NOT ESTABLISHED`

The summary identifies the exact run, artifact hash, store, head and event
count, with TLS state and unresolved guarantees. Hosted active replay/concurrency
injection is **NOT_RUN**: those destructive conflict scenarios are exercised
only in isolated local PostgreSQL tests. A hosted success demonstrates its
scoped reserve/append/readback path, not every failure case or disaster recovery.

## Step 7 — Review limitations and trust roots

| Attack or failure                                                             | Check and actual trust root                                                                       | Remaining limit                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Replaced artifact; altered metadata/bundle                                    | Actual Sigstore signature and subject digest; producer digest; canonical payload                  | Trusted producer can attest false non-identity claims                          |
| Other repository/owner/workflow/SHA/ref                                       | Certificate extensions, exact immutable pins and signer ref/digest                                | Operator must independently review pins and source                             |
| Other run/attempt or replayed UUID                                            | Signed invocation identity, expected run/attempt/UUID; unique DB attempt and scope owner          | No automatic owner cleanup                                                     |
| Environment substitution                                                      | Canonical signed environment, independent expectation, separate environment ID and DB ACL         | Environment is metadata, not a dedicated certificate claim                     |
| Untrusted or expired root                                                     | Reviewed root bytes/hash, seven-day policy window and pinned CLI                                  | Offline checks do not fetch revocations                                        |
| Modified approval; producer self-authorization; missing/conflicting reviewers | No approval capability; false flags; existing environment GET and gate                            | Authenticated human release authorization remains unimplemented                |
| Wrong database/TLS interception/store ID                                      | Explicit host/CA `verify-full`, session checks and pinned UUID                                    | Database administrators and CA configuration remain trusted                    |
| Concurrent attempts; lost acknowledgement; interrupted runner                 | Transactional scope ownership, CAS head, readback and no implicit retry/unlock                    | Operator must reconcile interrupted ownership                                  |
| Deleted artifact; missing/modified/stale history                              | Exact artifact IDs, event hashes and expected saved head                                          | Deleting/replacing all evidence cannot be detected without an independent head |
| Fixture promoted to hosted evidence                                           | Private in-process verification receipt only after real MeshDrop signature checks                 | No MeshDrop hosted signature was exercised during local implementation         |
| Accidental deployment                                                         | Separate module graph, command/action/permission allowlists and tests; existing blocked publisher | A future malicious workflow rewrite requires source/settings review            |

An attestation over the final head would authenticate that historical head,
not prove it is the latest or guarantee retention. Actions artifacts are
deletable and expire. Object-lock storage can preserve individual versions but
does not alone prove which head is newest or provide cross-object transactions.
A second database under the same administrator is not an independent witness.

`RecoveryWitness` defines exact scope/run/head, independent authority, freshness
and retention requirements. Its hosted factory remains disabled with
`INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED`. An operator must provide a
separately administered, authenticated latest-head service with anti-rollback
and retention guarantees before claiming independent recovery completeness.
No witness is fabricated, and no local SQLite/PostgreSQL fixture supplies one.

Repository/environment administration, approved source and action code, GitHub's
OIDC/attestation service, reviewed TUF roots/CLI, runner isolation, database CA,
store ACLs and store administrator are distinct trust boundaries. Costs and
availability include Actions minutes/artifact retention, eligible GitHub plan,
and externally provisioned PostgreSQL/TLS/backups. No resources are provisioned
or costs incurred by dispatch during this implementation because it is not run.

Before any future publication work, separately establish authenticated human
publication/acceptance authority, independently retained recovery heads,
provider-confirmed fresh identities and admission state, external configuration
review and authorized hosted testing. See [Task 08 trust integrations](trusted-release-integration.md),
[release provenance](release-provenance.md), [Cloudflare preflight](cloudflare-preflight.md)
and [production rollback](production-rollback.md). This rehearsal provides no
exception to their blocked publication, acceptance or rollback policies.

## Official contracts reviewed

- [GitHub environment GET and read permissions](https://docs.github.com/en/rest/deployments/environments#get-an-environment): the preflight uses only this GET endpoint, with the documented API version.
- [GitHub environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments): required reviewers gate jobs; one listed reviewer may satisfy the gate. This is not a multi-party authorization protocol.
- [GitHub offline attestation verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline): reviewed roots and immutable certificate repository IDs are necessary, and offline revocation knowledge is limited.
- [Official attestation action inputs/outputs](https://github.com/actions/attest/blob/v4/action.yml) and [Fulcio certificate identity extensions](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md): subject bytes, bundle export, signer URI and immutable digests are separate checks.
- [PostgreSQL TLS verification](https://www.postgresql.org/docs/current/libpq-ssl.html) and [session TLS statistics](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-SSL-VIEW): hostname/CA verification and actual connection state are checked.
- [Object Lock retention boundaries](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html): protection applies to versions; it does not prevent newer versions or delete markers. A latest-head witness needs additional independently trusted semantics.
