# Task 13 — cross-platform browser and device reliability

Status: **PARTIAL — APPLICATION HARDENING COMPLETE, EXTERNAL DEVICE EVIDENCE INCOMPLETE**.

## Baseline and scope

Starting branch: `main`, initially clean. Local HEAD, origin/main and authenticated
GitHub main matched `e31f8c3d28cfa40b988ad8bc986df53f8a19943f`. Starting Phase Gates
[`42800281423`](https://github.com/Shreshtha280407/MeshDrop/actions/runs/42800281423)
completed core/browser/foundation SUCCESS on that exact SHA before editing.

Final implementation SHA: `a635662f55d91716d58aaac61a100e43efed8d8b`, commit
`harden cross-platform capability and export reliability`. It was pushed normally
under Task 13's original authorization before the operator's later instruction
to leave all further pushes manual.

Hosted [Phase Gates `43074089192`](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43074089192),
attempt 1, completed **core SUCCESS, browser SUCCESS, foundation SUCCESS** on that
exact implementation SHA. This completion update is local, unstaged and uncommitted
for the operator to review/commit/push manually. No further automatic push occurs.

Task10D = **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**.
Task11B = **SKIPPED — HOSTED PREVIEW VALIDATION NOT ESTABLISHED**.
These product compatibility results do not grant deployment or acceptance authority.

## Historical evidence audit

Reviewed the support matrix, mobile/PWA runbook, both phase-7 cloud evidence files,
native iOS continuation/relay records, browser policy/capability code, file-backed
export adapters, OPFS/IndexedDB storage and Task 12 recovery/epoch/lifecycle code.
The original JSON evidence remains unchanged.

Historical distinctions are preserved: real cloud iPhone 8 MiB stored/final-hash
results existed while some native exports failed observation; later relay results
did not erase those failures. iPad had only a small receive case. Native Windows
Chrome and native macOS Safari had small receive cases with little reverse/recovery
coverage. Same-cloud-host Windows Chromium was not cross-network proof. The
macOS Playwright WebKit OPFS failure remains separate from native Safari success.
Native picker/share/install and personally held physical iOS lifecycle remain
incompletely certified.

## Confirmed defects and fixes

Six focused regressions failed on the original code before implementation. The
read-only reproduction also recorded that IndexedDB readback was never called.

- OPFS could be advertised usable despite close failure. The disposable one-byte
  probe now requires exact write/flush/read, awaited close (including older async
  Safari implementations), and cleanup before declaring availability.
- A committed IndexedDB write did not establish exact persisted readback. A separate
  read transaction must return the original byte and complete; cleanup must succeed.
- A throwing RTCPeerConnection constructor still appeared supported. A disposable
  peer/data channel is now actually constructed and closed, with no STUN request,
  offer or connection made by the probe.
- Required crypto could be missing while receiving was allowed. The bounded probe
  exercises SHA-256 with a fixed known answer and disposable P-256 signing/verification,
  plus required randomness APIs. No identity or test key is retained.
- File-share symbol presence could be mistaken for usable sharing. `canShare` must
  accept a real one-byte File; no permission prompt/share sheet is opened by probing.
- A rejected download click leaked its temporary anchor/object URL. Failure cleanup
  now releases both, while a successful download retains its URL until owner cleanup.

Worker startup/error/message-schema/timeout failures now settle explicitly. Optional
quota, persistence and permission APIs cannot hang capability detection; unknown
space remains distinct from zero space. Sender and receiver requirements differ.
The UI blocks unsupported new admission with actionable reasons. Native picker and
save-picker presence are explicitly API-level observations, not certification of an
OS dialog. PWA registration/installation remains a separate existing runtime flow.

Transfer verification stays separate from export. Each save/share/download outcome
identifies its route and has `nativeExportVerified=false`: a returned action alone
cannot independently hash a destination. Cross-realm AbortError is treated as
cancellation. A completed picker stream is described accurately without claiming
independent saved-byte verification. The external test runner sets its own export
verification only after retrieving and SHA-256 hashing the actual exported file.

No transfer framing, authorization, signed pairing, epoch ownership, hash/receipt
invariants, retained-data schema, release authority or production configuration was
changed. Task 12 tests and earlier assertions were retained.

## Real free cloud-device evidence

[Sanitized case evidence](evidence/task-13-device-cloud.json) contains all 12 attempts,
including failed/incomplete cases, actual browser user agents and independently
checked exported hashes. This is actual Free BrowserStack hardware/native-browser
execution, not mocked device output. Isolated client 1.63.0 was retained; application
Playwright dependencies were not changed. Free was checked before every session.
Optional provider video, visual debug and network capture were disabled.

Only the built static asset inventory was exposed through a temporary anonymous
HTTPS tunnel to disposable local Miniflare/workerd state. The real same-origin
Pages gateway/security policy ran. No Vite filesystem/workspace server, production
endpoint, production TURN configuration or production session was exposed. The
anonymous tunnel used no Cloudflare account/domain and was stopped after the tests.
Cloudflared 2026.10.7 was downloaded to temporary storage and checked against the
publisher's SHA-256 `1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872`.

Both peers compared their isolated source/build identity. The device build is an
uncommitted application snapshot on the starting SHA; its diff/build digests are
recorded, not represented as authenticated release provenance. Subsequent app
cleanup only removed redundant quota/persistence local aliases for lint. Final
local/hosted regressions target the committed implementation. Fixture bytes are
all 91, with unique synthetic names; no personal files or invitations are retained.

| Case                                           |           Bytes | Transfer/final hash   | Recovery                       | Actual exported bytes        | Overall                    |
| ---------------------------------------------- | --------------: | --------------------- | ------------------------------ | ---------------------------- | -------------------------- |
| Laptop → iPhone                                |       8,388,608 | PASS                  | N/A                            | NATIVE_EXPORT_NOT_OBSERVABLE | INCOMPLETE                 |
| Laptop → iPhone, reload                        |       8,388,608 | PASS                  | PASS; 1 MiB reused, 7 MiB sent | NATIVE_EXPORT_NOT_OBSERVABLE | INCOMPLETE                 |
| iPhone → laptop, synthetic source              |       2,097,152 | PASS                  | N/A                            | PASS; laptop download        | PASS                       |
| iPad → laptop, synthetic source                |       2,097,152 | PASS                  | N/A                            | PASS; laptop download        | PASS                       |
| Laptop → iPad, reload                          |       2,097,152 | PASS                  | PASS; 1 MiB reused, 1 MiB sent | PASS                         | PASS                       |
| Laptop → Windows native Chrome                 |       2,097,152 | PASS                  | N/A                            | PASS                         | PASS                       |
| Laptop → Windows native Chrome, reload         |       2,097,152 | PASS                  | PASS; 1 MiB reused, 1 MiB sent | PASS                         | PASS                       |
| Windows native Chrome → laptop                 | NOT TRANSFERRED | NOT RUN; ICE checking | N/A                            | NOT RUN                      | FAILED ATTEMPT             |
| Windows native Chrome sender-engine control    |       2,097,152 | PASS                  | N/A                            | PASS                         | PASS, SAME CLOUD HOST ONLY |
| Laptop → native macOS Safari                   |       2,097,152 | PASS                  | N/A                            | PASS                         | PASS                       |
| Laptop → native macOS Safari, reload           |       2,097,152 | PASS                  | PASS; 1 MiB reused, 1 MiB sent | PASS                         | PASS                       |
| Native macOS Safari → laptop, synthetic source |       2,097,152 | PASS                  | N/A                            | PASS; laptop download        | PASS                       |

All completed 8 MiB transfers independently matched the source SHA-256:
`d6da60c0eddd93a5c447f65a7e12dc629ec32618609c9c39674722f7ece241db`.
All completed 2 MiB transfers and retrieved exports matched:
`385d6c03c1399b00d72591350a05a248449226c92e572152ed8008a24cbd2a72`.
The 8 MiB iPhone saved bytes were not independently retrievable; their exported
hash is deliberately absent. Clicking Save and an OPFS hash do not satisfy that gate.

Actual targets: iPhone 15 Pro Max Safari 26.6–26.6.1; iPad Pro 13 2025 Safari 26.6.1;
Windows 11 native Chrome 157.0.0.0; native macOS Tahoe Safari 26.4 via W3C WebDriver.
The requested iOS capability is 26 while the Safari iPhone UA contains OS 18_7;
both are retained without inventing an independently confirmed OS version.
All reverse File sources were injected synthetically; none certifies a native picker.

Recovery used a real committed checkpoint, revoke/reload of both browsers, checkpoint
rehash, new room/admission, renewed signed comparison, exact original-source
reselection and explicit resume. Sender reused/attempt totals verified missing-only
payload; both final committed counts and receiver hash were exact. New room-scoped
connections are fresh contexts; a numeric epoch from one room is not compared as a
monotonic counter with another room. Existing Task 12 tests independently retain
stale-epoch rejection, changed-source rejection, duplicate/corruption/storage and
cancellation invariants. No platform workaround relaxes any of them.

The Windows reverse attempt left both peers at ICE checking with signaling connected;
its precise network/provider cause is unestablished. It remains a failed attempt,
not an application success or proof of a specific provider defect. As permitted by
the task, a separate sender-engine control uses two contexts on one cloud Chrome
host. Cross-network Windows receive/recovery passed independently; same-host sender
success does not establish cross-network reverse connectivity.

## Validation

Baseline: **1,342 tests**. Additions: **58** (34 unit, 14 security, ten browser
executions from five cases in both desktop/mobile-emulated Chromium). Final
local total: **1,400**, with all old cases retained. External device cases are
reported separately and are not counted as unit/CI tests.

Hosted logs independently confirm the same **1,400 cases**: 1,023 unit, 71 security,
76 integration, 51 faults, 46 PostgreSQL, 128 E2E and five PWA. All ten Task 13
platform browser executions and all ten retained Task 12 browser regressions pass.
Hosted E2E took 6.0 minutes and PWA 17.8 seconds, with no retry/flaky summary.
The hosted audit also reported no known vulnerabilities. Local success was not
used as a substitute for these completed hosted results.

| Exact command                                     | Result                     | Evidence                                                                             |
| ------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm -r typecheck`                               | PASS                       | All workspaces                                                                       |
| `pnpm typecheck`                                  | PASS                       | Root TypeScript                                                                      |
| `pnpm lint`                                       | PASS                       | ESLint and Prettier; final local report checked separately                           |
| `pnpm check:secrets`                              | PASS                       | Environment files ignored; scanner passes; actual automation credential matches zero |
| `pnpm audit:release`                              | PASS                       | No known vulnerabilities; original low threshold unchanged                           |
| `pnpm test:unit`                                  | PASS                       | 1,023; including 34 new capability/export cases                                      |
| `pnpm test:security`                              | PASS                       | 71; includes all 14 new scope/identity guards                                        |
| `pnpm test:integration`                           | PASS                       | 76                                                                                   |
| `pnpm test:faults`                                | PASS                       | 51; Task 12 large-file/network cases retained                                        |
| `pnpm test:release-store`                         | PASS                       | 46; isolated local PostgreSQL fixtures                                               |
| `pnpm build`                                      | PASS                       | Production assets and local Worker dry-run; no deployment                            |
| `pnpm test:e2e`                                   | PASS                       | 128; 7.1 minutes, no first-attempt failure/retry/flaky summary                       |
| `pnpm test:pwa`                                   | PASS                       | Five; 21.8 seconds, zero retries                                                     |
| `pnpm verify:rollback`                            | PASS                       | Four local runtimes started/disposed; all rollback/drain stages                      |
| `CI=true pnpm check`                              | PASS                       | 1,400 cases; all 1,342 old cases retained and 58 additions                           |
| `node scripts/local-dev/verify-platforms.mjs ...` | NONZERO, HONEST INCOMPLETE | Explicit recovery/reverse/matrix cases; all attempts preserved                       |
| Hosted Phase Gates `43074089192`                  | PASS                       | core/browser/foundation SUCCESS; exact implementation SHA, attempt 1                 |

The first six new unit regressions all failed against the original implementation
before the correction and passed afterward. All ten focused platform browser
executions passed with zero retries. The controlled stale-probe fixture initially
assumed a single React effect mount; StrictMode reproduced that fixture error in
both profiles. It now explicitly holds/releases worker replies and denies the
operator-triggered recheck, without relying on mount counts or timer delays.
The final full run passed all 128 browser and five PWA cases without a retry/flaky summary. The new browser
tests retain verified completion across a deliberately
failed export, reload/recheck saved storage and independently hash the later download;
the app still does not claim that independent external observation itself.

Initial local setup attempts hit sandbox bind/DNS restrictions and were repeated
with approved local execution/network access. An initial root typecheck identified
a possibly-undefined IDB promise result, corrected with an explicit generic. Lint
caught unused local initializers and formatting; they were corrected. These were
not hidden test passes. No retry/timeout policy, security check or assertion was
relaxed. Raw development logs remain ignored and are not uploaded. All four unchanged workflows also pass Actionlint with the existing tool configuration for the already-declared ubuntu-26.04 label; the older binary alone does not know that label.

## Changed files

- `packages/platform/src/CapabilityProbe.ts`: bounded active capability checks and explicit worker/crypto states.
- `packages/platform/src/CryptoProbe.ts`: real required crypto known-answer/signature probe.
- `packages/platform/src/StorageProbe.ts`: disposable exact committed storage round trips.
- `packages/platform/src/capability.worker.ts`: shared worker probe entry.
- `packages/platform/src/PlatformPolicy.ts`: role-specific supported/unsupported gate.
- `apps/web/src/RoomApp.tsx`: actionable capability status and safe admission buttons.
- `apps/web/src/features/mobile/MobilePanel.tsx`: measured capability/recovery and API-presence wording.
- `apps/web/src/features/mobile/FileExportControls.tsx`: explicit export outcome/route and unverified native-export status.
- `packages/storage/src/IosExportAdapter.ts`: honest outcome schema and cross-realm cancellation.
- `packages/storage/src/AndroidSaveAdapter.ts`: destination completion/export distinction.
- `packages/storage/src/SaveAdapters.ts`: failed-download resource cleanup.
- `scripts/local-dev/device-test-identity.mjs`: complete exact isolated build pins; no authentication claim.
- `scripts/local-dev/verify-ios.mjs`: additional real-profile reverse cases and current-build/count/export evidence.
- `scripts/local-dev/verify-platforms.mjs`: explicit Free isolated-device matrix and scoped Windows sender control.
- `package.json`: opt-in `verify:platform-cloud` command; no dependency change.
- `tests/unit/platform-policy.spec.ts`: required fixture fields only; existing assertions unchanged.
- `tests/unit/platform-capabilities.spec.ts`: 26 active capability and failure cases.
- `tests/unit/platform-export.spec.ts`: eight honest export/cleanup cases.
- `tests/security/platform-cloud-scope.spec.ts`: 14 scope and build-substitution guards.
- `tests/e2e/platform-support.spec.ts`: five browser cases, run in two projects; includes controlled stale-probe delivery.
- `docs/support-matrix.md`: dated new evidence and preserved historical limits.
- `docs/runbooks/mobile-pwa.md`: isolated cloud commands and truthful evidence boundaries.
- `docs/reports/evidence/task-13-device-cloud.json`: reviewed sanitized actual attempts, including failures.
- `docs/reports/task-13-cross-platform-reliability.md`: this investigation and validation record.

## Contract references

The provider's [real iOS setup](https://www.browserstack.com/docs/automate/playwright/playwright-ios/nodejs)
and [supported browser/client matrix](https://www.browserstack.com/docs/automate/playwright/browsers-and-os)
define the distinct real-device/engine profiles. The existing
[Free-plan endpoint](https://www.browserstack.com/docs/automate/api-reference/selenium/plan)
and [download retrieval contract](https://www.browserstack.com/docs/automate/selenium/test-file-download)
were checked; documented retrieval support does not prove a particular file was returned.
[OPFS access-handle semantics](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle)
require secure dedicated-worker I/O and permit older asynchronous finalization.
The [Quick Tunnel contract](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
describes temporary testing URLs with no account/domain and no uptime guarantee;
that test transport is not a hosted application deployment or trust authority.

## Limitations and safety

The iPhone 8 MiB native export gate is still incomplete under the available Free
provider retrieval path. No upgrade, billing activation or payment method was used.
True Windows cross-network reverse connectivity remains unverified; its sender
engine and real receive/recovery are separately scoped. No NAT/TURN universality,
maximum device size, native picker/share/install, physical iOS lock/background,
Android-tablet support or universal browser storage durability is claimed.
Playwright WebKit evidence never substitutes for native Safari.

Production deployments = **0**. Production mutations = **0**. DNS, production
secrets, admission, TURN configuration, migrations and live-session mutations = **0**.
Paid services activated = **0**. `productionApproved=false`, acceptance remains
blocked, human authorization and independent witness remain unverified. No deploy,
preview/canary or trust-rehearsal workflow was dispatched. Only normal Phase Gates
ran from the explicitly authorized normal push. Task 14 has not begun.

## Git handoff

Implementation commits created: **1**. Normal pushes performed: **1**, before the
operator's final manual-push instruction. Commits/pushes after that instruction:
**0**. PRs, force pushes, GitHub settings changes and secret changes: **0**.
The only subsequent repository modification is this Markdown completion report;
the application/tests/evidence remain the CI-verified implementation above.

Review and publish this report manually:

```sh
git diff -- docs/reports/task-13-cross-platform-reliability.md
git add -- docs/reports/task-13-cross-platform-reliability.md
git commit -m "record Task 13 cross-platform validation"
git push origin main
```
