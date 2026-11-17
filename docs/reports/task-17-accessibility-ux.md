# Task 17 — Accessibility, UX and product polish

Current acceptance is recorded in the **dated addendum at the end** and [current status](../CURRENT_STATUS.md). Original investigation and pre-push statements below remain point-in-time history.

Review dates: 15–17 November 2026. This is an internal application review using automated WCAG-oriented checks, keyboard tests and local browser engines. It is not WCAG certification, a formal accessibility audit, native Safari certification, or NVDA/VoiceOver certification.

## Verdict and baseline

Local validation: **PASS — `CI=true pnpm check` exited 0 with 1,816 passing tests**. Its 282 retained browser/storage, 80 accessibility and eight PWA executions all passed on their first attempts, with zero retries used. Final Task 17 acceptance still requires new hosted Phase Gates after the operator's manual commit/push. No repository commit, push or new hosted run is claimed.

- Starting/local HEAD: `a9b3a903e3a1ccde56dfd326311f392ad80e6f92`, branch `main`, clean at the start.
- `origin/main` and authenticated GitHub `main` independently matched that SHA.
- Starting Phase Gates: [43625992715](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43625992715), exact SHA; `core SUCCESS` (132541804915), `browser SUCCESS` (132541805287), `foundation SUCCESS` (132544746264).
- Final Task 17 SHA: **not created**; changes remain local for the operator's manual review/push.
- Existing cases: **1,735 retained**. New cases: **81** (20 definitions × four accessibility projects, plus one built-shell PWA case). Final total: **1,816 passing**. Repeated diagnostics are not additional test cases.

Historical statuses remain: Task10D **SKIPPED**, Task11B **SKIPPED**, Task13 **PARTIAL**, Task14 **PASS**, Task15 **PASS**, Task16 **PARTIAL**. No history is rewritten and no release authorization is established.

## Audit inventory

The review covered `RoomApp`, the Foundation workbench, pairing, live/saved transfers, file exports, device capabilities, QR/camera, network diagnostics, install/update UI, shared styles, existing browser/PWA tests and the public-error boundary.

| Area                                           | Names, keyboard and focus                                                                                            | State, errors, disabled controls and touch                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header/main/footer/workbench                   | Native landmarks, one h1, named sections, visible skip link, brand name includes visible version                     | Keyboard-visible focus; wrapping header and controls at narrow widths; Foundation remains explicitly synthetic                                                         |
| Create/join/invitation                         | Labelled password-style invite fields, native forms/buttons, private copy/QR controls                                | Join errors associated with the field; invalid state clears on editing; copy success/failure announced without invitation content; core busy/admission guards retained |
| Approval/rejection/revocation                  | Native named buttons, explicit owner decision, focus returns to the room heading when its focused control disappears | Pending/rejected/closed/signaling states announced; no automatic approval or extra peer admission                                                                      |
| Pairing                                        | Labelled independently entered code and acknowledgement; Enter/Space semantics                                       | Matching-code explanation distinguishes connection comparison from human identity; both confirmations remain required; new epochs remain independent                   |
| File selection/offer                           | Native multiple-file input, named selected-file list, receiver consent                                               | Selection display capped at the protocol's existing 16-file limit; over-limit offer disabled with explanation; no MIME-based security assumption                       |
| Active/paused/recovery/verification/completion | Named native progressbar, readable committed/total byte values, distinct state announcements                         | Byte ticks do not update live announcement text; cancel remains available during preparation/recovery; no progress/hash/receipt semantics changed                      |
| Retry/cancel/clear/receipt/export              | Native explicit actions, per-action in-flight guards, scoped delete/export help                                      | Storage retry preserves confirmed blocks; receipt/download request feedback does not claim native export verification; exported files remain outside browser cleanup   |
| Saved checkpoints/sources                      | Named checkpoint articles, existing labelled source inputs, section focus restoration after deletion                 | Verified/missing bytes, expiry and source requirements explained; existing busy/expired/deleted-data controls and rehash rules retained                                |
| Connection diagnostics                         | Plain last-measured connection explanation above advanced details; keyboard-scrollable timeline and event list       | Existing measurements/privacy schemas retained; export feedback sanitized; technical details can be collapsed without leaving hidden tab stops                         |
| QR/camera/device checks                        | Optional camera, generic QR/video accessible descriptions, paste fallback, explicit Stop focus restoration           | QR grants no approval; stop-on-hide preserved, start/active/stop/failure messages added; recheck remains available to replace a stalled capability probe               |
| Install/offline/update                         | Keyboard-install UI and descriptive update button, focus returns when install control disappears                     | Open-room update prohibition preserved; offline shell does not promise background transfer, retention or renewed authority                                             |

Native semantics are used rather than duplicate ARIA roles. Positive/destructive choices remain explicit. No blanket confirmation-dialog system, theme architecture, new network behavior or accessibility authorization bypass was introduced.

## Confirmed defects and fixes

| Finding                                                   | Evidence before correction                                                                                                                                                              | Correction                                                                                                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low-contrast application text                             | Baseline axe landing scan reported serious `color-contrast` findings on 17 light-theme nodes and 27 dark-theme nodes; these are repeated theme observations, not 44 distinct components | Theme-aware muted/control/focus tokens; correct dark definition-list inheritance; readable secondary text, borders and focus outlines                      |
| Brand visible/accessibility name mismatch                 | Serious `label-content-name-mismatch` in both themes: visible version text omitted from the accessible name                                                                             | Preserve a readable visible space and include the actual version in the accessible name                                                                    |
| Lost keyboard context after room creation                 | Keyboard Enter removed Create invitation and left focus on BODY                                                                                                                         | Restore focus to the affected section heading only when its previously focused control disappears or loses focus while disabled; preserve focus elsewhere  |
| Completed-transfer event history inaccessible by keyboard | Real keyboard transfer's completed-state axe scan reported serious `scrollable-region-focusable`                                                                                        | Give the existing bounded event list a native keyboard focus stop and clear name                                                                           |
| Form/help/status gaps                                     | Invitation errors lacked association/invalid semantics; state pills and copy results did not reliably provide status context; recovery live region included changing byte counters      | Associated help/errors, persistent atomic state announcements, scoped feedback and recovery counters outside live text                                     |
| Inconsistent keyboard focus/preference coverage           | Existing focus styles omitted selects/summaries and had low-contrast green outlines; no reduced-motion or forced-color adaptation                                                       | Shared focus treatment, reduced-motion media rule and system-color borders/focus without disabling state feedback                                          |
| Product guidance and async-action ambiguity               | Implementation-phase messaging, unclear deletion/export scope, unbounded selected-file presentation and repeated pending control actions                                                | Short workflow guidance, exact local/external-copy scope, protocol-bounded selection list, per-action pending guards and fixed public export/action errors |

These are accessibility/UX findings, not a third-party penetration-test result. Transfer, storage, authorization, pairing and release-safety implementations remain unchanged.

## Evidence and browser matrix

`pnpm test:a11y` runs with **zero retries**. It uses pinned `axe-core 4.14.0` (MPL-2.0), kept in development dependencies. The application's exact existing React/type and Vite versions are exposed to the typed component fixtures, without upgrading application runtime dependencies. No axe code is imported by application entry points.

| Project                  | Evidence scope                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium desktop         | Real keyboard sender/receiver, local WebRTC, 4 MiB exact download/receipt hash, saved-file deletion, fixture states, themes, media preferences and reflow                                                           |
| Firefox desktop          | Same real keyboard flow; native Shift+Tab backtracking is used when a target precedes current focus; no mouse or locator.focus shortcut                                                                             |
| WebKit engine            | Real keyboard receive using a disposable persistent profile and Chromium sender, matching the existing cross-engine test boundary; keyboard rejection/camera fallback also use isolated persistent receive profiles |
| Mobile-emulated Chromium | Same logical keyboard/transfer and accessibility cases under the Pixel 7 viewport/touch profile; not physical Android evidence                                                                                      |
| Built local PWA          | Real built shell/service worker, keyboard apply-update restriction while a room is open, and axe checks; no provider publication                                                                                    |

Ten controlled component states cover pairing, offer, active, paused, verification, completed, storage-full, error, recovery and cancelled UI. They render actual production components with synthetic display props, not authenticated approval/storage/transfer evidence. Separate real flows cover create, copy, QR, pending approval, rejection, independent comparison, decline, accept, pause/resume, verified download/receipt, saved rehash/export preparation and deletion. Synthetic file selection and camera/install responses do not certify native OS pickers, camera permission dialogs or install prompts.

The real transfer fixture holds one actual receiver BLOCK_ACK signature until the user activates Pause via the keyboard, then releases it and verifies final downloaded bytes and receipt SHA-256. It does not fabricate a committed block or modify the protocol. This makes pause testing independent of transfer speed without increasing timeouts/retries.

Responsive checks cover 320, 360, 390, 430, 768, 1024 and 1440 CSS-pixel widths, long names/hashes, at least 44-pixel core button heights, 200% root text sizing and 200% CSS zoom/reflow. The actual room also creates/revokes under 200% CSS zoom. These are browser-layout tests, not native browser-toolbar zoom or assistive-technology certification. Intentional internal timeline scrolling remains keyboard accessible.

Focus-color contrast is mechanically checked at at least 3:1 against the panel in both themes. Automated scans reject all reported violation severities, not just critical/serious. No rule is disabled and no region is excluded. Axe may report incomplete SVG/text contrast calculations; those require the explicit review recorded below and are not counted as automated passes.

The final complete check contained **99 axe scans** (96 accessibility and three built-PWA scans), each with zero reported critical, serious, moderate and minor violations. Its only incomplete rule ID was `color-contrast`. A separate synthetic-fixture diagnostic identified four timeline SVG tick labels: three had the engine's `imgNode` background limitation, and the single-character zero tick had `shortTextContent`. The computed text fill against the explicit chart surface was independently checked for all four labels in both themes: minimum **5.6923:1 light**, **11.8926:1 dark**. This is an explicit color-pair review, not a suppressed rule or a claim that axe measured those pixels. No axe rule or region was suppressed.

## Diagnostic corrections and limitations

Initial regression failures were retained in local logs before their fixes. The first standalone fixture attempt lacked Vite's React preamble; the documented test bootstrap fixed loading. An initial hidden-details assertion incorrectly counted the still-visible summary as hidden; it now excludes only the visible summary and still rejects hidden descendants.

The first full check stopped at two test-tooling lint issues (a triple-slash Vite type reference and an inline import type). Both were corrected using the project's exact existing Vite types as an explicit development dependency and the normal imported axe type. No lint rule, test assertion, browser retry or timeout was relaxed.

The next check in the uncommitted working tree passed types, lint, secrets, 1,075 unit and 105 security cases, then correctly rejected one of 154 integration cases: `release-preparation.spec.ts` compares the prepared lockfile fingerprint with the exact committed source. Task 17's new test dependency changes that lockfile while HEAD deliberately remains unchanged. This is not a passing full run, and the release gate was not modified. Complete reruns use a byte-matched disposable public-source snapshot; the initial fixture SHA was `1c8bae76e180b5559ece5a71e26d8e9f849ca7ea`, and the final fixture after the PWA test correction is `6c3f5f960fe2bdd2bcc3c00b95a3e0391964cc35`. Commit-bound checks therefore inspect the actual source under test. These are test infrastructure, not repository commits, hosted provenance, release authorization or final Task 17 SHAs. Fixture pushing is disabled; no private environment file was copied. Only this report may subsequently differ as final results are recorded.

The snapshot's first dependency setup linked back to the working checkout, producing duplicate module identities: relative imports used the snapshot while workspace imports and Vitest mocks resolved into the original tree. Ten recovery/quota cases consequently failed, and a concurrent build also coincided with the retained 5-second diagnostics-history deadline. No assertion or deadline was changed. The snapshot now has its own copied dependency tree with workspace links resolving within it; all 34 focused recovery, transfer-machine and diagnostics cases passed before restarting the full run. These failed setup attempts are not passing application evidence.

That corrected full attempt passed all retained cases and 80/80 accessibility cases (282 retained browser/storage passes in 10.5 minutes, zero retries; accessibility in 2.1 minutes), then exposed a synchronization error in the new PWA test. After Apply update, its expected cached-status text could match the old document before the real reload; axe injection then failed with `Execution context was destroyed`. The test now registers a `domcontentloaded` event wait before activating Apply update and audits only after that reload. Application update behavior, timeouts and retries are unchanged. Five consecutive targeted executions passed with zero retries (36 seconds); these repeats are not five additional test definitions. A final complete run follows the test correction.

The subsequent full attempt passed all non-browser suites but its retained browser suite ended with **one failed, two flaky and 279 first-attempt passes** (11.2 minutes). Desktop `mobile-hardening.spec.ts:277` timed out in the shared pairing setup on both attempts; `:309` observed `peer-state=idle` instead of connected and then passed its existing retry. Desktop `peer-connect.spec.ts:93`, delayed admitted epoch, expected three connection requests, observed four and passed its existing retry. Local workerd logged request-stream/broken-pipe errors around the connection setup failures. No new Task 17 assertion caused these failures, but their complete cause is **unproven**, so this run is explicitly failed and they are not claimed fixed. The mobile-viewport counterparts passed. Previous disposable runtime state was preserved for diagnosis rather than deleted. With fresh disposable state, all three unchanged cases passed five repetitions each: **15/15, zero retries, two workers, one minute**. The final complete check also starts fresh local runtime state, matching a clean CI checkout. This is test isolation and bounded regression evidence, not proof that the earlier failures cannot recur; no existing test, timeout, retry, protocol or storage implementation was changed.

The axe Playwright adapter opens an aggregation tab. That is inappropriate during lifecycle-sensitive live-transfer testing; tests now use axe's documented in-document engine API, with all rules intact. Firefox's native forward Tab does not reliably wrap from browser chrome; traversal uses Tab or Shift+Tab based on document order. WebKit private-context OPFS limitations remain visible in ordinary application scans; persistent profiles are used only for real supported receive flows. Its media wrapper did not retain a simple instance override, so the camera fixture pins a controlled media object after secure document creation. None of these harness fixes changes application lifecycle/capability/security logic or turns an unsupported platform into supported evidence.

Camera/QR and install tests use controlled local responses and genuine keyboard activation. Native AT speech, switch devices, native mobile screen lock, OS high-contrast configuration, native file chooser/share/install destinations and physical device export remain outside Task 17 evidence. WebKit is not native Safari. Lack of external AT certification alone is not treated as an application failure.

## Commands and results

The final command ran in the isolated public-source snapshot described above, with its own dependency tree and fresh disposable local Worker state. Only this report differs from that tested snapshot. All original source/test assertions and normal CI policies are retained.

| Command                          | Result                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`              | PASS — all workspace projects                                                                                         |
| `pnpm typecheck`                 | PASS — root, including new typed React fixtures                                                                       |
| `pnpm lint`                      | PASS — ESLint and Prettier; final report rechecked                                                                    |
| `pnpm check:secrets`             | PASS — tracked/new source, no matching embedded credentials                                                           |
| `pnpm audit:release`             | PASS — refreshed on completion; no known vulnerabilities, low threshold unchanged                                     |
| `pnpm test:unit`                 | PASS — 1,075                                                                                                          |
| `pnpm test:security`             | PASS — 105                                                                                                            |
| `pnpm test:integration`          | PASS — 154; provenance/admission gates unchanged                                                                      |
| `pnpm test:faults`               | PASS — 66; Task 12–16 correctness cases retained                                                                      |
| `pnpm test:release-store`        | PASS — 46; isolated local PostgreSQL only                                                                             |
| `pnpm build`                     | PASS — workspace builds, Worker `--dry-run` only                                                                      |
| `pnpm test:e2e`                  | PASS — 282/282, 7.7 minutes, first attempts, zero retries used                                                        |
| `pnpm test:a11y`                 | PASS — 80/80, 1.3 minutes, retries fixed at zero                                                                      |
| `pnpm test:pwa`                  | PASS — 8/8, 23.9 seconds, retries fixed at zero                                                                       |
| `pnpm verify:rollback`           | PASS — local SessionRoom rollback/drain/roll-forward, four runtimes disposed; not hosted production rollback          |
| Actionlint 1.7.12, all workflows | PASS — existing reviewed `ubuntu-26.04` label declared in temporary older-linter config; no lint rule disabled        |
| `CI=true pnpm check`             | PASS — complete invocation exited 0 in the source snapshot; 1,816 cases, no skips/retries/failures in that invocation |

| Suite                 |  Retained | New executions | Final total |
| --------------------- | --------: | -------------: | ----------: |
| Unit                  |     1,075 |              0 |       1,075 |
| Security              |       105 |              0 |         105 |
| Integration           |       154 |              0 |         154 |
| Faults                |        66 |              0 |          66 |
| Disposable PostgreSQL |        46 |              0 |          46 |
| Browser/storage       |       282 |              0 |         282 |
| Accessibility         |         0 |             80 |          80 |
| PWA                   |         7 |              1 |           8 |
| **Total**             | **1,735** |         **81** |   **1,816** |

No earlier failed attempt is converted into a pass. Focused repeats, engine scans and schedule loops do not inflate these totals. Dedicated follow-up commands were `CI=true pnpm exec playwright test --config playwright.pwa.config.ts tests/pwa/accessibility.spec.ts --repeat-each 5` (5/5, zero retries) and `CI=true pnpm exec playwright test tests/e2e/mobile-hardening.spec.ts tests/e2e/peer-connect.spec.ts --project chromium --grep 'an offer accepted while|visibility pauses an actual|a delayed admitted epoch' --repeat-each 5 --retries 0 --workers 2 --reporter list --output /tmp/meshdrop-task17-ChWqab/focused-regressions-results` (15/15). They provide bounded evidence and do not erase the documented intermittent runtime failures.

## Usability outcomes

| Requirement                       | Result and evidence boundary                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyboard                          | PASS in tested primary flow: create/copy/QR/join/approval, independent pairing, offer/decline/accept, pause/resume/cancel, storage retry, receipt, saved export/delete, camera fallback and install/update. Native Tab/Shift+Tab/Enter/Space; zero observed traps or unreachable tested actions. File selection is synthetic, not native picker certification. |
| Focus                             | PASS — visible indicators; section focus recovery after disappearing/disabled controls, explicit camera-stop return, saved-delete and install focus; unrelated owner-input focus survives remote admission updates.                                                                                                                                            |
| Forms and screen-reader semantics | PASS — native names/roles, explicit labels/help/errors, heading order, invalid invitation state, disabled-state descriptions and semantic DOM assertions. No actual NVDA/VoiceOver speech certification.                                                                                                                                                       |
| Announcements/progress            | PASS — bounded state announcements, errors/copy/cleanup/update feedback, receiver-committed native progress values; byte ticks do not repeatedly change live text.                                                                                                                                                                                             |
| Reduced motion/forced colors      | PASS in browser emulation — non-essential animation/transition disabled, state text retained, system-color borders/focus. No OS high-contrast certification.                                                                                                                                                                                                   |
| Contrast                          | Zero reported axe violations at all severities; visible focus >=3:1 in both themes. Four incomplete SVG labels separately reviewed at >=5.6923:1 light and >=11.8926:1 dark, with no suppression.                                                                                                                                                              |
| Responsive/text/zoom              | PASS — seven widths from 320 to 1440 px, long-name/hash wrapping, 200% text and CSS zoom; create/revoke still keyboard-operable at 200%. Not native toolbar-zoom certification.                                                                                                                                                                                |
| Mobile touch                      | PASS for emulated layout and measured core targets >=44 px; no physical touch-device certification.                                                                                                                                                                                                                                                            |
| Pairing/invitation/QR             | PASS — clear bearer privacy, owner approval and independent comparison; matching connection is not human identity, no auto-trust or bypass; private fields and generic QR description retained.                                                                                                                                                                |
| Error/recovery/saved transfers    | PASS — clear next steps and local-vs-exported deletion scope; verified/missing bytes, expiry and source requirements; real storage/recovery tests retained and all pass in final run.                                                                                                                                                                          |
| PWA/install                       | PASS — built-shell update waits for explicit action after room closure; offline/retention/background limits visible. Controlled install events are UI evidence, not native installation evidence.                                                                                                                                                              |
| Security                          | Pairing, membership, replay/epoch, receiver ACK/hash/receipt, storage/reconciliation/retention and production release gates unchanged. Production mutations/deployments zero.                                                                                                                                                                                  |

Local logs: `/tmp/meshdrop-task17-ChWqab/`. No raw provider responses, credentials, invitations, browser trace/video/screenshots or raw test artifacts are committed/uploaded; this sanitized report is the review artifact. Axe logging includes only severity counts and rule IDs, never HTML, URLs, input values or raw DOM.

The production build retains 20 public files. Summed JavaScript assets changed from 1,255,392 to 1,265,178 bytes (+9,786, approximately 0.78%); CSS changed from 11,280 to 13,128 bytes (+1,848). No `axe-core`, `a11yFixture` or held-ACK test instrumentation occurs in the built inventory. These are build-size observations, not interaction-latency benchmarks; existing dependency annotation/chunk-size warnings are preserved.

## Exact changed files

| File                                                          | Reason                                                                                                     |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                                    | Add the accessibility command to the existing browser job only                                             |
| `apps/web/src/accessibility.ts`                               | Small focus-recovery, readable-byte and state-announcement helpers                                         |
| `apps/web/src/RoomApp.tsx`                                    | Skip navigation, room announcements, form relationships, private copy feedback and plain workflow guidance |
| `apps/web/src/Foundation.tsx`                                 | Workbench skip navigation and matching brand name                                                          |
| `apps/web/src/features/pairing/PairingPanel.tsx`              | Comparison help, bounded state announcement, named keyboard event region                                   |
| `apps/web/src/features/transfer/TransferPanel.tsx`            | Progress semantics, file selection, bounded control actions, receipt/export/delete clarity                 |
| `apps/web/src/features/transfer/SavedTransfersPanel.tsx`      | Verified/missing/expiry guidance and focus restoration after scoped deletion                               |
| `apps/web/src/features/mobile/FileExportControls.tsx`         | Guard duplicate pending picker/share actions and sanitize unexpected export failures                       |
| `apps/web/src/features/mobile/MobilePanel.tsx`                | Focus target and avoid duplicate lifecycle announcement; stalled-probe recheck remains available           |
| `apps/web/src/features/mobile/PwaPanel.tsx`                   | Descriptive update restriction, update announcement and install focus recovery                             |
| `apps/web/src/features/mobile/QrInvitation.tsx`               | QR expansion semantics, camera status and explicit-stop focus restoration                                  |
| `apps/web/src/features/network-intelligence/NetworkPanel.tsx` | Basic/advanced separation, scroll-list focus and diagnostic export feedback                                |
| `apps/web/src/style.css`                                      | Theme contrast/focus, touch/reflow, reduced motion and forced colors                                       |
| `package.json`                                                | Development-only test tools and `test:a11y` in the full check                                              |
| `pnpm-lock.yaml`                                              | Exact dependency records; existing runtime versions/overrides retained                                     |
| `tsconfig.json`                                               | Typecheck the React component fixtures rather than excluding them                                          |
| `playwright.a11y.config.ts`                                   | Four engine/viewport projects, local services and zero retries                                             |
| `tests/helpers/accessibility.ts`                              | In-page axe with sanitized output and bounded native keyboard traversal                                    |
| `tests/fixtures/accessibility-contract.ts`                    | Fixed, typed UI-state fixture vocabulary                                                                   |
| `tests/fixtures/accessibility.html`                           | Isolated local component test document                                                                     |
| `tests/fixtures/accessibility-bootstrap.ts`                   | Documented Vite development preamble for the test document                                                 |
| `tests/fixtures/accessibility.tsx`                            | Actual UI components with explicit synthetic display/response fixtures                                     |
| `tests/a11y/states.spec.ts`                                   | Automated semantics, state, contrast, motion, touch and layout cases                                       |
| `tests/a11y/keyboard.spec.ts`                                 | Native keyboard real-transfer and fallback/error/approval workflows                                        |
| `tests/pwa/accessibility.spec.ts`                             | Built-shell axe and real service-worker update keyboard checks                                             |
| `docs/runbooks/mobile-pwa.md`                                 | User-facing keyboard, scope and supported workflow guidance                                                |
| `docs/reports/task-17-accessibility-ux.md`                    | This audit/evidence report                                                                                 |

## Hosted CI, safety and remaining review

New Task 17 hosted CI run ID: **NOT RUN — awaiting operator manual commit/push**. New-source `core`, `browser`, `foundation`: **NOT RUN**. The starting successful run does not verify these local changes. No final commit SHA is fabricated. A final Task 17 PASS requires all three new hosted results to succeed.

For the operator's manual validation, review and commit only the listed files locally, then run `CI=true pnpm check` against that commit before a normal push. The unchanged provenance test intentionally cannot validate a newly modified lockfile as the old HEAD. The isolated snapshot result preserves that guard; it is not permission to bypass it or deploy. After pushing, inspect the new run's three completed job results independently.

```text
Task10D = SKIPPED
Task11B = SKIPPED
Task13 = PARTIAL
Task14 = PASS
Task15 = PASS
Task16 = PARTIAL
productionApproved = false
production deployments = 0
production mutations = 0
DNS changes = 0
secret changes = 0
TURN changes = 0
paid services activated = 0
commits = 0
pushes = 0
PRs = 0
```

Release publication/acceptance blockers and all pairing, epoch, replay, storage, retention, hash and receipt rules remain intact. Task 18 has not begun.

Method references: [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing), [axe-core API](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md), [WAI status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), [WAI focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html), [WAI reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

## Final acceptance addendum — 17 November 2026

Independently rechecked during Task 18 through authenticated GitHub run and job metadata. This addendum records later acceptance; it does not pretend hosted evidence existed when the original local report was written.

- Final tested implementation SHA: `b3f95d14a103f45f25bbca5b4cfd9c5bb61c7e07`.
- Phase Gates: [44062526570](https://github.com/Shreshtha280407/MeshDrop/actions/runs/44062526570).
- Completed jobs: **core SUCCESS, browser SUCCESS, foundation SUCCESS**.
- Final task verdict: **PASS — ACCESSIBILITY AND PRODUCT UX HARDENED**.

Task10D and Task11B remain SKIPPED. These CI results do not establish deployment, production authorization, independently authenticated human release approval or an independent recovery witness. `productionApproved=false`. The original failure/limitation records and test counts are retained.
