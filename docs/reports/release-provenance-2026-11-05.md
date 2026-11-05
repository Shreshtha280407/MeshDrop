# Release provenance and admission hardening — 5 November 2026

## A. Investigation verdict and original gaps

Investigation began read-only on `main`, HEAD
`31b8278a66811202e6b9e9bd48f24dae7c30a7e7`, with a clean working tree. Initial
tracked-file hashes were retained before editing. Node 24.22.2 and pnpm 10.34.7
are used for local validation. No Cloudflare account, production environment file
or live session was accessed. The user separately authorized only the read-only
npm advisory request required by `pnpm audit:release`.

Confirmed gaps in the original lifecycle:

| Point                  | Existing evidence                                | Gap / consequence                                                                              |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Source → preparation   | `cloudflare.ts` built current files              | No exact clean source/repository/protocol/toolchain identity in the manifest                   |
| Artifact preparation   | File hashes and generated configurations         | No versioned release record, preparation identity or separate lifecycle                        |
| Approval → publication | Manual workflow / environment declaration        | No recorded release-bound acceptance or independently authenticated prior acceptance           |
| Worker publication     | Wrangler exit code                               | Version ID and independent readback were lost                                                  |
| Pages publication      | Wrangler exit code                               | Deployment ID and independent readback were lost; partial Worker publication was not journaled |
| Readiness              | `/ready` expected 200                            | Intentional paused 503 looked like failure after publication                                   |
| Admission              | Factory default false; workflow omitted variable | Publishing could unintentionally reopen a paused deployment                                    |
| Cleanup / recovery     | Workflow deleted deployment artifact directory   | Prepared files and recovery evidence could disappear; no durable write-ahead history           |
| Task 03 consumption    | Legacy manifest examples with UUID-shaped fields | Content integrity was separate from unimplemented authenticated provider provenance            |

The local hardening is implemented. **Live publication is intentionally blocked**
until a separately reviewed hosted preflight/identity adapter and approval
integration are available. This is not a claim of a complete validated production
release process.

## B. Release architecture

The new lifecycle is:

1. Validate exact repository, clean source commit/tree and explicit configuration.
2. Build real frontend/gateway/Worker artifacts in a unique local directory.
3. Write canonical immutable schema-2 preparation and an initial `PREPARED` record
   with null provider IDs and no acceptance.
4. Require authenticated previous acceptance, independently observed scoped live
   identities/admission, explicit intent and unchanged artifact integrity.
5. Persist `INCOMPLETE` intent before each modeled mutation; independently confirm
   Worker, then Pages; reread for concurrent changes.
6. Check correct readiness/admission/auth/session behavior and cleanup before
   recording `PUBLISHED` — never automatically accepted.
7. Require a separate authenticated operator decision, all evidence references,
   exact manifest and confirmed component IDs before `ACCEPTED`.
8. Require independently authenticated accepted provenance again before rollback
   eligibility. The offline CLI cannot authenticate it or approve production.

`PublicationProvider` is a required dependency-injected interface, with no default
network transport or hidden authentication. Fixtures use `offline-fixture`, keep
`provider.confirmed=false`, and never satisfy production eligibility. The actual
`hostedProvider()` throws `HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED`.
The CLI stops before credential access or spawning Wrangler publication; there
is no environment flag or fixture fallback that bypasses this restriction.

The original Cloudflare architecture, deployed application, actor classes,
migrations, provider secrets and database formats are unchanged. Bootstrap,
provision/revoke and old remote maintenance drills were not executed; they remain
separately authorized operations, not alternative approved publication paths.

## C. Exact records and trust boundaries

The canonical schema and operational details are in
[the release guide](../release-provenance.md) and `release-record.ts`.

`Manifest` has schemaVersion 2 and exactly: `repository`, `sourceCommit`,
`sourceTreeSha256`, `environment`, `accountId`, `origin`, `worker`, `project`,
`protocolVersion`, `admissionPaused`, `preparedAt`, `files`, `workerFiles`,
`gatewaySha256`, `configurationSha256`, `migrationsSha256`, `toolchain`, and `id`.
`toolchain` identifies Node/pnpm/esbuild/Vite and the dependency lock hash.
The ID is canonical payload SHA-256, not a signature or authenticity claim.

`ReleaseRecord` has recordVersion 1 and exactly: `manifestId`, `scope`, `state`,
`phase`, `sequence`, normalized `admission`, `provider`, nullable `acceptance`, and
nullable fixed `failure`. States are `PREPARED`, `INCOMPLETE`, `PUBLISHED`,
`ACCEPTED` and `REJECTED`. A prepared state cannot contain publication claims;
a published state cannot contain an acceptance decision or failure claim.

Acceptance binds the exact manifest/Worker/Pages pair, operator, decision time and
all seven evidence references. Duplicate/conflicting decisions and partial
checklists are rejected. A separate authorization callback is mandatory; previous
acceptance also requires independent authentication before publication starts.
Unsigned serialized claims cannot authorize themselves.

Task 03 can parse and verify schema-2 content/configuration/migration/toolchain
identity and lifecycle state. `verifyPairProvenance` then rejects missing, legacy,
prepared, rejected, incomplete and fixture provenance. Even an accepted hosted
claim requires an independent authenticator. `productionApproved: false` remains
unconditional. Legacy content checks remain available diagnostically without
promoting old records into accepted releases.

## D. Admission safety

The workflow now carries explicit desired state and action. The checked-in
example starts paused. Actual preparation/workflow paths reject missing, empty
or ambiguous state; the existing pure configuration helper retains its local
development compatibility defaults.

Preservation requires fresh actual state to match the desired state. Reopening
requires explicit `reopen` plus an acknowledgement bound to environment, active
Worker version and prepared manifest ID. A GitHub variable is not accepted as
evidence of live state. The journal records observed/desired booleans and action,
without retaining a confirmation input or credential.

Paused publication expects liveness 200, readiness 503, room creation 503,
authorized existing-room access and correct authorization denials. The real
Miniflare integration verifies these behaviors and owner-only closure. New
workflow cleanup deletes only its own newly created private file. Existing files
are never overwritten or deleted after an exclusive-create failure.

## E. Failure handling

| Scenario                               | Defined behavior                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Worker succeeds, Pages fails           | `INCOMPLETE`; retain confirmed Worker ID; no acceptance                           |
| Pages succeeds, readiness fails        | `INCOMPLETE`; retain both identities; no acceptance                               |
| Worker identity unknown                | Stop before Pages; retain intent and null unknown ID                              |
| Pages identity unknown                 | Stop with Worker identity retained; no invented Pages ID                          |
| Provider/credential rejection          | Sanitized failure path; no automatic retry/acceptance; cleanup attempted          |
| Operator abort                         | Stop at a checkpoint boundary; preserve write intent and confirmed facts          |
| Partial acceptance                     | Invalid state/checklist; no acceptance file or accepted transition                |
| Recovery while paused                  | Preserve independently observed state; do not mistake intentional 503 for failure |
| Changed artifact/configuration         | Rejected before mutation and rechecked between stages                             |
| Missing/unverified previous acceptance | Halt before any publication call                                                  |
| Cleanup failure                        | `INCOMPLETE`, even after successful readiness; never accepted                     |
| Concurrent/tampered local record       | Exclusive snapshot/lock and sequence checks stop progress                         |

Snapshots use file/directory synchronization and atomic replacement, while
immutable sequence files retain write-ahead history. The workflow retains strict
secret-free JSON and preserves prepared artifacts. Runner-loss/off-host durability
is not established: recovery storage must be reviewed before any future hosted
mutation. There is no automatic rollback, real migration or blind resume.

## F. Changed files

| File                                            | Justification                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/deploy/release-record.ts`              | Typed canonical manifest/lifecycle schema, integrity and explicit acceptance rules                                                         |
| `scripts/deploy/release-lifecycle.ts`           | Fresh admission/readback contract, synchronized write-ahead journal, authenticated approval hooks and blocked hosted adapter               |
| `scripts/deploy/release-preparation.ts`         | Real isolated preparation, source/toolchain collection, unique artifacts and integrity rechecks                                            |
| `scripts/deploy/workflow-environment.ts`        | Explicit workflow configuration and owned-file cleanup                                                                                     |
| `scripts/deploy/inspect-release-record.ts`      | Read-only integrity/state inspection without approval claims                                                                               |
| `scripts/deploy/cloudflare.ts`                  | Connects preparation/dry-run; removes unsafe exit-code-only publish path and blocks before credentials                                     |
| `scripts/deploy/rollback-compatibility.ts`      | Consumes new manifests/records; separates content integrity from authenticated accepted provenance                                         |
| `package.json`                                  | Registers only the read-only inspection command; dependencies/overrides unchanged                                                          |
| `.github/workflows/deploy.yml`                  | Maps admission intent, uses exact release paths, retains sanitized journals and performs ownership-aware cleanup                           |
| `infrastructure/cloudflare/.env.example`        | Explicit paused state/action and reopening acknowledgement template                                                                        |
| `tests/fixtures/release-record.ts`              | Explicitly scoped simulator metadata/provider fixtures; no real confirmation claims                                                        |
| `tests/unit/release-provenance.spec.ts`         | Identity/state/admission/journal/partial-failure/approval/cleanup negative and positive coverage                                           |
| `tests/integration/release-preparation.spec.ts` | Real Vite/esbuild preparation, Task 03 consumption and actual Miniflare admission/auth/session behavior                                    |
| `tests/unit/rollback-compatibility.spec.ts`     | Retains content checks, rejects legacy synthetic provenance and preserves the historical Task 03 source proof                              |
| `tests/integration/v2-rollback.spec.ts`         | Keeps real historical actor/data proof; asserts exact Worker/gateway/bindings/migrations/protocol independently of changed release tooling |
| `docs/release-provenance.md`                    | Full preparation/publication/acceptance/recovery procedure and trust boundaries                                                            |
| `docs/production-rollback.md`                   | Replaces legacy manual enrichment with the new provenance gate                                                                             |
| `docs/deploy.md`                                | Documents unique preparation paths and blocked publication boundary                                                                        |
| `docs/runbook.md`                               | Links the current safety procedure before historical instructions                                                                          |
| This report                                     | Evidence, gap analysis, scope, validation and remaining limitations                                                                        |

No existing test was removed or skipped. The former legacy-UUID positive
eligibility assertion is tightened to rejection, as Task 04 requires. Actual
content integrity still passes its positive test. Both original historical
targets remain unchanged; the v2 persistence proof still runs real historical
code. No application feature, security audit threshold, dependency or lockfile
was changed. Core/browser/foundation CI remains unchanged.

## G. Validation

Focused validation passed 103 unit cases and three integration cases across the
new and existing affected suites. The release audit reports no known
vulnerabilities at the unchanged low threshold. Workflow syntax validation passes.
The original `pnpm verify:rollback` passes with four local runtimes disposed.
Task 03's P8 diagnostic rejects incompatible source; its v2 source diagnostic
reports source compatibility but exits nonzero without accepted release archives.

The full `CI=true pnpm check` passed with exit 0 in **7m20.8s**. All **762 tests
passed**, comprising the original 696 scenarios and 66 added cases. The existing
script chain executed each constituent command; none was disabled or skipped.

| Exact command                                                                                                                    | Result  | Evidence                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `pnpm verify:rollback`                                                                                                           | PASS    | Original P8 room round trip; four runtimes disposed                                           |
| `pnpm -r typecheck`                                                                                                              | PASS    | All ten workspace packages/apps                                                               |
| `pnpm typecheck`                                                                                                                 | PASS    | Root scripts and tests                                                                        |
| `pnpm lint`                                                                                                                      | PASS    | ESLint and formatting                                                                         |
| `pnpm check:secrets`                                                                                                             | PASS    | Rechecked after final report updates                                                          |
| `pnpm audit:release`                                                                                                             | PASS    | No known vulnerabilities; unchanged low threshold                                             |
| `pnpm test:unit`                                                                                                                 | PASS    | 516 tests, 25 files; 14.32s                                                                   |
| `pnpm test:security`                                                                                                             | PASS    | 42 tests, 5 files; 1.30s                                                                      |
| `pnpm test:integration`                                                                                                          | PASS    | 75 tests, 10 files; 18.23s                                                                    |
| `pnpm test:faults`                                                                                                               | PASS    | 18 tests, 2 files; 3.09s                                                                      |
| `pnpm build`                                                                                                                     | PASS    | Workspace build; Worker dry run only                                                          |
| `pnpm test:e2e`                                                                                                                  | PASS    | 106 browser cases; 5.8 minutes                                                                |
| `pnpm test:pwa`                                                                                                                  | PASS    | Five production PWA cases; 21.3s                                                              |
| `CI=true pnpm check`                                                                                                             | PASS    | Complete final chain; exit 0                                                                  |
| `pnpm exec vitest run --project unit tests/unit/release-provenance.spec.ts tests/unit/rollback-compatibility.spec.ts`            | PASS    | 103 focused cases                                                                             |
| `pnpm exec vitest run --project integration tests/integration/release-preparation.spec.ts tests/integration/v2-rollback.spec.ts` | PASS    | Three focused cases                                                                           |
| `pnpm inspect:release-record /tmp/meshdrop-task04-k74noi3b/schema-only-inspection-fixture`                                       | PASS    | Real CLI schema/record inspection; PREPARED, no IDs/acceptance/provenance/production approval |
| Hosted publication, identity or acceptance verification                                                                          | NOT RUN | Prohibited; default adapter unavailable                                                       |

The schema-inspection fixture was removed afterward. Its initial execution was
blocked by sandbox permissions for tsx's local IPC socket; rerunning with the
required local process permission passed. During implementation, a new integration
assertion compared an error code with message text; it was corrected to assert
the code. No unresolved application or tooling test failure remains.

Both workflow files passed Actionlint 1.7.12 with the existing temporary
`ubuntu-26.04` runner-label configuration. Only the deployment workflow changed;
core/browser/foundation workflow behavior is preserved.

Task 03 diagnostics were explicitly executed:

```sh
pnpm verify:rollback-target 31b8278a66811202e6b9e9bd48f24dae7c30a7e7 e108e7a1f59bc37f41ba703240e08f176d47b33c
pnpm verify:rollback-target 31b8278a66811202e6b9e9bd48f24dae7c30a7e7 b103d568d7d2bed62957f4c129dc238a5b7752f6
```

Both returned exit 1 as required: P8 is incompatible; the v2 source matches the
committed baseline but no accepted release archive/authentication was supplied.
`productionApproved` remains false in every offline result. Local uncommitted
release inputs also remain ineligible; no source-cleanliness check was bypassed.

## H. Limits

NOT RUN: live Cloudflare reads/writes, actual deployment/confirmation, production
secret changes, migrations, provider authentication, real approval integration,
runner-loss/off-host recovery and production acceptance. Provider credentials
were never tested against an account. Offline fixtures model failure responses;
they do not authenticate real identities or prove hosted availability.

The hosted adapter and independent approval/authentication integration must be
reviewed and separately authorized before future publication can resume.
Preparation refuses this task's uncommitted source, as designed. Current local
fixtures exercise the shared builder without claiming a clean production build
or a deployed release. Full production recovery readiness remains unverified.

## I. Repository safety

Commits: 0. Pushes: 0. Pull requests: 0. Deployments: 0. Remote resource changes: 0.
All edits remain local and uncommitted. No Git branch/history rewrite, user-data
deletion or Cloudflare account operation was performed. The npm advisory lookup
was separately authorized; no hosted provider adapter or account operation was
executed. Browser suites used the existing local-server test configuration.

Final hashes preserve 417 of the original 427 tracked files exactly. The ten
intentional tracked edits and ten new files are listed above. Application code,
schemas, migrations, dependency lock, minimatch override, README/media and core CI
remain unchanged. HEAD remains `31b8278`; nothing is staged. Earlier artifact runs
and existing local services are preserved.

## J. Review boundary

This phase stops after local validation and review. It does not enable a real
publisher, execute a hosted acceptance drill or begin another improvement phase.

**PASS — READY FOR REVIEW**, for the authorized local implementation and defined
test cases. Live publication remains blocked until separately authorized hosted
preflight/readback and approval integrations exist; production release readiness
is not certified by this result.
