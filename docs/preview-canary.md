# Isolated preview/canary — operator runbook

Task 10D is **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**. Its failed
run is 42402338554, attempt 2, on 3429f9160dcbbb8cb7e271e06de3a6801f4c13f3;
the failure was REHEARSAL_ENVIRONMENT_PROTECTION_UNVERIFIED. The human declined
the independent reviewer requirement. The machine-readable decision in
`docs/decisions/task-10d-waiver.json` is risk acknowledgement, never authorization.
Production publication, acceptance, admission reopening, and Task 12 remain blocked.

## Architecture and isolation

The existing deployment generator derives a Worker name from a Pages project,
requires an environment suffix, and creates a same-origin Pages `_worker.js`
gateway. The signaling Worker has workers.dev and version preview URLs disabled.
Pages proxies `/v1`, `/health`, `/ready` and `/ops` to the private SIGNALING
service; it rejects aliases whose origin differs from PUBLIC_ORIGIN. The client
assets are built with Vite environment loading disabled. Actual production
identities are operator configuration, not assumed from these naming rules.

| Component         | Existing behavior                                                 | Task 11 requirement                                                                       |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Account           | Supplied privately by deployment environment                      | A different account from the reviewed production deny pin                                 |
| Worker            | `${project}-signaling`                                            | Exact `-preview-signaling` identity, no public Worker route                               |
| Pages             | Separate project per environment, gateway service binding         | Exact `-preview` project, ID and canonical `project.pages.dev` origin; no custom domains  |
| SessionRoom       | SQLite room_meta, invites, peers, ticket_nonces, security_windows | Separate preview namespace                                                                |
| RelayPool         | SQLite-backed KV `pool`, provider keys/usage/alarm state          | Separate namespace, direct-only mode, no TURN credentials                                 |
| OperationsMonitor | SQLite buckets/outbox/journal and account-usage KV                | Separate namespace, no account analytics/provider credentials                             |
| Migrations        | v1 creates SessionRoom; v2 creates RelayPool/OperationsMonitor    | Existing preview v2 namespaces pinned before any write; no lifecycle change               |
| TURN              | direct, coturn, Cloudflare or Metered supported by application    | direct only; relay/NAT coverage remains unverified                                        |
| Admission         | ADMISSION_PAUSED controls new rooms and readiness                 | true before/after publication; no reopening input                                         |
| Journal           | Existing versioned release lifecycle and approval/recovery gates  | Unverified PREPARED packaging record plus preview-only publication intent; never ACCEPTED |

No writable account, namespace, Pages project, public origin or GitHub environment
is intentionally shared with production. The shared STUN address is a public
discovery service; there is no STUN credential or configuration mutation path.
Preview rollout never calls the older bootstrap/provision/revoke/rollback entry
points. It cannot supply a waiver to satisfy their blocked approval contracts.

Cloudflare calls the canonical deployment of a Pages project `production`, and
uses `production` for an unnamed Worker service environment. Here these labels
refer exclusively to a distinct preview project/account/Worker, never MeshDrop's
live production resources. Native branch aliases are deliberately unsupported.

## Human configuration boundary

Do not use the temporary task10d-runner-pin-capture branch or PR #1. Do not use
diagnostic artifacts as authorization or as an independently reviewed trust pin.

Before dispatch, a human must independently review the following configuration.
The workflow never creates environments, accounts, Pages projects, namespaces,
operator secrets, TURN resources or database infrastructure.

1. Create a dedicated GitHub environment `preview-canary`; record its numeric ID.
   Set a selected **branch** policy containing exactly `main`. Freeze environment
   configuration during the run. A reviewer can be required by operator policy,
   but this path does not claim independent human release authentication.
2. Use a genuinely separate, non-production Cloudflare account. Restrict the
   preview API token to that account and only the necessary Workers Scripts and
   Pages operations. Do not grant DNS, zones, TURN or production-account access.
3. Provision a private preview Worker and Direct Upload Pages project through a
   separately reviewed operator action. The project name must end in `-preview`,
   production_branch must be `release`, and the origin must be its canonical
   pages.dev origin. Configure only its own SIGNALING service binding.
4. The Worker must already expose all three current SQLite classes and have
   migration tag v2. Record its three namespace IDs. Configure paused admission,
   direct TURN mode, empty TURN_URLS and a dedicated preview OPS_REVOKE_SECRET.
   No TURN, analytics or production credentials may be present. The publisher
   does not create or rotate secrets; the build's shape-validation placeholder
   is never uploaded as an operator binding or secret.
5. Independently review current production identities as **deny pins only**.
   Never infer them from project suffixes, timestamps, or the Task 10D artifacts.

Create these repository variables:

```text
PREVIEW_CANARY_REPOSITORY_ID
PREVIEW_CANARY_OWNER_ID
PREVIEW_CANARY_TARGET_JSON
PREVIEW_CANARY_DENY_JSON
```

Identity IDs must be independently reviewed; observed MeshDrop IDs were
1421237057 (repository) and 225167798 (owner). Do not treat observation as approval.
The target JSON has exactly this schema; placeholders are deliberately invalid:

```json
{
  "schemaVersion": 1,
  "environment": "preview",
  "accountId": "REVIEWED_SEPARATE_ACCOUNT_ID",
  "worker": "REVIEWED_PREVIEW_WORKER",
  "project": "REVIEWED_PREVIEW_PROJECT",
  "projectId": "REVIEWED_PAGES_PROJECT_ID",
  "origin": "REVIEWED_CANONICAL_HTTPS_ORIGIN",
  "githubEnvironmentId": "REVIEWED_ENVIRONMENT_ID",
  "migrationTag": "v2",
  "admissionPaused": true,
  "turnProvider": "direct",
  "durableObjects": {
    "SESSION_ROOMS": { "className": "SessionRoom", "namespaceId": "REVIEWED_PREVIEW_NAMESPACE" },
    "RELAY_POOLS": { "className": "RelayPool", "namespaceId": "REVIEWED_PREVIEW_NAMESPACE" },
    "OPERATIONS_MONITOR": {
      "className": "OperationsMonitor",
      "namespaceId": "REVIEWED_PREVIEW_NAMESPACE"
    }
  }
}
```

The deny JSON has exactly: accountId, worker, project, projectId, origin,
githubEnvironmentId, durableObjectNamespaces (an array of all applicable live
namespace IDs). Equality with any configured preview resource is rejected before
a provider request. Missing deny pins also fail closed. These comparisons assume
honest independently reviewed configuration; a deliberately mislabeled account
does not become safe through a JSON field.

Add **only** `PREVIEW_CANARY_API_TOKEN` to the `preview-canary` environment. Never
paste it in chat, commit it, put it in repository variables or reuse production
credentials. It is exposed only to the publish step. The child process receives
only this explicit token/account plus minimal fixed runtime variables; it never
falls back to OAuth, a project .env file or a custom API host.

## Source review and dispatch

Task 11 starts at 3429f9160dcbbb8cb7e271e06de3a6801f4c13f3. That baseline does
not contain this new workflow. After separate human review, commit/push the Task
11 changes and wait for Phase Gates on the **new exact source commit**. Dispatch
only this workflow on reviewed main with environment=preview, the new exact
expected_source_sha and expected_ref=refs/heads/main. Never silently substitute
a moving branch tip or dispatch deploy.yml.

The inspector validates repository/owner IDs, workflow SHA, ref, run/attempt and
GitHub-hosted runtime before producing an environment job output. It verifies
the existing environment ID and exact main branch policy, and requires a
successful push-triggered Phase Gates run for the same SHA. Missing target/deny
configuration produces PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED before publication.

The candidate job builds the current app through the existing preparation code,
checks a clean source tree, packages an exact manifest inventory, and performs a
Wrangler dry-run. The manifest binds source/tree/toolchain, assets, gateway,
configuration, migrations, preview account/project/origin and paused admission.
No timestamp, hash, waiver or successful command is a production authorization.

## Publication and recovery boundaries

Immediately before writing, the Task 05 read-only adapter verifies the exact
active preview Worker, v2 class/namespace mapping, SQLite storage, paused
admission, direct-only relay configuration, Pages project/canonical deployment
and service binding. An absent bootstrap deployment or unexpected binding is a
configuration blocker. It never provisions a missing resource opportunistically.

A unique intent is recorded before mutation; it is retained on failure. Frozen
files are copied into a unique private directory outside the checkout. Only the
exact preview Worker and Pages project can be passed to Wrangler; no arbitrary
command, account, route, environment or secret-change flag is accepted. CLI
output/provider error bodies are discarded rather than exported. Credentials
are never written into the package. The private copy is cleaned in finally.

Worker publication precedes Pages publication, with readback between them. A
failure or lost response produces INCOMPLETE and requires reconciliation rather
than a blind rerun. There is no automatic rollback or unlock. Review current
preview identities and retained intent before separately deciding recovery.
This local runner journal and Actions artifacts are not independently durable
recovery storage or a latest-head witness. Task 10D remains skipped.

Post-publication readback must correlate the Worker version's manifest annotation
and Pages commit metadata with the exact local upload intent. Version IDs alone
do not prove source or artifact identity. This correlation is weaker than an
independent artifact attestation: the existing adapter's unavailable guarantees
(including complete applied migration history and independent artifact/provider
byte correlation) remain explicitly unverified. Production acceptance stays off.

## Canary and browser evidence

The existing Playwright stack checks that the real application loads, rejects
room creation while paused, and supports the client WebRTC/File/Crypto APIs.
It captures no trace, video, screenshot, invitation or capability. API support
is not a connected peer, successful pairing or file transfer.

Fifty HTTP smoke attempts check the application shell/CSP, Worker liveness,
paused readiness (`503`, ready=false), paused creation (`503`), invalid-origin
rejection, malformed session rejection and operator authorization. There are no
retries. Attempts are spaced by at least 2.3 seconds to respect the existing
30/minute creation limiter. Every failure and its category is retained; 49/50
is a failure. A fixture cannot become hosted proof by changing a scope label.

Paused admission prevents creating fresh rooms. Thus valid new-session join,
signaling, pairing and transfer proof are **NOT RUN**. The human selected a
preview-only test window **after separate review**. This records permission to
plan that separately reviewed step, not an authorization token or an automatic
reopening capability in this workflow. This path does not reopen
admission to obtain those results, weaken pairing, inject a fake session, or
claim NAT/TURN coverage. Fifty paused smoke passes alone cannot satisfy the full
functional Task 11 PASS verdict. Existing local pairing/transfer/mobile tests
remain necessary regression evidence, not hosted functional proof.

## Preview rollback

The new rollback validator checks preview scope, protocol/configuration/migration
fingerprints and the existing full-source compatibility comparison, including
all three actor exports. Frozen archives must independently pass manifest and
artifact validation. P8 is rejected as a complete current rollback target.
Content compatibility alone never authenticates provider IDs or authorizes a
rollback. The first run reports:

```text
ROLLBACK_DRILL_NOT_RUN — NO VERIFIED PREVIEW BASELINE
```

No mutation drill runs without a genuinely verified prior preview deployment
and its archive. Do not choose a historical deployment by timestamp alone, call
the legacy rollback entry points with arbitrary targets, or restore across a
class-lifecycle change. Any future drill/restore requires exact active identity
checks and separate review; this workflow never automatically rolls back.

## Export and final review

Only the exact public package/manifest/preparation/publication/canary/browser/
rollback/coverage paths are uploaded. The archive contains only manifest-listed
static files and fixed metadata. No .env, credentials, raw provider responses,
browser trace or private runtime directory is included. Actions retention is
30 days and is not durable independent storage.

Report every NOT_RUN and unresolved property. A skipped coverage gate cannot be
converted to PASS. Always retain productionApproved=false, acceptanceEnabled=false,
humanAuthorizationVerified=false and independentWitnessVerified=false. A preview
result cannot unblock Task 12 or satisfy Task 07 production admission.

Official contracts consulted: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/),
[Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/),
[Worker version API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
and [Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/).
