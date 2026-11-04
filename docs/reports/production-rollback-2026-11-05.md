# Production rollback compatibility audit — 5 November 2026

## Verdict and investigation baseline

The full current deployment cannot roll back to P8. A real prior v2 source is
compatible under the conservative local policy, and its all-actor persistence
round trip passes. **No current production rollback target has been established**:
the available historical preview evidence is not an authenticated, source-matched
current production release archive. Default production recovery is therefore a
reviewed forward fix until those hosted/provenance gates are separately met.

Read-only investigation began on `main`, HEAD
`077a4d4d8d52b78b0e9eb2e2b9661d18f4539d31`, with a clean working tree. The 421
tracked files were hashed before changes. Node 24.22.2 and pnpm 10.34.7 were used.
Task 01's override, lockfile and security documentation, Task 01B's workflows and
Task 02's verifier/tests remain intact. No Cloudflare account access, live-session
inspection or hosted rollback was attempted. User-reported hosted CI success was
not independently queried or reclassified.

## Architecture inventory

| Component                                  | Actual implementation / bindings                                                                                                                  | Persisted state and release implications                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages frontend and module gateway          | One Pages project per environment; `infrastructure/cloudflare/pages-worker.ts`; `ASSETS`, private `SIGNALING`, exact `PUBLIC_ORIGIN`              | Static assets, gateway and PWA are a separate deployable component. Stable origin and service identity must match. Branch/hash aliases are rejected.                                                                                            |
| Private signaling Worker                   | Generated name `PAGES_PROJECT-signaling`; no public workers.dev/preview URL; entry exports default handler and all three actor classes            | Worker code, variables and secrets can change independently of Pages. `/health` is liveness; `/ready` validates configuration and pause status. Neither proves database or TURN availability.                                                   |
| `SESSION_ROOMS` → `SessionRoom`            | Mandatory namespace; UUID room names; v1 SQLite class                                                                                             | `room_meta`, `invites`, `peers`, `ticket_nonces`, `security_windows`; capability verifiers, role/approval, epoch/revision/sequences, TTL/tombstone and replay budgets. Hibernation attachments are separately validated against SQL.            |
| `RELAY_POOLS` → `RelayPool`                | Always declared in generated deployments despite optional Env typing; named object `deployment`; v2 SQLite class                                  | KV key `pool`: overlapping provider keys and propagation/expiry times, usage, allowance and refresh time. Alarm refresh persists state. No room/file content.                                                                                   |
| `OPERATIONS_MONITOR` → `OperationsMonitor` | Always declared in generated deployments despite optional Env typing; named objects `counters` and `journal`; v2 SQLite class                     | SQL `buckets`, `outbox`, `journal`; KV `account-usage` with cached provider counts/times. Authenticated alert journal and retry behavior must survive code switches.                                                                            |
| Rate-limit namespaces                      | `CREATE_LIMITER`, `REQUEST_LIMITER`; IDs deterministically derived from Worker identity                                                           | Current generated limits 30/300 per minute. Changing Worker/project identity or namespace IDs is an infrastructure change, not safe code rollback.                                                                                              |
| Required configuration                     | `ALLOWED_ORIGINS`, Pages `PUBLIC_ORIGIN`/`SIGNALING`/`ASSETS`, all generated actor/rate bindings; production operator secret `OPS_REVOKE_SECRET`  | Exact origin/role/secret enforcement must remain. Secret contents and actual live binding identities were not accessed.                                                                                                                         |
| Optional configuration                     | Direct/STUN, `TURN_PROVIDER`, provider-specific settings/secrets; account Analytics Read token plus account ID; TTLs, pause, audit classification | Defaults: room/invite/ticket 900/300/30 seconds; tombstone 60. Generated TURN TTL 300. Provider configuration must be complete and unmixed.                                                                                                     |
| TURN providers                             | Direct, coturn HMAC, Cloudflare TURN API, Metered Free pool; implementation in `turn-config.ts` and credential routes                             | Documented deployed mode is Metered Free, not rechecked live. Accounts/quotas may be shared across isolated environments. Credentials/allocations are external state; code rollback does not revoke or restore them.                            |
| Monitoring / schedules                     | Sampled fixed audit classifications, no invocation logs; one-minute cron for Metered and/or account analytics                                     | Counter/journal are internal actors; HTTPS delivery and account/provider APIs are external dependencies. Readiness does not prove delivery, usage freshness or quota state.                                                                     |
| Migrations                                 | Development Wrangler and production generator declare v1 `SessionRoom`, then v2 `RelayPool` + `OperationsMonitor`                                 | Actual applied history is UNVERIFIED without separately authorized account inspection. The repository uses legacy migrations; lifecycle changes and data restoration are not reversed by code rollback.                                         |
| Release pipeline                           | Manual default-branch deployment after reusable core/browser/foundation gates; environment-scoped job; concurrency with cancellation disabled     | Prepare freezes artifacts/configs/hashes; dry-run is local. Publish uploads Worker/secrets, then Pages, then checks readiness. Partial success is possible. GitHub environment protection and external deployers are outside YAML's guarantees. |
| Active sessions / browser data             | Peer-to-peer file bytes; SQL control state; browser checkpoints/OPFS/IndexedDB and service-worker cache                                           | Admission pause blocks new rooms only, not every join. P2P may continue; active signaling can reset during code updates. Namespace/data deletion and origin changes can lose access; no uninterrupted-connection guarantee.                     |

Within an environment, actor namespaces and named objects persist across
releases. Preview and production use distinct project/Worker/namespace identities,
origins and operator secrets by design. Provider accounts/subdomains/quotas may
still be shared. No D1/R2/file database is deployed by this architecture.

## Compatibility matrix

All commits below were inspected from the actual local Git object database.
Protocol version is 1 for every evaluated source. Required current classes are
`SessionRoom`, `RelayPool`, `OperationsMonitor`; required namespace bindings are
`SESSION_ROOMS`, `RELAY_POOLS`, `OPERATIONS_MONITOR`, plus both rate limiters and
the Pages gateway/service/origin contract.

| Target                                      | Classes / bindings                                            | Migration and protocol evidence                                                | Classification and gate                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e108e7a1f59bc37f41ba703240e08f176d47b33c`  | Only `SessionRoom` / `SESSION_ROOMS`; no Pages gateway        | v1 only; protocol 1                                                            | **UNSAFE** as complete current target. Reject missing exports/gateway, bindings, history and changed inputs. Room-only local compatibility remains separately verified.                     |
| `2426b4e`                                   | P9 gateway exists, but only `SessionRoom` actor               | v1 only; protocol 1                                                            | **UNSAFE** as complete current target. Reject both missing v2 exports/bindings and history mismatch.                                                                                        |
| `1f5af258a639651fdc8b588637920ca31bd88986`  | All v2 actors/bindings present                                | v1 + v2; protocol 1; runtime sources equal, dependency override/lock differ    | **UNVERIFIED**, rejected by exact-input policy. Equal class names/history do not certify a different locked graph; the later security repair is retained.                                   |
| `919995f`                                   | All v2 actors/bindings present                                | Exact protected inputs/history/protocol match                                  | **CONDITIONALLY SAFE** source candidate; no reviewed current/target production archives or live mapping established. Missing archives fail the CLI.                                         |
| `b103d568d7d2bed62957f4c129dc238a5b7752f6`  | All v2 actors/bindings present                                | Exact protected inputs/history/protocol match; real all-actor local round trip | **SAFE — LOCALLY VERIFIED** within the defined v2 data/auth/drain simulation; **CONDITIONALLY SAFE** for a hosted release, which requires separate provenance/resource/secret verification. |
| `077a4d4d8d52b78b0e9eb2e2b9661d18f4539d31`  | Current v2 architecture                                       | Current source self-consistency passes                                         | **UNVERIFIED** as an identified hosted restore version. The validator rejects reusing the same Worker ID and never infers deployment identity from Git HEAD.                                |
| Previously recorded preview component UUIDs | Tracked reports describe v2 checks and real preview transfers | Historical scoped evidence, explicitly not source-matched release provenance   | **UNVERIFIED** as a present production target. No automatic promotion or assumed source mapping.                                                                                            |

For production: code rollback is distinct from namespace/configuration changes,
data restoration, relay-provider changes, secret rotation and Pages promotion.
SQL/KV transforms, lifecycle changes and deletion/restoration require their own
forward recovery strategy. The validator rejects them rather than fabricating
an inverse migration or an arbitrary exception.

## Local safeguards implemented

- `scripts/deploy/rollback-compatibility.ts`: derives exports from real compiled
  Git Worker code, bindings/history from real Wrangler source, protocol from its
  TypeScript constant, and protected input hashes from Git/toolchain declarations.
  Compares the actual production generator with the current Wrangler contract.
  Validates both release archives, rebuilds Worker/gateway/client code locally,
  rejects changed scope/provider/drain settings and malformed/incomplete metadata,
  and returns structured failure reasons. Historical deployment code is never
  evaluated. All revision arguments are validated before dynamic Git lookup.
- `scripts/deploy/verify-rollback-target.ts` and `package.json`: read-only offline
  CLI, exit 1 for incompatible/missing/unavailable inputs. Even a fully passing
  local archive check reports `productionApproved: false`.
- `tests/unit/rollback-compatibility.spec.ts`: 39 checks using actual historical
  sources and actual frontend/Worker/gateway builds. Synthetic provider UUIDs are
  format fixtures only and are never represented as deployed releases.
- `tests/integration/v2-rollback.spec.ts`: actual current/historical workerd code,
  real SQL/KV persistence, owner/operator authorization, API state, drain and
  cleanup across four isolated runtimes.
- `docs/production-rollback.md`: operational release/rollback/forward-fix policy,
  metadata requirements, approval boundaries and response procedures.
- `docs/runbook.md`: links the policy and replaces unconditional production
  rollback advice with the required compatibility/provenance gates.
- This report: architecture, matrix, evidence and limitations.

No production source, schema, migration, deployment publisher, remote rollback
command, workflow, dependency, lockfile, existing test or security threshold was
changed. The new suites are automatically included by existing test discovery.

## Defined local proof and negative cases

The positive v2 scenario uses `b103d56`, not a fabricated compatible Worker:
current → historical v2 → current → paused current. The real pool creates and
persists a cold relay key from a synthetic provider response. The monitor stores
real cached account usage and a valid authenticated alert in its separate
journal object. No real provider request or credential issuance occurs.

Before room/operational reads after each version switch, read-only Node SQLite
inspection compares hashes of every persisted actor's SQL tables/rows, including
the actual serialized KV blobs. At least four object databases are required.
Room approval/identity/epoch/expiry, pool state, cached usage and journal content
remain readable. Invalid room/operator authorities are denied without reaching
providers. Paused creation/readiness are 503 while authorized existing-room
closure succeeds. All four runtimes are disposed, ports stop responding, and
only the test's unique temporary directory is removed, including failure paths.

Negative cases include each missing class, missing entry, invalid/external
bindings, unsupported/duplicate migration histories, migration boundary,
unreviewed persistent input changes, malformed/unavailable commits, option-like
revision arguments, protocol mismatch, real P8 rejection, missing archives,
incomplete/corrupt metadata, changed config/rate limits, missing/changed/extra
artifacts, forged file maps, symlinks, scope/drain mismatch and identical Worker
IDs. These are explicit cases, not a claim of universal compatibility coverage.

A final negative case performs actual successful artifact verification and
removes its disposable build output, then injects an I/O cleanup error. The
validator reports failure with sanitized diagnostics rather than retaining a
success flag. Its production client rebuild disables environment-file loading,
strips inherited build/provider/preload settings, and remains reproducible under
an explicitly conflicting caller `NODE_ENV`. Build-based cases use bounded
30-second test budgets; existing test timeouts are unchanged.

The full CLI positive test uses real local builds and generated configuration
in disposable archives with clearly synthetic version IDs. It verifies local
consistency and a zero exit, while asserting `productionApproved: false`. The
real incompatible P8 CLI exits 1 with actionable JSON. A source-compatible
candidate without archives exits 1 with `RELEASE_ARCHIVES_REQUIRED`.

## Regression results

The final `CI=true pnpm check` passed with exit 0 in **7m14.7s**, after the final
argument/build-isolation/cleanup safeguards. Its existing script chain executed
every listed constituent command. All **696 tests passed**: the original 656
plus 39 new unit cases and one all-actor integration case. No existing assertion
or test was changed, skipped or weakened.

| Command                                                                            | Result  | Evidence                                                                                 |
| ---------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `pnpm verify:rollback`                                                             | PASS    | Original P8 room round trip, authorization/drain, four runtimes disposed                 |
| `pnpm -r typecheck`                                                                | PASS    | All ten workspace packages/apps                                                          |
| `pnpm typecheck`                                                                   | PASS    | Root scripts and tests                                                                   |
| `pnpm lint`                                                                        | PASS    | ESLint and Prettier                                                                      |
| `pnpm check:secrets`                                                               | PASS    | No matching embedded credentials; rechecked after report updates                         |
| `pnpm audit:release`                                                               | PASS    | No known vulnerabilities; unchanged `--audit-level low`                                  |
| `pnpm test:unit`                                                                   | PASS    | 452 tests, 24 files; 17.65s                                                              |
| `pnpm test:security`                                                               | PASS    | 42 tests, 5 files; 1.22s                                                                 |
| `pnpm test:integration`                                                            | PASS    | 73 tests, 9 files; 13.92s                                                                |
| `pnpm test:faults`                                                                 | PASS    | 18 tests, 2 files; 2.79s                                                                 |
| `pnpm build`                                                                       | PASS    | Workspace build; Worker dry run only                                                     |
| `pnpm test:e2e`                                                                    | PASS    | 106 browser cases; 5.8 minutes                                                           |
| `pnpm test:pwa`                                                                    | PASS    | 5 production PWA cases; 20.2s                                                            |
| `CI=true pnpm check`                                                               | PASS    | Complete final chain; exit 0                                                             |
| `pnpm exec vitest run --project unit tests/unit/rollback-compatibility.spec.ts`    | PASS    | 39 focused cases, including full positive CLI and expected incompatible-target rejection |
| `pnpm exec vitest run --project integration tests/integration/v2-rollback.spec.ts` | PASS    | Real historical all-actor persistence proof                                              |
| Hosted deployment/rollback/migration/provider validation                           | NOT RUN | Prohibited in this task; separate explicit authorization required                        |

Both workflow files also passed Actionlint 1.7.12 with the existing temporary
runner-label configuration for `ubuntu-26.04`. Neither workflow changed.
`pnpm why minimatch` confirms a single resolved version, 11.0.1.

Standalone source-diagnostic commands were also executed:

```sh
pnpm verify:rollback-target 077a4d4d8d52b78b0e9eb2e2b9661d18f4539d31 e108e7a1f59bc37f41ba703240e08f176d47b33c
pnpm verify:rollback-target 077a4d4d8d52b78b0e9eb2e2b9661d18f4539d31 b103d568d7d2bed62957f4c129dc238a5b7752f6
```

Both returned **exit 1 as required**: P8 is incompatible; the v2 candidate is
source compatible but has no supplied complete archives. The full CLI positive
case is executed inside the unit suite with temporary genuine builds and
explicitly synthetic provider IDs, then removes its archives.

## Recovery strategy and unverified gates

Follow [the operational runbook](../production-rollback.md). Roll back only to
an explicitly accepted matching release after local checks and separately
authorized hosted verification; never automatically select an older version.
Prefer a forward fix preserving namespace/format/security contracts when any
gate is unknown or a security fix would be removed. Halt releases and preserve
safe admission controls if neither recovery path is established.

The original publisher remains Worker/secrets → Pages → readiness, without an
automatic restore transaction or the new validator wired into publishing.
The manual deployment workflow also omits `ADMISSION_PAUSED` from its environment
mapping, so that path defaults to reopened admission; the runbook prohibits its
use for paused recovery. No workflow or remote setting was changed to hide this
existing limitation.
The new safeguard is an explicit offline operator gate, not an automatic claim
about a remote target. Existing preparation manifests lack complete source and
provider metadata. The older preview drills are not substitutes for this gate;
their weaker selection/provenance limits are documented in the runbook.

NOT RUN: Cloudflare API/provider account inspection, hosted rollback/deployment,
production migrations, live-session access, real TURN allocation continuity,
hosted webhook/cron continuity, live secret compatibility, backup restore and
physical-device rollout continuity. These require separate explicit approval
and cannot be inferred from local green tests or historical preview reports.

No commits, pushes, pull requests, deployments, publications or remote
modifications were performed. All edits remain local and uncommitted; Task 03
stops for review without beginning another improvement phase.

Final safety review confirms 419 of the original 421 tracked files are byte
unchanged. The two intentional edits are command registration in `package.json`
and guidance in `docs/runbook.md`; six new files supply the validator, tests and
documentation. HEAD remains `077a4d4`; nothing is staged. Existing local services
and earlier artifact runs are preserved. **PASS — READY FOR REVIEW**, within the
local safeguards/policy scope; production promotion remains unapproved.
