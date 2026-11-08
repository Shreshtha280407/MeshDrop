# Task 11 — isolated preview/canary preparation

**PARTIAL — READY FOR HUMAN PREVIEW CONFIGURATION**

The isolated local implementation and defined regression checks pass. Real preview
infrastructure, hosted validation and the separately reviewed test window remain
unavailable/unperformed. This report is not deployment or production authorization.

Starting SHA: `3429f9160dcbbb8cb7e271e06de3a6801f4c13f3` on main, initially clean.
Local HEAD, origin/main and authenticated GitHub main matched. Phase Gates run
42372539807 was successful: core, browser, foundation all SUCCESS.

Task 10D: **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**. Hosted run
42402338554, attempt 2, failed with REHEARSAL_ENVIRONMENT_PROTECTION_UNVERIFIED.
Its remaining jobs were skipped. The human's roadmap waiver acknowledges this
risk; it authenticates no operator, recovery store, witness or production release.
This permits isolated preview preparation, not production authorization.

Task 11 source was subsequently committed as
`cf312f40ed39a53d7fa2c9941ee54684edb15d30` and published to main, followed by three
CI corrections ending at reviewed SHA
`d4a6d2f42151471d9e5e7f5aa81288f7ca2c136d`. Authenticated GitHub metadata verifies
Phase Gates run 42452320328 on that exact source: core, browser and foundation all
completed SUCCESS. The previous local/uncommitted and new-CI-NOT-RUN statements
are historical and no longer describe the published Task 11 source.

## Task 11B readiness audit — stopped before external mutation

Required reviewed GitHub main: `d4a6d2f42151471d9e5e7f5aa81288f7ca2c136d`.
Verified remote main and successful push-triggered CI run 42452320328 match it.
Repository ID 1421237057 and owner ID 225167798 were verified again through the
authenticated GitHub connector.

The local main checkout at the start of this audit was clean at
`cf312f40ed39a53d7fa2c9941ee54684edb15d30`, three commits behind the reviewed
remote source. Read-only comparison confirms only scripts/preview/canary.ts and
tests/integration/preview-package.spec.ts changed in that interval. No branch
switch, merge, reset, source substitution, commit or push was performed here.

Authenticated repository-variable enumeration contains none of the four required
PREVIEW_CANARY_REPOSITORY_ID, PREVIEW_CANARY_OWNER_ID,
PREVIEW_CANARY_TARGET_JSON or PREVIEW_CANARY_DENY_JSON inputs. The dedicated
preview-canary environment GET returned HTTP 404. In particular, the independently
reviewed production deny pins are unavailable. Task 11B's explicit hard-stop rule
therefore prevents provisioning, credential handling, configuration writes and
workflow dispatch. Missing pins are not inferred from resource suffixes, previous
diagnostics or fixture data.

Task 11B verdict: **BLOCKED — REQUIRED PRODUCTION DENY PINS UNAVAILABLE**.
No hosted preview run ID exists for this audit. Preview account/Worker/project/
project ID/origin/namespace/environment IDs remain UNCONFIGURED or UNVERIFIED.
Provider readback and browser checks: NOT RUN. Canary: 0/50 attempts, success
percentage N/A (not 0% or 100%). No verified earlier preview baseline exists:
ROLLBACK_DRILL_NOT_RUN — NO VERIFIED PRIOR PREVIEW BASELINE.

All production mutation/deployment/DNS/secret/migration counters remain 0. GitHub
settings changes, secret changes, external Cloudflare operations, hosted workflow
dispatches, commits, pushes and PRs performed by this audit are all 0.
productionApproved=false; acceptanceEnabled=false;
humanAuthorizationVerified=false; independentWitnessVerified=false.
Task 10D remains SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED. Task 12 is blocked.

To resume, the operator must supply independently reviewed non-secret production
deny pins (accountId, worker, project, projectId, origin, githubEnvironmentId and
all applicable durableObjectNamespaces), plus the separate preview account or
an authorized provisioning path. Do not send tokens or production credentials.
An unavailable identity must be resolved explicitly; no placeholder or production
resource may be created merely to satisfy the contract.

This audit changes only this Markdown report locally. No commit or push is made:
advancing remote main before dispatch would invalidate the exact d4a6d2f... pin.
Keep this report correction local while resolving the blocked prerequisite; its
source publication can be reviewed after the pinned hosted execution.

## Architecture and implementation

See [the inventory and operator runbook](../preview-canary.md). The existing
application, production configuration, release publisher, admission rules,
rollback validator and Task 01 security overrides remain unchanged. The new
contract requires a different account and all applicable resource identities;
the only allowed target is paused, direct-only preview with the current three
SQLite actors. There is no resource-sharing exception or waiver-derived authority.

## Hosted configuration and evidence

Authenticated GET of preview-canary returned 404. Repository variable names
included only the Task 10D rehearsal variables, with no `PREVIEW_CANARY_*` inputs.
No environment, token, account, namespace, project, origin or secret was created
or chosen. All actual preview identities are UNCONFIGURED.

Real preview deployment: NOT RUN.
Provider readback: NOT RUN.
Hosted canary: NOT RUN, 0/50 attempts (not 50/50 PASS).
Browser hosted checks: NOT RUN.
Valid pairing/signaling/transfer and external-device NAT/TURN: NOT RUN.
Rollback drill: ROLLBACK_DRILL_NOT_RUN — NO VERIFIED PREVIEW BASELINE.
Human authorization and independent witness: UNVERIFIED.

Paused admission intentionally returns 503 for /ready and new rooms. Fresh
paired-session tests cannot run in that state; the implementation reports the
coverage gap instead of reopening admission or injecting simulated credentials.
A future 50/50 drain-safe smoke result alone is not full functional release proof.

## Safety

Production mutation count: 0.
Production deployment count: 0.
Production secret change count: 0.
Production DNS change count: 0.
Production migration count: 0.
Admission reopening: 0.
Hosted workflow dispatches: 0.
GitHub settings/secret changes: 0.
productionApproved: false.
acceptanceEnabled: false.
production publication: disabled.
humanAuthorizationVerified: false.
independentWitnessVerified: false.
AI/ML: N/A.

No Task 12 production work follows this task.

## Final source and changed files

The initial implementation baseline was
`3429f9160dcbbb8cb7e271e06de3a6801f4c13f3`. The seventeen implementation files below
were committed as cf312f40...; the current reviewed published source is
`d4a6d2f42151471d9e5e7f5aa81288f7ca2c136d`, with CI verified below. They are no
longer uncommitted additions. This Task 11B audit leaves only this report modified
locally and preserves all source and Git history.

| File                                        | Purpose                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/preview-canary.yml`      | Manual-only source-bound preview workflow, existing-environment inspection, least privilege, step-scoped preview token and exact evidence paths |
| `package.json`                              | Add preview:canary CLI alias; dependencies, audit policy and overrides unchanged                                                                |
| `scripts/preview/contract.ts`               | Exact target/deny pins, different account, namespace/origin isolation, runtime identity and manifest gates                                      |
| `scripts/preview/provider.ts`               | Bounded GET-only discovery plus Task 05 readback, configuration/secret isolation and upload correlation                                         |
| `scripts/preview/package.ts`                | Exact archive/private-copy whitelist, regular files, prepared state and integrity checks; excludes unexpected .env files                        |
| `scripts/preview/cli.ts`                    | Clean-source packaging, dry-run, gated preview-only publication, intent/readback and sanitized evidence                                         |
| `scripts/preview/browser.ts`                | Existing Playwright stack for real shell, paused creation and browser API capability checks, with no traces                                     |
| `scripts/preview/canary.ts`                 | Fifty first-attempt drain-safe probes, existing-limiter cadence, no retries and honest coverage/fixture scope                                   |
| `scripts/preview/rollback.ts`               | Preview-only content eligibility with existing three-actor/protocol/migration/source checks; no mutation                                        |
| `scripts/preview/waiver.ts`                 | Typed roadmap acknowledgement, never imported by production admission                                                                           |
| `docs/decisions/task-10d-waiver.json`       | Explicit SKIPPED decision, failed run and false trust/authorization flags                                                                       |
| `tests/fixtures/preview-canary.ts`          | Offline identities and frozen-manifest fixtures                                                                                                 |
| `tests/unit/preview-canary.spec.ts`         | Target/source/provider/waiver/canary/rollback security cases                                                                                    |
| `tests/unit/preview-workflow.spec.ts`       | Manual trigger, permission, token, action pin, artifact and production escape mutation tests                                                    |
| `tests/integration/preview-package.spec.ts` | Real package + Wrangler dry-run + local workerd/gateway behavior, secret-file exclusion and artifact tampering                                  |
| `docs/preview-canary.md`                    | Architecture inventory, exact operator configuration, execution and recovery limitations                                                        |
| `docs/reports/task-11-preview-canary.md`    | This evidence-based Task 11 report                                                                                                              |

## Executed validation

Node 24.22.2, pnpm 10.34.7. Temporary Node/actionlint binaries were checked against
published official SHA-256 checksums; no global package was installed.

The commands below were executed directly or as their exact constituent stages
of `CI=true pnpm check`; every stage completed successfully.

| Command                              | Result | Cases / evidence                                                                          |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                  | PASS   | All workspaces                                                                            |
| `pnpm typecheck`                     | PASS   | Root TypeScript                                                                           |
| `pnpm lint`                          | PASS   | ESLint and Prettier                                                                       |
| `pnpm check:secrets`                 | PASS   | No matching embedded credentials or tracked secret environment files                      |
| `pnpm test:unit`                     | PASS   | 977                                                                                       |
| `pnpm test:security`                 | PASS   | 42                                                                                        |
| `pnpm test:integration`              | PASS   | 76                                                                                        |
| `pnpm test:faults`                   | PASS   | 18                                                                                        |
| `pnpm test:release-store`            | PASS   | 46 isolated PostgreSQL cases                                                              |
| `pnpm build`                         | PASS   | Production build, Worker dry-run only                                                     |
| `pnpm test:e2e`                      | PASS   | 108                                                                                       |
| `pnpm test:pwa`                      | PASS   | 5                                                                                         |
| `pnpm verify:rollback`               | PASS   | Existing local historical SessionRoom persistence/auth/drain proof                        |
| `pnpm audit:release`                 | PASS   | No known vulnerabilities at unchanged low threshold                                       |
| `CI=true pnpm check`                 | PASS   | 1,272 cases, 568.18 seconds                                                               |
| actionlint 1.7.7, all four workflows | PASS   | Existing ubuntu-26.04 label explicitly recognized; no syntax/expression checks suppressed |

Exact actionlint command:

```sh
/tmp/meshdrop-task11-tools/actionlint/actionlint \
  -config-file /tmp/meshdrop-task11-tools/actionlint/config.yaml \
  .github/workflows/ci.yml .github/workflows/deploy.yml \
  .github/workflows/release-trust-rehearsal.yml .github/workflows/preview-canary.yml
```

All original 1,190 cases are retained, with 82 additions: 69 preview contract,
provider, waiver, canary and rollback unit cases; 12 workflow cases; and one real
package/workerd integration case. All defined production escape cases pass.
No existing assertions, retry policy, timeout, security threshold or source were
weakened. E2E/PWA reported no flaky summary. Task 06's peer/reconnect tests remain
unchanged and pass in the full browser suite.

During focused development, the new malformed-room probe initially expected 404;
the actual existing roomRoute implementation and local packaged Worker correctly
returned 400 for an invalid UUID. The probe was corrected to that exact protocol
response. A new source-order test also initially matched the earlier dry-run
call instead of the publication function; its scope was corrected. Neither fix
changed application behavior or any pre-existing test. An early system Node 26
fixture invocation also encountered a local socket failure; final standalone and
full validation used the same Node 24 line as hosted CI and passed. No production
WebRTC or application defect was inferred from that fixture result.

Validation logs and results are retained in ignored
`.meshdrop-artifacts/task11-validation/`. Browser/raw test logs are not uploaded
as release authorization or added to Git.

## Hosted CI

| Source               | Run ID      | core    | browser | foundation |
| -------------------- | ----------- | ------- | ------- | ---------- |
| Baseline 3429f916... | 42372539807 | SUCCESS | SUCCESS | SUCCESS    |
| Reviewed d4a6d2f...  | 42452320328 | SUCCESS | SUCCESS | SUCCESS    |

Run 42452320328 is completed and successful for the exact reviewed d4a6d2f...
source. It supersedes the original implementation's uncommitted/new-CI-NOT-RUN
status. Green CI does not establish hosted preview isolation, publication,
readback or canary results. No preview workflow is dispatched while required
production deny configuration is missing.

## Operator and hosted limitations

Actual preview account: UNCONFIGURED.
Actual preview Worker identity: UNCONFIGURED.
Actual preview Pages project/ID: UNCONFIGURED.
Actual preview origin: UNCONFIGURED.
Actual preview namespaces/environment ID: UNCONFIGURED.
Preview credential availability/scope: UNVERIFIED; no token was requested/read.
Real provider readback: NOT RUN.
Real canary attempt count: 0; first-attempt successes: 0; failures: NOT RUN.
Real rollback drill: ROLLBACK_DRILL_NOT_RUN — NO VERIFIED PREVIEW BASELINE.

The human selected a future **preview-only test window after separate review**.
No window or automatic admission-opening command was added or executed. Current
publication/probes remain paused. Full join/signaling/WebRTC/file-transfer proof
requires that separately reviewed isolated preview step; fifty paused smoke
passes alone must never be labeled a complete Task 11 functional PASS.

Readback verifies identities/configuration through authenticated API responses
when genuinely run. Manifest annotations/Pages commit metadata correlate the
local frozen upload; they do not independently attest all deployed bytes or
establish human release authority. Full applied migration history, independent
artifact-to-provider correlation, trusted off-run recovery and witnessing remain
unverified. Actions concurrency does not exclude out-of-band publishers or make
Worker/Pages publication atomic. Operator pins and configuration freeze remain
trust assumptions. A failed workflow, including cleanup failure, cannot be
accepted based on a PUBLISHED_NOT_ACCEPTED record alone.

Human actions remaining: supply independently reviewed deny pins and the separate
preview account/provisioning access; synchronize the clean local source to the
exact reviewed d4a6d2f... commit; then resume the authorized preview-only setup and
pinned workflow. The drain-safe Task 11B run does not require reopening admission.
Any later full session/transfer test window still needs separate review. Do not use the Task 10D temporary branch or
PR #1, reopen production admission, or proceed to Task 12.

Commits: 0. Pushes: 0. PRs: 0. Deployments: 0. Cloudflare mutations: 0.
All production mutation, deployment, secret, DNS and migration counters remain 0.
No GitHub environment/protection/secret configuration was changed.

**PARTIAL — READY FOR HUMAN PREVIEW CONFIGURATION**
