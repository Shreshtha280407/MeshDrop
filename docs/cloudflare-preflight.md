# Read-only Cloudflare preflight

Task 05 implements provider readback only. Publication remains blocked by
`hostedProvider()` and `deploy:cloud publish`. The adapter has no upload,
deployment, migration, acceptance, rollback or user-session operation and is not
wired into the deployment workflow. No authenticated account request was made
during this task. Tests use explicit offline fixtures, not hosted evidence.

Task 07's [approval and recovery contracts](release-approval.md) consume fresh
observations without accepting a release. In-process observation provenance is
required for hosted candidates; fixture responses cannot become hosted evidence.
Trusted approval authority and independent recovery storage remain unconfigured.

## Official API contract

Reviewed on 2026-11-05. All implemented paths are relative to
`https://api.cloudflare.com/client/v4`; `{account}` is the exact pinned account.
Every request is GET. Use account-scoped **Workers Scripts Read** and **Pages Read**
permissions, without write permission. Availability of narrower individual-Worker
read roles and actual permission sufficiency require operator verification.

| Capability                   | Official endpoint / permission                                                                                                                                                                                                                                                                        | Authority and limits                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active Worker deployment     | [GET `/accounts/{account}/workers/scripts/{worker}/deployments?page=1&per_page=1`](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/); Workers Scripts Read                                                                         | The documented first deployment serves traffic. Require the pinned deployment ID and exactly one pinned `version_id` at 100% with percentage strategy. Reject split traffic and explicit deferred class updates. Read only page 1; never search history for a match.                                                         |
| Worker version               | [GET `/accounts/{account}/workers/scripts/{worker}/versions/{version}`](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/); Workers Scripts Read                                                                                        | Require returned version `id`. Account/Worker ownership comes from the authenticated exact endpoint; names are not independently echoed. IDs and Worker ETags do not establish local artifact identity.                                                                                                                      |
| DO bindings                  | Same version endpoint; [binding metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#bindings) and [typed binding fields](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/) | Require `resources.bindings` as a list and exact local DO binding names, classes and namespace IDs. Duplicate/external bindings and unsupported shapes fail closed. Namespace contents are never queried.                                                                                                                    |
| DO lifecycle / migrations    | Version endpoint                                                                                                                                                                                                                                                                                      | Check `resources.script_runtime.exports`: exact DO inventory, SQLite storage, created/default-created state. Reject pending transfers. Require pinned `script_runtime.migration_tag`. Latest tag is exposed; complete applied history, schema/data compatibility and irreversible past changes remain UNVERIFIED.            |
| Worker variables / admission | Version endpoint                                                                                                                                                                                                                                                                                      | Require plain-text `ENVIRONMENT`, `ALLOWED_ORIGINS` and explicit `ADMISSION_PAUSED` string (`true` or `false`) from the active version. Missing, duplicate, inherited, secret or malformed admission values fail. This verifies selected deployed configuration, not runtime behavior or every setting.                      |
| Pages project/environment    | [GET `/accounts/{account}/pages/projects/{project}`](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/); Pages Read                                                                                                                                            | Require project name, opaque ID, explicitly pinned pages.dev subdomain and pinned `canonical_deployment`, documented as most recent production deployment. Current `deployment_configs` must bind SIGNALING to the exact Worker's native production service environment. This is not version-specific gateway binding proof. |
| Pages deployment             | [GET `/accounts/{account}/pages/projects/{project}/deployments/{deployment}`](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/); Pages Read                                                                                          | Require ID, project ID/name, native environment, successful deploy stage, not skipped and exact plain-text `env_vars.PUBLIC_ORIGIN`. Commit metadata/build success does not prove artifact bytes or runtime readiness.                                                                                                       |
| Route/custom domain          | Project endpoint plus optional [GET `/accounts/{account}/pages/projects/{project}/domains/{domain}`](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/get/); Pages Read                                                                       | Require canonical production deployment. Custom origins require exact domain and active domain/validation/verification states. Reject other pages.dev aliases. DNS, actual traffic, TLS reachability and zone overrides remain UNVERIFIED.                                                                                   |
| Native Pages previews        | Project/deployment endpoints                                                                                                                                                                                                                                                                          | No equivalent canonical-preview route guarantee is implemented. Explicit native `pagesEnvironment: preview` fails with `ACTIVE_PAGES_ROUTE_UNVERIFIED`; there is no production fallback.                                                                                                                                     |
| HTTP readiness               | No endpoint implemented                                                                                                                                                                                                                                                                               | Successful control-plane/build status is insufficient. No public health/readiness, operator or session request is made. Runtime admission enforcement, authorization, protocol and persisted state need separately authorized hosted validation.                                                                             |

The documented API types include secret-bearing binding/environment shapes.
The adapter cannot promise responses contain no sensitive fields. It holds
bounded JSON in memory and projects only allowed fields; raw responses, unrelated
variables, secret names/values, annotations, build tokens and error messages are
never printed or saved. It never calls a secret-retrieval endpoint. Do not enable
HTTP body/header debug logging around it.

## Scoping and transport security

The strict expectation pins account, application environment, Worker
name/version/deployment, Pages project name/opaque ID/subdomain, deployment/native environment,
origin, latest migration tag and DO binding/class/namespace identities. No
resource is guessed. Name suffixes are additional checks.

Application and provider environments differ. MeshDrop's separate `-preview`
and `-production` projects can each serve a native Pages **production** deployment.
Both environment fields must be explicit; Worker `ENVIRONMENT` matches the
application environment, while Pages readback matches `pagesEnvironment`.

The API host is fixed. URL components have strict validation. GET uses redirect
rejection and no-store headers/cache mode. No provider URL or pagination link is
followed. Each request has a five-second deadline covering headers and body,
including transports that ignore cancellation. Both declared and actual body
size are limited to 512 KiB. Readers/controllers and late responses are cancelled.
There is no retry, login, environment-file fallback or provider write.

Schemas validate decision fields; additional provider fields are discarded.
Authentication, throttling, server, HTTP, schema and transport failures emit fixed
codes without raw messages. HTTP Date must be within 60 seconds, at most five
seconds in the future. The complete observation expires 60 seconds after the
first request. Old deployment creation timestamps are allowed: freshness concerns
the current read. Active Worker/Pages identities are rechecked before return.
These checks are not a provider lock or atomic cross-resource snapshot.

## Operator diagnostic

**Account access requires separate authorization.** Task 05 ran only the real
CLI's missing-credential path and fixture-driven tests.

Obtain resource pins from independently reviewed records and the dashboard.
Never invent IDs or create historical acceptance. The expectation file contains
exactly these fields; these deliberately invalid placeholders are not evidence:

```json
{
  "schemaVersion": 1,
  "accountId": "EXACT_ACCOUNT_ID",
  "environment": "preview",
  "worker": "meshdrop-yourproject-preview-signaling",
  "workerVersion": "EXACT_WORKER_VERSION_UUID",
  "workerDeployment": "EXACT_WORKER_DEPLOYMENT_UUID",
  "project": "meshdrop-yourproject-preview",
  "projectId": "EXACT_PAGES_PROJECT_ID",
  "pagesSubdomain": "meshdrop-yourproject-preview.pages.dev",
  "pagesDeployment": "EXACT_PAGES_DEPLOYMENT_UUID",
  "pagesEnvironment": "production",
  "origin": "https://meshdrop-yourproject-preview.pages.dev",
  "migrationTag": "v2",
  "durableObjects": {
    "SESSION_ROOMS": { "className": "SessionRoom", "namespaceId": "EXACT_NAMESPACE_ID" },
    "RELAY_POOLS": { "className": "RelayPool", "namespaceId": "EXACT_NAMESPACE_ID" },
    "OPERATIONS_MONITOR": { "className": "OperationsMonitor", "namespaceId": "EXACT_NAMESPACE_ID" }
  }
}
```

Supply `MESHDROP_CLOUDFLARE_READ_TOKEN` using the operator's approved credential
mechanism. Do not put tokens in arguments, scope JSON, documentation or records.
Existing production `.env` and Wrangler login are never read as fallbacks.

```sh
pnpm preflight:cloud --read-only preview /absolute/path/to/reviewed-scope.json
```

The CLI requires explicit environment equality and compares expected classes,
bindings and latest tag against local Wrangler architecture before API access.
Its scope file must be a bounded regular file, not a symlink. It emits sanitized
JSON and never writes a release record. Missing credentials, failed checks,
unknown/incompatible resources and fixture evidence return nonzero, UNVERIFIED.

Exit 0 (`VERIFIED_READBACK`) means only the defined control-plane checks passed
using the real API transport. Explicit `unverified` items still cover artifact
correlation, full configuration, full migration history, deployed gateway
bindings, HTTP/session readiness and acceptance. `releaseAccepted`,
`productionApproved` and `publicationEnabled` always remain false.

## Lifecycle and admission boundary

Read-only `current()` supplies Task 04's `CurrentDeployment` only through the
real API transport. Injecting a transport or clock marks observations
`offline-fixture`, keeps `providerConfirmed: false` and rejects authenticated
`current()`. No `PublicationProvider` implementation or manifest/source/config
confirmation method exists.

`verifyObservedAdmission()` applies Task 04 rules to an in-process observation:
preservation requires equality; pausing requires true; reopening requires
`REOPEN:environment:active-worker-version:prepared-manifest-id`. Expired, modified
or deserialized observations fail. Fixture checks exercise these rules without
becoming authentication. Desired state never fills missing live data. No command
changes admission or reopens rooms.

A provider ID, Pages commit hash, Worker ETag or local artifact hash cannot prove
the manifest-to-upload relationship. Serialized JSON is content evidence only;
it cannot authenticate old records or bypass Task 03's independent provenance
and acceptance gates. PREPARED, PUBLISHED and ACCEPTED remain distinct. Readback
does not accept releases, edit journals, approve targets or enable publishing.

## Task 06 requirements before considering publication

1. Separately authorize and validate real read-only responses, permissions and
   environment routing, without live user sessions.
2. Establish independent Worker/gateway/frontend artifact correlation and a
   trustworthy full configuration/migration review chain.
3. Authenticate previous accepted records and operator approval; define initial
   release policy without fabricated historical acceptance.
4. Validate hosted admission, readiness, authorization and disposable persistence;
   review concurrent changes and reopening controls.
5. Review publication ordering, credential scopes, durable off-runner intent
   records, cancellation/partial-publication reconciliation and recovery.
6. Explicitly review/authorize any mutation adapter and workflow change. Task 05
   does not authorize that implementation or any deployment.

Do not replace missing evidence with guesses, fixtures or automatic approval.
