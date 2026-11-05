# Production rollback and release recovery

This is the release decision runbook for the current three-actor architecture.
It supersedes timestamp-based target selection in older preview drills.
Local compatibility checks are necessary gates; they do not authorize deployment
or establish the current state of a Cloudflare account.

## Policy and eligibility

Use a previously accepted **matching Worker/Pages release record**, independently
mapped to its source commit, frozen artifacts, environment and actual provider
version IDs. Never select a target because it is the previous Git commit, the
previous deployment in a list, or merely declares migration tag `v2`.

The offline validator supports a deliberately conservative first policy:

- Every current Durable Object binding and exported class must remain present.
  Requirements come from the repository's Wrangler configuration and production
  configuration generator, not a separate version-name allowlist.
- SQLite creation histories must match exactly, in order. Duplicate tags,
  deletes, renames, transfers, backend changes and the newer declarative class
  lifecycle configuration require a separate review. No migration is reversed.
- Runtime, persistence/authentication code, frontend, protocol, deployment inputs,
  dependency lock and build-tool declarations must be unchanged. Changes to these
  inputs are rejected pending a separately implemented compatibility proof.
  Documentation, tests and this validator's command registration alone do not
  change this contract; other package metadata/scripts remain protected.
- Both archived releases must retain the same environment, origin, Worker name,
  service/actor bindings, rate-limit namespaces, provider mode, schedule and
  admission setting. A rollback must not silently reopen paused admission.
- Full file inventories and SHA-256 digests must match. Worker and gateway code
  are rebuilt from the exact Git sources; the unchanged frontend is rebuilt into
  a disposable directory and compared with the archived client, including PWA
  files. Extra, missing, modified or symlinked artifacts fail.
- Complete metadata must identify both actual releases. A local pass is not
  proof that those provider IDs exist, are active/healthy, or match the archives.
  Independently verify provenance, live resources and secret compatibility in a
  separately authorized hosted validation before permitting an operation.

This policy intentionally rejects some changes that could be compatible. It does
not treat equal schema names or a protocol number alone as compatibility proof.
There is no bypass or automatic promotion command.

P8 `e108e7a1f59bc37f41ba703240e08f176d47b33c` is **not eligible** for a complete
current deployment rollback. Its room data compatibility does not supply the
missing `RelayPool`/`OperationsMonitor` exports, bindings or v2 history. The v2
source at `b103d568d7d2bed62957f4c129dc238a5b7752f6` has local compatibility proof;
that does not identify an accepted production deployment of that commit.

Cloudflare code rollback keeps connected resources and can fail across Durable
Object lifecycle changes. It does not restore old data. See the official
[rollback restrictions](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
and [class lifecycle documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
MeshDrop currently retains its legacy `migrations` configuration. This task does
not convert it to the newer lifecycle format.

## Offline validation and record format

Use Node 24, pnpm 10.34.7 and frozen dependencies. Validate from the current
release's exact source checkout; preserve and review any release-input changes.
The verifier never checks out commits, fetches history, reads environment files,
loads provider credentials, contacts Cloudflare or deploys anything.
The client rebuild explicitly disables Vite environment-file loading and uses
an isolated production build environment, without inherited `VITE_*`, provider
credentials or `NODE_OPTIONS`.

```sh
pnpm verify:rollback-target CURRENT_40_CHARACTER_SHA TARGET_40_CHARACTER_SHA CURRENT_ARCHIVE TARGET_ARCHIVE
```

Use the [versioned release provenance procedure](release-provenance.md) for
preparation, independent publication confirmation, acceptance and journal recovery.
Schema-2 manifests and recordVersion-1 lifecycle records replace manual enrichment
of Task 03's legacy schema-1 examples. Legacy records remain unverified. Never
invent provider IDs or infer acceptance from timestamps or artifact hashes.

The new publishing entry point fails closed before credential access until a
separately reviewed hosted preflight/readback adapter is available. Simulator
records are explicitly tagged and cannot satisfy production eligibility. The
validator's content-integrity helpers are separate from accepted-provenance
verification; unsigned JSON still requires an independent trusted authenticator.

The validator reports `pass`, `sourceCompatible`, `artifactsVerified`, fixed issue
codes/messages, and always `productionApproved: false`. It exits nonzero for
incompatibility, missing records, unavailable commits or failed builds. Without
the two directories it performs source diagnostics and exits nonzero with
`RELEASE_ARCHIVES_REQUIRED`, even if source compatibility passes. Hashes detect
inconsistency; unsigned records alone do not authenticate provider provenance.

## Before deployment

1. Record the exact currently accepted Worker and Pages IDs, source commit,
   configuration, artifact inventory and acceptance evidence privately. Confirm
   that the source checkout actually represents the active release. Record both
   the restore pair and the proposed pair before any hosted write.
2. Run `CI=true pnpm check`, `pnpm audit:release`, `pnpm verify:rollback` and the
   offline target validator with both archives. Review security advisories and
   any exact-input rejection. Do not weaken the audit or tests.
3. Review all migration and storage changes. Namespace creation does not prove
   older code can read later SQL/KV data. Deletes, renames, transfers, storage
   changes and irreversible data transforms prohibit this rollback path. Use
   additive expand/contract changes only with explicit old/new-reader tests;
   the current validator still rejects changed inputs until that proof is added.
4. Separately authorize hosted verification of live binding identities,
   migrations/lifecycle, retained versions, Pages project/aliases, cron settings,
   secret compatibility and resource existence. Never compare by dumping secret
   values. Treat an unexpected provider-secret or operator-secret rollback as a
   halt condition, without broad force confirmations.
5. Review quotas, relay availability and recovery capacity. Preserve the
   existing free-only provider policy. Do not rotate relay/operator secrets or
   change provider accounts as an incidental rollback step.
6. Obtain explicit operator approval and an exclusive release window. GitHub's
   environment approval/branch protections must be independently configured and
   verified; YAML does not establish them. If no compatible accepted target can
   be proven, prepare a forward fix and maintenance plan instead of publishing
   with an assumed fallback.

## During deployment

The modeled publication order is Worker, independent Worker confirmation, Pages,
independent Pages confirmation, then readiness. The CLI currently blocks live
publication until the required hosted adapter is reviewed and available.
These are separate operations and partial success is possible. A lost response
is not proof that no change occurred. The workflow serializes its own selected
environment; it cannot lock out dashboard or local CLI operators.

Require old-client/new-server compatibility before Worker-first publication, and
require the reverse mixed state if recovery will change Worker first. The strict
offline policy currently permits identical runtime/client inputs only; broader
changes require their own staged compatibility tests. Check the exact deployed
pair after each step and stop on unexpected third versions.

When an admission pause is approved, preserve it across releases. The existing
pause blocks **new room creation**, not every join to an existing invitation.
Check `/health` is 200, new creation is 503, an authorized existing synthetic
room is readable/closable, and invalid authority is rejected. `/ready` is
intentionally 503 during a pause; the current publisher's final readiness check
therefore reports failure after applying a paused release. Do not mistake that
expected condition for a failed upload or automatically revert the pause.

The manual workflow now carries explicit admission state/action inputs and
requires owned-file cleanup. Inputs describe desired state; they do not prove
currently deployed state. The new preflight contract verifies preservation and
requires a manifest/current-version-bound acknowledgement before reopening.
Publication remains blocked without hosted observations. See the
[admission and provenance procedure](release-provenance.md).

Monitor bounded aggregate 5xx/429/join counters, alert outbox/journal delivery,
account/DO quotas, readiness outside a pause, and relay state. Readiness validates
configuration; it does not prove database integrity, warm credentials, live TURN
reachability or file delivery. Account analytics may be delayed/sampled. Health
does not establish any of these properties.

## When deployment fails

Stop further release changes. Determine the actual Worker/Pages pair before
choosing recovery. Preserve a sanitized incident timeline and private restore
record; never put capabilities, session IDs, credentials or raw provider bodies
in public evidence.

**Rollback is permitted only after separate authorization** when both archives
pass the offline gate, the target is an independently accepted release of the
same environment, live bindings/lifecycle/secrets still match, and both mixed
component states are known compatible. Re-read active IDs before each authorized
component change and verify the resulting pair. If another operator's third
version appears, halt; do not overwrite it. Pages/Worker recovery is not atomic.

**Rollback is prohibited** for P8/v1-only code in the current v2 architecture,
missing records, unknown schema/KV formats, lifecycle changes, namespace changes,
incompatible clients, changed security behavior, missing resources, uncertain
secret versions or an unreviewed provider force requirement.

**Prefer roll-forward** when no accepted compatible target is established, a
forward-only change has occurred, or reverting could remove a security control.
Keep current namespace/class identities and persisted formats, repair the defect
on the latest compatible code, reproduce with isolated data, run the full gates,
and seek separate authorization for the new release. Do not patch live SQL,
restore a guessed database snapshot, delete namespaces, or clear browser data.

If neither safe path is proven, retain a confirmed admission pause where safe,
halt publishing, and escalate to the release owner. A broken service might not
be able to apply its own pause; confirm the actual hosted state rather than
claiming the control worked. Do not run remote maintenance scripts speculatively.

## Active sessions and after recovery

Existing room state is persisted; in-memory signaling connections and active
transfers are a separate concern. MeshDrop uses hibernating WebSockets, but code
updates can still reset active objects. Do not promise uninterrupted signaling;
the official [WebSocket update behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocket-disconnection-during-code-updates)
depends on object lifecycle/update strategy. P2P traffic may continue, while
reconnection can require renewed admission/comparison. A room TTL does not extend
during rollback. Do not revoke owners' rooms merely to create a clean release.

Allow legitimate rooms to complete or expire using their configured TTL and an
operator-reviewed maintenance budget. A creation pause provides no exact active
session count. Existing relay allocations/temporary credentials can outlive the
pause until provider expiry or quota stop; rotation is not a generic drain tool.

Before reopening admission, separately validate the actual restored/fixed pair:

1. Confirm provider IDs, scope, artifact digests, bindings and lifecycle metadata.
2. With authorized synthetic data only, verify persisted approval, owner/receiver
   access, invalid-authority denial and owner-only closure. Never inspect live
   user sessions as an acceptance shortcut.
3. Verify relay pool readiness/expiry and usage, monitor counters, cached account
   usage, outbox retries and journal authorization. Local provider fixtures do
   not prove live issuance, allocations, webhook delivery or billing state.
4. Verify a fresh HTTPS/WSS pair, exact file export/hash/receipt, reconnection,
   and frontend/PWA compatibility on the required device/network matrix.
5. Restore admission only with approval, then confirm `/ready`, new creation and
   continued denial behavior. Preserve the new accepted release archive.
6. Record incident cause, partial deployments, recovery decisions and remaining
   uncertainty. Complete a postmortem and add focused regression tests before
   treating the incident as resolved.

## Evidence boundaries

Task 02 proves the local P8 **room-only** round trip. Task 03 additionally proves
the local v2 current → `b103d56` → current round trip for real SQLite rows/KV
blobs, relay/monitor state, authorization and drain. Provider responses in the v2
test are synthetic and all unmatched outbound requests are blocked. It does not
prove hosted migration reversal, allocation continuity, distributed rollout,
production backup restoration, live-device continuity or current provider IDs.

Existing historical preview drill reports remain scoped evidence. The older
Worker-only and Pages-only remote drills use automatic previous-target selection
and do not implement this gate. The v2 product drill checks actor binding
metadata but does not establish the new source/artifact policy. None is an
approved production recovery command or was executed in Task 03. Any hosted
validation or use of a remote-mutating tool requires separate explicit approval.
