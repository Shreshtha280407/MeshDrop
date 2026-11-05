# Release provenance, admission controls and acceptance

Task 04 separates artifact preparation, publication confirmation and acceptance.
This is the current procedure; it supersedes manual enrichment of Task 03's
legacy manifests. Local record integrity is not authenticated provider provenance.

**The production publishing adapter is deliberately unavailable.** The existing
`deploy:cloud publish` entry point now stops before private environment/auth
access or any Wrangler publication. It verifies its local inputs and records
`HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED`. It cannot fall back to the old
exit-code-only publisher or a fixture. A separately reviewed and authorized
hosted readback/preflight adapter is required before publication can resume.
No release or rollback is automatically approved by these changes.

Task 05 adds a separate [read-only provider preflight](cloudflare-preflight.md).
It inspects pinned control-plane identities only when separately authorized and
cannot establish prepared artifact provenance or accept a release. Publication
remains blocked; the deployment workflow does not invoke the new diagnostic.

## Lifecycle and trust

| State        | Meaning                                                                             | Provider IDs / acceptance                                        |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PREPARED`   | Identified source, configuration and local artifacts                                | IDs null, no observation, no acceptance                          |
| `INCOMPLETE` | Write intent, partial publication, failure, abort or uncertain completion           | Retain only IDs already independently observed; never eligible   |
| `PUBLISHED`  | Both component identities, admission state, readiness and cleanup checked           | Not accepted; acceptance remains null                            |
| `ACCEPTED`   | A separate explicit operator decision binds all required evidence to the exact pair | Eligibility still requires independent provenance authentication |
| `REJECTED`   | Explicit operator rejection                                                         | Never eligible                                                   |

Records also carry a scope: `unverified`, `offline-fixture` or
`hosted-observation`. Fixture records are simulations: their provider confirmation
is always false, and even simulated acceptance cannot satisfy the rollback
validator. No fixture adapter is selectable by the production CLI or workflow.

A UUID's shape, a Git SHA, a timestamp or a matching SHA-256 inventory does not
authenticate a release. Hosted claims in unsigned JSON also do not authenticate
themselves. Task 03's validator requires complete accepted provenance and a
separate trusted authenticator. Its normal offline CLI has no authenticator and
continues to report `productionApproved: false`. Forged/self-asserted records and
old schema-1 manifests never become approved targets through local inspection.

## Preparation and immutable manifest

Use Node 24, pnpm 10.34.7 and frozen dependencies. Start from the exact reviewed
source commit with a clean tracked/untracked working tree and the expected
repository origin. Do not commit during an assistant task that prohibits it;
preparation correctly refuses uncommitted source. The shared local builder can
be exercised with explicit test inputs without claiming deployment provenance.

The selected private environment file must explicitly contain:

```dotenv
ADMISSION_PAUSED=true
ADMISSION_ACTION=preserve
ADMISSION_REOPEN_CONFIRMATION=
```

`true` and `false` are the only accepted desired-state strings. Missing/empty or
ambiguous values are rejected by preparation and the workflow writer. The pure
configuration factory retains its existing local-development defaults; it is
not a substitute for these release gates.

When separately authorized to read the selected private configuration, run local
preparation from a clean reviewed checkout:

```sh
pnpm deploy:cloud prepare preview
```

Preparation creates a **new** `run-*` directory under
`.meshdrop-artifacts/deploy/preview/`, plus a private journal under
`.meshdrop-artifacts/releases/preview/MANIFEST_ID/`. It prints both paths and a
`PREPARED` state. It never reuses or deletes an older artifact directory.
GitHub Actions receives controlled path/manifest outputs, without secret values.
The frontend build disables environment-file loading and inherited build/provider
settings; the gateway and signaling Worker are bundled locally.

`manifest.json` is canonical JSON with sorted object keys and a trailing newline.
It has **schemaVersion 2** with these exact fields:

| Fields                                                    | Validation / meaning                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `repository`, `sourceCommit`, `sourceTreeSha256`          | Expected MeshDrop repository, exact 40-character commit, hash of its Git tree inventory         |
| `environment`, `accountId`, `origin`, `worker`, `project` | Exact environment, account identity, HTTPS origin and environment-suffixed component identities |
| `protocolVersion`, `admissionPaused`, `preparedAt`        | Positive protocol integer, explicit desired boolean, canonical UTC preparation timestamp        |
| `files`, `workerFiles`                                    | Complete regular-file SHA-256 inventories; no secret-bearing hidden files or symlinks           |
| `gatewaySha256`                                           | Matches `files['_worker.js']`; Worker identity is `workerFiles['index.js']`                     |
| `configurationSha256`, `migrationsSha256`                 | Canonical fingerprints of both configurations, actor bindings and migration history             |
| `toolchain`                                               | Exact `node`, `pnpm`, `esbuild`, `vite`, and `lockSha256`                                       |
| `id`                                                      | SHA-256 of the canonical manifest payload without `id`; content consistency only                |

No provider version IDs or acceptance decision are stored in a prepared manifest.
Static secret values, capabilities, invitation codes, bearer proofs and provider
credentials are not fields in either public record schema. The producer receives
private deployment values but emits only the allowed metadata/fingerprints.

Local Worker dry-run now requires the exact generated directory:

```sh
pnpm deploy:cloud dry-run preview .meshdrop-artifacts/deploy/preview/run-EXACT_DIRECTORY
```

It rechecks artifact/configuration identity and uses its own disposable output
directory. It does not publish. Inspect the generated local record with:

```sh
pnpm inspect:release-record .meshdrop-artifacts/deploy/preview/run-EXACT_DIRECTORY
```

Inspection reports record integrity and **claimed** lifecycle state only;
`providerProvenanceVerified` and `productionApproved` remain false. It is not an
acceptance command.

## Hosted preflight contract — not executed in Task 04

`PublicationProvider` in `scripts/deploy/release-lifecycle.ts` is an explicit,
dependency-injected interface. There is no hidden `fetch`, provider login or
default transport. A future hosted adapter must be separately reviewed against
the actual supported provider APIs, credential scopes and independent artifact
correlation. Do not guess response fields, infer IDs from undocumented list order, scrape
untrusted CLI text, or treat upload exit codes as confirmation.

Before any publication, the adapter must independently observe:

1. Account/environment/Worker/Pages/origin scope and both active component IDs.
2. A previously accepted release record matching those identities. Missing
   history blocks publication; first deployment requires a separately reviewed
   bootstrap policy, not an invented previous release.
3. The actual admission boolean. Observations expire after 60 seconds and cannot
   be more than five seconds in the future. Missing, stale or foreign observations
   are rejected. A GitHub input or variable is only desired configuration.
4. Frozen artifact/source identity and the explicit admission intent.

The interface separately publishes and confirms Worker and Pages. Confirmation
must correlate the exact manifest/source/configuration and provider identity,
not just repeat the intended upload UUID. Before the second mutation and after
publication, re-read the active pair and refuse a detected third release.
These checks are not a provider-wide atomic lock; maintain an exclusive operator
window. None accesses real user sessions in the local implementation.

## Admission preservation and reopening

`preserve` requires desired state to equal the independently observed current
state. `pause` requires desired state true. An observed paused → desired open
transition requires `reopen` and this exact operator confirmation:

```text
REOPEN:environment:current-worker-version:prepared-manifest-id
```

The environment, active version and prepared content must match. The confirmation
is an explicit review acknowledgement, not a credential or a cryptographic
signature. It must be supplied after the exact preparation and current identity
are known; a pre-dispatch guess is not a valid two-stage approval process.
The current blocked workflow cannot reopen admission. A future authorized adapter
and approval procedure must preserve this preparation/review separation.

The journal records normalized action, observed/desired booleans and prior Worker
ID, without retaining the confirmation input. After Worker publication, readback
must confirm the desired state before Pages changes proceed. Paused readiness is
**503 by design**: liveness 200, room creation 503, and authorized existing-session
access plus authorization denials are required. An unexpected 503 while open is
a failure. Neither a pause nor rollback revokes every active invitation/relay
allocation or guarantees uninterrupted signaling.

The deployment workflow now maps explicit state/action inputs. It no longer
defaults a missing mapped value to open. Its private environment writer creates
only a new mode-0600 file, records ownership, and removes only its own file after
an output-reporting failure. Later cleanup runs only when ownership was recorded.
It does not delete the frozen artifacts or release journals.

## Partial publication and recovery

`ReleaseJournal` creates private canonical snapshots with exclusive creation,
monotonic sequence numbers, file and directory synchronization, and atomic latest
record replacement. A publication lock prevents retrying the same preparation;
duplicate/conflicting operator decisions are rejected. Unexpected on-disk record
changes stop progress rather than overwrite another actor's state.

An `INCOMPLETE` intent snapshot is persisted **before each mutation**. If a
provider call, readback, readiness check, abort, integrity check or cleanup fails,
the record never becomes accepted. A confirmed Worker ID is retained if Pages
fails; an unknown ID stays null. Provider errors become fixed diagnostic codes,
never raw responses/tokens. A lost response is uncertain completion requiring
independent reconciliation, not permission to retry blindly.

The workflow retains only strict secret-free journal JSON as an artifact and
preserves local prepared files. This is not proof of off-host durability if the
runner disappears before upload. Before a future hosted write, review durable
recovery storage, cancellation handling, freshness and exclusive-operation rules
for that environment. No hosted cancellation or runner-loss drill was performed.

After failure: halt publication; preserve the manifest, intent snapshots and any
confirmed IDs; independently reconcile the active pair; keep a verified pause
where safe; and choose reviewed forward recovery or a separately authorized,
compatible accepted rollback. There is **no automatic rollback** or blind resume.
Do not delete namespaces, run real migrations, clear user data or broadly force
secret rollback to obtain a green status.

## Explicit acceptance and Task 03 consumption

`release.json` has **recordVersion 1**. Its exact shape is defined by
`ReleaseRecord`/`parseRecord`: `manifestId`, `scope`, `state`, `phase`, `sequence`,
normalized `admission`, `provider`, nullable `acceptance`, and nullable fixed
`failure`. Provider observations bind scope, manifest, source/configuration and
both component IDs. A prepared record forbids publication fields; a published
record forbids acceptance or failure claims.

Acceptance is a separate explicit API decision bound to manifest ID and both
confirmed component IDs, operator identity and decision time. Evidence references
are SHA-256 identifiers for all seven required checks: artifact identity,
admission, authorization, persisted state, transfer/receipt, operations and
recovery plan. No partial checklist can be accepted. Evidence hashes identify
reviewed evidence; they do not authenticate the reviewer or prove the checks ran.
Authentication/approval must be independently established by the future hosted
integration. The CLI does not accept operator-entered provider IDs or promote a
record to accepted.

Keep the generated accepted journal alongside a copy of the frozen artifact
archive, supplying that exact generated `release.json` without manually editing
IDs or inventing a previous acceptance. Task 03 consumes schema-2 manifests and
the lifecycle record, verifies source/configuration/migration/toolchain and
artifact identity, and then requires accepted hosted provenance plus an independent
trusted authenticator. Legacy content can still be inspected diagnostically but
is never eligible. Prepared, rejected, incomplete and fixture records fail closed.
The normal offline rollback CLI cannot authenticate a hosted claim and therefore
cannot approve production recovery.

## Verification boundary

Task 04 tests actual local Vite/esbuild preparation, real Miniflare admission and
persisted-session behavior, filesystem ownership/journaling, and simulated provider
responses. Simulation scope is explicit and its provider confirmation stays false.
Existing application and rollback tests remain required.

Not verified: live IDs/configuration/secrets, real provider artifact correlation,
hosted publication/approval, real migrations, distributed readiness, runner-loss
recovery, physical session continuity or current production rollback readiness.
The unavailable hosted adapter and human authorization remain mandatory before
any future live operation. Do not enable publication by substituting a fixture,
setting a boolean, fabricating a signature, or editing a local record.
