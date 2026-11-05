# Task 05 — Read-only Cloudflare preflight and identity verification

## A. Investigation verdict and API capabilities

The initial checkout was clean on `main` at the expected commit
`2d0a4fa909382ee7542fcbf3b46ff62683d6003d`. Tasks 01–04 were present, including
the blocked publisher, immutable release records, admission acknowledgement,
rollback rejection and minimatch override. A 437-file baseline hash inventory was
captured before implementation; no existing changes needed to be overwritten.

Official Cloudflare documentation was reviewed read-only. The implemented
contract is recorded with endpoint links, fields, permissions and limits in
[the preflight guide](../cloudflare-preflight.md#official-api-contract).

| Capability                     | Documented provider evidence                                                    | Finding                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Worker version                 | Exact scoped version endpoint and returned ID                                   | Implemented, with strict identity checks                                 |
| Active deployment              | First deployment in the documented list and its percentage/version pair         | Implemented; require pinned ID and exactly one version at 100%           |
| Durable Object bindings        | Version binding list with binding/class/namespace metadata                      | Implemented; require complete pinned local binding inventory             |
| Class lifecycle                | Version runtime exports, SQLite storage, created/default-created state          | Implemented; reject missing/extra classes, transfers, non-SQLite storage |
| Migrations                     | Latest `resources.script_runtime.migration_tag`                                 | Implemented; full applied history/data compatibility remains UNVERIFIED  |
| Non-secret variables/admission | Selected active-version plain-text bindings                                     | Implemented; absent/duplicate/inherited/secret/malformed admission fails |
| Pages deployment               | Deployment ID, project ID/name, native environment and deploy stage             | Implemented; no identity from artifact hashes or commit annotations      |
| Pages project/routing          | Exact project, canonical production deployment, selected project service config | Implemented; native Pages preview routing is conservatively rejected     |
| Custom domain                  | Exact domain and active configuration/verification states                       | Implemented; actual DNS/TLS/traffic and zone overrides are UNVERIFIED    |
| Readiness                      | Provider build success is insufficient                                          | UNVERIFIED; no public/session probes performed                           |

Permissions documented for this subset are Workers Scripts Read and Pages Read.
No write permission is required by this implementation. Availability of narrower
roles, actual token scopes and response compatibility have not been tested on an
account. Secret-retrieval and namespace/session-data APIs are not implemented.

## B. Adapter and security boundary

`CloudflareReadOnly` contains only GET operations to the fixed Cloudflare API
origin. Account, Worker and Pages path components are validated and pinned.
Neither provider URLs nor pagination links become request targets. Active
deployment selection uses documented first-item semantics, never a search for a
matching historical version. Only page 1/per_page 1 is read; pagination metadata,
when supplied, must agree.

Each request is bounded to five seconds and 512 KiB, including streaming bodies.
Redirects, unexpected response URLs, malformed JSON, incorrect decision fields,
API failures and missing/ambiguous identities fail closed. Transport and reader
cancellation includes late-returned responses. There are no automatic retries,
OAuth, environment-file fallbacks or hidden deployment methods.

HTTP Date and observation lifetime enforce a 60-second freshness bound, allowing
at most five seconds of clock lead. Active Worker/Pages identities are rechecked
before return. This detects changes during the observation window, without
claiming an atomic provider snapshot or preventing later concurrent changes.

Raw responses may contain sensitive fields according to the API types. They are
bounded and processed in memory only; observations project explicitly allowed
identity/configuration fields. Unused variables, secret names/values, provider
messages, author details and untrusted URLs are discarded. No token or raw body
is logged. Additional unused provider fields are discarded; unexpected values in
decision fields are rejected. Tokens are private class fields and do not
serialize with the adapter.

## C. Admission-state verification

Admission is read from the exact active Worker version's plain-text binding;
missing data never means false. Worker ENVIRONMENT and allowed origin must also
match scope. Desired values and GitHub inputs do not supply live values.

The existing `verifyAdmission` implementation is unchanged. A helper checks
freshness, issuance and tampering before applying preservation/pause/reopening
rules to an observation. Reopening still requires the exact
`REOPEN:environment:active-worker-version:prepared-manifest-id` acknowledgement.
No code changes admission or sends a room request. This proves configuration
readback and local decision rules, not hosted runtime enforcement.

## D. Provider identity and provenance

Readback has its own schema and does not produce a Task 04 `ProviderIdentity`
claim about source, manifest or configuration hashes. Worker ETags, Pages commit
metadata and local artifact hashes are not treated as upload authentication.

The read-only `current()` interface matches Task 04's CurrentDeployment shape
only through the actual default API transport. Injected transport/clock runs
are labeled offline-fixture, never provider-confirmed and cannot satisfy that
authenticated method. Tests never manufacture hosted success.

In-process observations can exercise admission rules; serialized or modified
observations are rejected by that helper. Exported JSON is not an authentication
mechanism or a way to repair historical provenance. PREPARED, PUBLISHED and
ACCEPTED remain distinct. No release record is written/accepted, no previous
release is authenticated and Task 03's unconditional productionApproved false
policy is unchanged. The mutation adapter and publishing path remain blocked.

## E. Changed files

| File                                     | Why                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `scripts/deploy/cloudflare-readonly.ts`  | Typed GET-only adapter, exact pins, bounded transport, API projections and admission bridge      |
| `scripts/deploy/preflight-cloudflare.ts` | Explicit read-only diagnostic, bounded scope input, local architecture checks and sanitized JSON |
| `tests/fixtures/cloudflare-readonly.ts`  | Document-shaped offline responses and exact-route injected transport                             |
| `tests/unit/cloudflare-readonly.spec.ts` | Positive/negative transport, identity, admission, lifecycle and CLI checks                       |
| `package.json`                           | Register `preflight:cloud`; no dependency changes                                                |
| `docs/cloudflare-preflight.md`           | Official API inventory, operator procedure, trust limits and Task 06 requirements                |
| `docs/release-provenance.md`             | Link the separate read-only boundary and clarify documented list semantics                       |
| `docs/production-rollback.md`            | Clarify that readback does not authorize rollback                                                |
| This report                              | Investigation, validation and safety evidence                                                    |

Production application code, configurations, migrations, dependency lock,
minimatch override, workflows and every pre-existing test file are unchanged.
No publication operation was added or enabled.

## F. Validation

The final `CI=true pnpm check` exited 0 in **448.499 seconds (7m28.5s)** on
Node 24.22.2 / pnpm 10.34.7. It exercised **857 unique cases**: the existing 762
plus 95 added cases. The browser result includes one flaky case that succeeded
on its existing configured retry; this is not a clean first-attempt browser run.

| Exact command                                                                                                                                                                   | Result          | Count/evidence                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `pnpm verify:rollback`                                                                                                                                                          | PASS            | Original P8 round trip; four runtimes started/disposed; private test files removed |
| `pnpm -r typecheck`                                                                                                                                                             | PASS            | Ten workspace packages/apps                                                        |
| `pnpm typecheck`                                                                                                                                                                | PASS            | Root scripts/tests                                                                 |
| `pnpm lint`                                                                                                                                                                     | PASS            | ESLint and formatting                                                              |
| `pnpm check:secrets`                                                                                                                                                            | PASS            | Also rechecked after final report updates                                          |
| `pnpm audit:release`                                                                                                                                                            | PASS            | No known vulnerabilities at unchanged low threshold                                |
| `pnpm test:unit`                                                                                                                                                                | PASS            | 611 cases, 26 files; 13.30s                                                        |
| `pnpm test:security`                                                                                                                                                            | PASS            | 42 cases, 5 files; 1.24s                                                           |
| `pnpm test:integration`                                                                                                                                                         | PASS            | 75 cases, 10 files; 17.80s                                                         |
| `pnpm test:faults`                                                                                                                                                              | PASS            | 18 cases, 2 files; 3.07s                                                           |
| `pnpm build`                                                                                                                                                                    | PASS            | Production builds; Worker dry run only                                             |
| `pnpm test:e2e`                                                                                                                                                                 | PASS WITH FLAKE | 105 passed + one passed on configured retry; 5.9 minutes                           |
| `pnpm test:pwa`                                                                                                                                                                 | PASS            | Five cases; 19.9s                                                                  |
| `CI=true pnpm check`                                                                                                                                                            | PASS            | Complete chain exited 0; browser flake disclosed above                             |
| `pnpm exec vitest run --project unit tests/unit/cloudflare-readonly.spec.ts tests/unit/release-provenance.spec.ts tests/unit/rollback-compatibility.spec.ts --reporter verbose` | PASS            | 198 focused cases, including 95 added adapter cases                                |
| Authenticated Cloudflare/readiness/deployment validation                                                                                                                        | NOT RUN         | Prohibited in Task 05; no real provider confirmation claimed                       |

The unchanged mobile browser case at `tests/e2e/peer-connect.spec.ts:89` required
its configured retry in both full runs. The final first attempt expected peer
epoch 3 but observed 4 at line 142; the earlier run timed out during context
cleanup. Both retries passed. Root cause is unresolved. Application/browser test
code, timeouts and retries were not modified, and this reliability issue was not
hidden or folded into the read-only adapter scope.

Task 03 diagnostics also returned expected exit 1:

```sh
pnpm verify:rollback-target 2d0a4fa909382ee7542fcbf3b46ff62683d6003d e108e7a1f59bc37f41ba703240e08f176d47b33c
pnpm verify:rollback-target 2d0a4fa909382ee7542fcbf3b46ff62683d6003d 2d0a4fa909382ee7542fcbf3b46ff62683d6003d
```

P8 is rejected for missing v2 actors/gateway, bindings, migration and source
differences. Identical source is still rejected without release archives. Both
report productionApproved false and provenanceVerified false. Task 04's existing
provenance/admission tests passed without changed assertions.

The focused adapter/provenance/rollback suites passed 198 cases. New cases use
injected transports with network fetch trapped; the real CLI missing-credential
case returns nonzero without reading a private environment file or contacting an
account. All sensitive values in fixtures are synthetic. The tests cover the
25 requested categories, including HTTP authentication/rate/server failures,
malformed/oversized/slow responses, redirects, scope/environment mismatches,
missing IDs/admission, version conflicts, stale/tampered observations,
unauthorized reopening and blocked publication/provenance promotion.

During development a fixture retained a caller-owned scope reference; it now
clones those pins. A cleanup-state annotation caused a TypeScript failure and was
corrected before the final regression run. Sandbox process spawning initially
blocked a CLI test; the authorized local-process rerun passed. The first audit
could not resolve npm within the sandbox; the authorized advisory-only rerun
passed with no known vulnerabilities. None of these failures was suppressed.

Final contract review retained opaque Pages project IDs and explicit provider
subdomain pins instead of assuming either a UUID format or a derived hostname.
Fixture values are omitted from malformed-input test titles. Final focused
verbose output contains no fixture token value; adapter observations/diagnostics
also omit it. No real provider credential was used in testing.

Local evidence is retained under `/tmp/meshdrop-task05-2e4f7zuo/`, including
`acceptance.log`, `acceptance-result.json`, `focused-reviewed.log`,
`audit-authorized.log`, `legacy-rollback.log`, `p8-rejection.log` and
`no-archives-rejection.log`. These are local test evidence, not deployment records.

## G. Remaining hosted verification

NOT RUN: authenticated Cloudflare requests, real token permissions, actual
deployment identities, production/preview routing, hosted admission/readiness,
production sessions, migration/data verification, provider artifact correlation
and acceptance. No fixture result is a verified Cloudflare deployment.

The conservative parser may reject missing optional provider metadata or native
Pages previews; it never substitutes defaults. Latest migration tag and class
metadata are insufficient to prove full history or rollback compatibility.
Project service configuration is not proof of the deployed gateway's bindings.
HTTP Date availability/clock behavior and actual account contracts require a
separately authorized hosted read-only drill.

The observed existing mobile E2E flake remains a separate reliability concern;
the passing retry does not establish that the case is stable.

Task 06 must establish authenticated artifact-to-provider correlation, full
configuration/migration review, previous-release provenance, operator approval,
disposable hosted acceptance checks, off-runner journal durability and recovery
semantics before a mutation adapter or workflow change can be reviewed. Task 05
does not implement or authorize that phase.

## H. Repository safety

Commits: 0. Pushes: 0. Pull requests: 0. Deployments: 0. Remote modifications: 0.
No authenticated Cloudflare request, live session access, production secret
change, migration, history rewrite or unrelated project edit was performed.
All changes remain local, unstaged and uncommitted. The npm advisory lookup was
separately authorized. Official Cloudflare documentation was read without
account credentials.

HEAD remains `2d0a4fa909382ee7542fcbf3b46ff62683d6003d` on main. Of 437 initial
tracked files, 434 remain byte-for-byte unchanged; only two documentation files
and the package script registration changed. Six new files are listed above.
Nothing is staged. No existing test assertion, production source, workflow,
binding/migration configuration or dependency/security override was changed.

## I. Verdict

**PASS — READY FOR REVIEW** for the read-only foundation and defined local tests.
This does not certify hosted availability, stable browser timing or production
release readiness. Publication remains blocked, and Task 05 stops here for review.
