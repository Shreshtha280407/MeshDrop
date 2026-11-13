# Task 15 — internal adversarial security and privacy review

Status: **LOCAL HARDENING VALIDATED — HOSTED CI PENDING MANUAL PUSH**.
This is an internal adversarial security review, not an independent third-party
penetration test or a production authorization. Final Task 15 PASS requires green
Phase Gates for the implementation after the operator's manual commit and push.

## Baseline and scope

Starting branch: `main`, initially clean. Local HEAD, origin/main and authenticated
GitHub main matched `5a535558118a2d533a6b9bf7fcb3d1d01f1e6802` before edits.
[Phase Gates 43286704187](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43286704187)
passed **core, browser and foundation** on that exact source. The baseline contains
**1,458 tests**. This green starting run does not validate the pending patch.

Final source SHA: **not created**; HEAD remains the starting SHA. New Task 15
hosted CI run and core/browser/foundation results: **NOT RUN — manual push pending**.
All hostile traffic targets local workerd, disposable browser profiles or fixtures.
No live public deployment, preview, provider account or unrelated room is attacked.

- Task10D = **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**.
- Task11B = **SKIPPED — HOSTED PREVIEW VALIDATION NOT ESTABLISHED**.
- Task13 = **PARTIAL — APPLICATION HARDENING COMPLETE, EXTERNAL DEVICE EVIDENCE INCOMPLETE**.
- Task14 = **PASS — CONCURRENCY AND ABUSE RESILIENCE HARDENED** (verified starting baseline).
- `productionApproved=false`; publication and acceptance authority remain blocked.

## Attack-surface inventory

| Surface                                 | Actual boundary and evidence                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation URL, QR, clipboard           | Fragment carries only room UUID and single-use invitation bearer. Origin/size/schema validation, current-entry scrubbing, local QR encoding and exact clipboard value. Owner capability is not encoded. The intended invitation input/QR necessarily exposes that bearer to its user; browser/sync/clipboard history is outside application erasure.                                                       |
| Owner/join/member authority             | Random scoped capabilities; only room/peer-domain verifiers persist. Owner approval and one receiver limit apply. Local integration attacks exercise foreign/missing origins, wrong-room capability use and operator separation.                                                                                                                                                                           |
| WebSocket ticket and signaling          | Ticket in subprotocol, not query; one-use, expiry/revision/epoch/origin binding. Actual local upgrades, ticket substitutions, revocation and stale socket tests retain Task 14 generation and budget protections.                                                                                                                                                                                          |
| Pairing and signed controls             | P-256 ephemeral identities, DTLS/transcript binding, room/member/epoch/sequence validation and bilateral confirmation. New tests use real signatures and the actual incoming validator; browser tests separately exercise real local peer connections. A matching code does not identify a human.                                                                                                          |
| Metadata, filenames and MIME            | Strict bounded manifest/path validation; labels never form storage paths. Traversal, HTML delimiters, controls/RTL, excessive length and normalized collisions are rejected. React renders text; no untrusted HTML insertion. Conservative download MIME prevents automatic active-content rendering in MeshDrop. External opening of malicious files remains dangerous.                                   |
| Data frames, ACK, completion, receipts  | One-block sender frontier, bounded transport/storage queues, exact block domain/digest, final full-file hash and receipt handshake. New malicious ACK/receipt/declared-size attacks supplement all retained Task 12 corruption, interruption, source-change, stale-epoch and cancellation cases. A malicious receiver can lie about its own disk; the protocol cannot independently observe that hardware. |
| IndexedDB, OPFS, recovery               | No admission/signing/relay secrets persisted. Manifest/block rehash, exact-source reconciliation, fresh admission/epoch/pairing and scoped retention/locks. Real browser reload tests mutate receipts, bytes and manifests. Local self-consistency is not authentication against wholesale origin/profile compromise.                                                                                      |
| Diagnostics, logs and exported JSON/CSV | Strict numeric/category schemas, fixed event messages, selected RTC-stat extraction and bounded history. No filenames, room/peer IDs, credentials, candidate/IP/SDP or raw errors. Optional audit logger emits only four fixed/allowlisted fields. Tests inject synthetic private canaries and formula-like strings without logging them.                                                                  |
| Service worker and cache                | Exact public shell allowlist; API, query, authorization, range, foreign-origin and transfer data excluded. Built PWA tests inspect requests and response bodies after a real transfer and offline reload.                                                                                                                                                                                                  |
| Operator endpoints and alert journal    | Independent operator proof; room owner/member/invite credentials cannot invoke `/ops/*`, and operator proof is not a room capability. CLI use without browser Origin remains deliberate. Fixed metrics, bounded/redacted journal/outbox and provider fixtures retain Task 14 limits.                                                                                                                       |
| TURN credentials                        | Coturn HMAC expiry is room/TTL bounded. Cloudflare requests reserve the upstream deadline from remaining TTL. Metered selects only propagated keys whose upper expiry fits the room. Tests use mocks/local coturn generation only; no provider quota is consumed. Revocation prevents new issuance but cannot erase already issued credentials or ongoing allocations.                                     |
| Supply chain and artifacts              | Existing low-threshold audit and esbuild/minimatch/undici overrides retained. Expanded static scan covers known provider/operator assignments, concrete invitations and credential-bearing URLs. Findings contain categories, not matched values. Browser traces/video/automatic screenshots remain disabled.                                                                                              |

Every inventoried area without a reproduced defect is **NO CONFIRMED DEFECT in
the reviewed implementation and defined tests**, not a universal security claim.
No authorization, pairing, queue limit, persisted format, Worker binding, migration,
deployment configuration, dependency or release authority is weakened.

## Confirmed defects and severity

1. **LOW — same-document invitation URL remained visible.** Startup scrubbing did
   not run on hash-only navigation, history restoration or BFCache return. The
   built-PWA regression failed before the fix when a second invitation stayed in
   `location.hash`; it also did not populate the invitation input. A shared bounded
   consumer now replaces the current URL before handing off the invitation, listens
   to `hashchange`/`popstate`/`pageshow`, and removes listeners on cleanup. Active room
   authority is never replaced or silently admitted. Browser-managed copies remain
   a residual privacy boundary.
2. **LOW — raw exception/server error text could enter the room UI.** Unique
   synthetic canaries from fetch, JSON parsing and API error responses appeared in
   `RoomClient` snapshots before correction. Locally authored public errors and
   protocol-code guidance now preserve useful distinctions while suppressing raw
   dependency/provider messages. Unknown errors still fail; no blanket success or
   retry is introduced. No unauthorized remote exfiltration was demonstrated.
3. **LOW — persisted receipt context was not checked on recovery.** Reconciliation
   rehashed file data but retained structurally valid receipts copied from a different
   transfer/digest/total/file manifest. Seven original mismatch tests failed. Receipt
   context must now match the rehashed manifest before completed state is restored;
   otherwise the receipt is removed and state is interrupted while verified bytes
   remain recoverable/exportable. This closes local context confusion, not a file-hash
   bypass or independent signature/authenticity proof for an arbitrarily forged profile.

No unfixed HIGH or CRITICAL application defect was identified. No actual tracked
provider credential was found. The scan expansion initially flagged two obvious
synthetic fixtures; their labels now explicitly say `synthetic-`, preserving all
existing assertions and the unsafe-URL rejection they test.

## Adversarial results and evidence boundaries

- **2,000 schedules**, seeds 7, 17, 97 and 2027, 500 each: a valid signed control is
  accepted first, followed by wrong room/member/transcript/key, modified payload/
  signature, sequence replay/overflow, stale/future epoch or missing local/remote
  pairing. Rejected controls cannot advance the sequence or application delivery.
  These are real cryptographic checks through a controlled transport seam, not
  2,000 physical WebRTC reconnections.
- **43 new local HTTP/WebSocket cases**: seven mutation routes × five invalid/
  missing origins, operator separation, coturn temporary credential privacy,
  five genuine ticket substitutions and post-revocation rejection. Old isolation,
  replay, third-peer, expiry, hibernation, rate and reconnect tests remain.
- **10 new transfer fault cases**: four malicious ACK fields, four receipt-context
  substitutions and smaller/larger advertised source sizes versus actual block
  announcements. All require no false receipt/completion; failed ACKs cannot advance
  progress. The declared-size test drives the hostile sender directly after consent
  so an honest sender's own manifest check does not short-circuit the receiver test.
  This file-backed transport simulation is not a signature or physical-disk claim.
- **Desktop and mobile Chromium browser cases** reject malicious filename paths/
  markup and preserve exact independently hashed bytes for legitimate formula-like
  names; real copy/QR, owner-capability exclusion, expiration guidance and revocation
  UI are checked. The expiration response injection is a UI fixture; actual server
  expiry enforcement is tested independently.
- **Real OPFS/IndexedDB** reload cases reject foreign receipts, corrupted bytes and
  inconsistent manifests in both browser projects. Existing quota, worker-crash,
  orphan retention, checkpoint and stale-epoch scenarios remain mandatory.
- **Built PWA** checks later/history invitation consumption and no secret request/
  referrer/local-storage leakage, plus cache inspection after a real transfer and
  offline reload. Intentional query/auth fetches test cache exclusion using synthetic
  values; they do not suggest query credentials are private from the requested server.
- **Diagnostics JSON/CSV/audit tests** retain legitimate metrics while rejecting
  raw credentials, filenames, room/peer IDs, IP/SDP/candidates, paths and formulas.
  No formula-capable user-controlled cell reaches CSV, so legitimate filenames are
  not arbitrarily renamed and no unnecessary CSV-format change was made.
- **Receipts**: every signed field/context mutation and an alternate signer fail
  real cryptographic verification. Receipt replay/idempotent completion remains
  covered by the retained transfer tests. Local receipt rehash is explicitly not
  equivalent to offline signature authentication.

Initial failures are retained in the investigation: three original regressions
failed before fixes. New fixture development corrected a too-short synthetic TURN
secret, the existing `idle` UI label, and an invalid test assumption that a coherent
but dishonest size declaration can be rejected before seeing the block announcement.
No application limit, original assertion, retry or deadline was relaxed. A sandbox
read-only Git spawn restriction was rerun with permission rather than bypassing the
secret check.

Two early full-check attempts stopped before the test suites: a new test referenced
a private helper property, and the new Node scanner omitted an explicit URL parser
import required by ESLint. Both were corrected using public manifest data and
`node:url` imports before the successful complete invocation. They were development
errors, not pre-existing application vulnerabilities or waived checks.

## Validation

Executed totals: **118 new**, **1,458 retained**, **1,576 total**. The complete
`CI=true pnpm check` exited 0 in the original working tree. Its browser stage had
two existing first-attempt failures and two configured retry passes, recorded below;
this is not represented as a clean first-attempt browser run.

| Command                                                                                                                          | Result                                        | Scope/count                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:security-redteam`                                                                                                     | PASS                                          | 29 unit + 24 security + 43 integration + 10 faults = 106; separate browser/PWA cases below.                                                   |
| `CI=true pnpm exec playwright test tests/e2e/adversarial-privacy.spec.ts tests/storage/adversarial-recovery.spec.ts --retries 0` | PASS after correcting new fixture assumptions | 10 desktop/mobile executions: four UI and six real storage cases. All pass with zero retries; original fixture failures are documented above. |
| `CI=true pnpm exec playwright test --config playwright.pwa.config.ts tests/pwa/adversarial-privacy.spec.ts`                      | PASS                                          | 2 built-PWA cases, retries 0.                                                                                                                 |
| `pnpm -r typecheck`                                                                                                              | PASS                                          | All workspace projects.                                                                                                                       |
| `pnpm typecheck`                                                                                                                 | PASS                                          | Root TypeScript, including new tests.                                                                                                         |
| `pnpm lint`                                                                                                                      | PASS                                          | ESLint and full Prettier check.                                                                                                               |
| `pnpm check:secrets`                                                                                                             | PASS                                          | Tracked/unignored text, environment-file and ignore checks; no matching embedded credentials.                                                 |
| `pnpm audit:release`                                                                                                             | PASS                                          | Fresh read-only advisory query; no known vulnerabilities; unchanged low threshold/overrides.                                                  |
| `pnpm test:unit`                                                                                                                 | PASS                                          | 1,058; 47.4 seconds.                                                                                                                          |
| `pnpm test:security`                                                                                                             | PASS                                          | 105; 5.3 seconds, including 2,000 new schedules.                                                                                              |
| `pnpm test:integration`                                                                                                          | PASS                                          | 154; 64.9 seconds, actual isolated workerd and release safeguards.                                                                            |
| `pnpm test:faults`                                                                                                               | PASS                                          | 66; 69.8 seconds, including retained large logical streaming cases.                                                                           |
| `pnpm test:release-store`                                                                                                        | PASS                                          | 46; 31.9 seconds, disposable local PostgreSQL only.                                                                                           |
| `pnpm build`                                                                                                                     | PASS                                          | All workspace builds, Worker dry-run only.                                                                                                    |
| `pnpm test:e2e`                                                                                                                  | PASS with two retry passes                    | 138 first-attempt passes + two existing retry passes, 140 distinct cases; 7.8 minutes. Not a clean first-attempt result.                      |
| `pnpm test:pwa`                                                                                                                  | PASS                                          | 7/7 first attempt; 21.4 seconds.                                                                                                              |
| `CI=true pnpm check`                                                                                                             | PASS, exit 0                                  | Complete invocation in this checkout; browser retry qualifications above apply.                                                               |
| `pnpm verify:rollback`                                                                                                           | PASS                                          | Local historical SessionRoom round trip; four runtimes started/disposed, private files cleaned.                                               |
| Actionlint, all workflows                                                                                                        | PASS                                          | Existing reviewed runner-label configuration; no workflow changes.                                                                            |
| Focused mobile repeat command below                                                                                              | PASS                                          | 10/10 first attempt; five repeats each, 50.7 seconds.                                                                                         |
| `CI=true pnpm test:e2e --retries 0`                                                                                              | PASS                                          | Final complete follow-up: 140/140 first-attempt passes, zero retries and zero failures; 7.3 minutes.                                          |
| New hosted Phase Gates                                                                                                           | NOT RUN                                       | Awaiting manual push; baseline run is not patch evidence.                                                                                     |

Suite totals are unit 1,058 + security 105 + integration 154 + faults 66 +
release-store 46 + browser 140 + PWA 7 = **1,576**. Repeated executions are not
counted as additional distinct tests.

The initial complete check had two mobile Chromium flakes: offline suspension
reached `reconnecting` during authenticated resume, and collision-export setup
remained at signaling `connecting`. Both passed on the unchanged existing retry.
Local workerd/proxy dropped-connection, EPIPE and ECONNRESET warnings coincided
with these failures; that correlation does not establish a root cause. No new
security case failed, no retry was added, and no assertion or timeout was relaxed.
Both existing scenarios then passed five repeats each with zero retries. A complete
zero-retry follow-up was interrupted by the execution-server restart after 23
passing cases. An immediate restart refused the still-closing server port without
reusing it; after the ports cleared, the final complete browser run passed
**140/140 first attempts, zero retries, zero failures** in 7.3 minutes. All attempts
remain recorded; the incomplete/interrupted run is not counted as a pass. The
review does not claim to have fixed a new WebRTC race on this bounded evidence.

Focused repeat command (the pipe is inside the quoted regular expression):

```bash
CI=true pnpm exec playwright test tests/e2e/mobile-hardening.spec.ts tests/e2e/security-abuse.spec.ts --project mobile-chromium --grep 'offline suspension|colliding directory' --repeat-each 5 --retries 0
```

Reproduction uses the repository Node/pnpm versions, installed Playwright browsers
and existing local PostgreSQL Docker fixture. Set
`WRANGLER_SEND_METRICS=false` and
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false` so ignored provider configuration is
not loaded. The dedicated adversarial alias is also included through the normal
unit/security/integration/fault globs; it is not a replacement for `pnpm check`.

## Defined security invariant outcomes

| Invariant / attack                     | Result in the reviewed local cases                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS and HTML injection                 | 0 script executions or injected handlers/nodes from the hostile filename cases; built CSP blocks inline script and foreign fetch.                                                                               |
| Capability confidentiality             | 0 synthetic canary occurrences in the tested non-secret UI error, diagnostics, audit and cache outputs. Intended invite inputs/QR/clipboard and authorized request headers remain sensitive channels.           |
| Invitation privacy                     | Current URL cleared at startup, later hash navigation and history restoration; no fragment canary in observed resource request/referrer/local/session storage. Browser-internal history erasure is not claimed. |
| Cross-room / operator authority        | 0 unauthorized state mutations; foreign/missing-origin requests rejected; room capabilities cannot invoke operator endpoints.                                                                                   |
| WebSocket authorization and revocation | 0 unauthorized upgrades in defined ticket substitutions; revoked sockets cannot regain authority or revive closed state.                                                                                        |
| Replay, epoch and pairing              | 0 forbidden application deliveries/sequence changes across 2,000 new schedules; one-sided confirmation cannot enable transfer.                                                                                  |
| Malicious sender / receiver            | 0 false verified completions; invalid ACKs do not advance progress, substituted receipts fail and dishonest size/block domains fail before commitment. Remote physical-disk honesty remains unprovable.         |
| Recovery / persistent state            | Foreign receipt discarded; damaged bytes/manifest rejected or conservatively interrupted after real OPFS/IndexedDB reload. Full source/byte revalidation remains mandatory.                                     |
| Orphan cleanup                         | Retained real-browser expiry/discard/orphan/worker-crash cases pass. Cleanup runs on application access under scoped locks; no guaranteed background or physical erasure.                                       |
| PWA/cache                              | 0 sensitive application-cache entries in inspected requests and bodies, online and after offline reload.                                                                                                        |
| Diagnostics / receipts                 | Metrics survive JSON/CSV round trips; raw private/formula inputs rejected. Every tested signed receipt/context mutation and alternate key is rejected.                                                          |
| TURN                                   | Local coturn expiry and disclosure checks pass; retained Metered/Cloudflare fixture cases pass, with no live provider requests.                                                                                 |
| Dependency and static source audit     | PASS at the existing low threshold; no matching embedded credentials in tracked/unignored text. This is not exhaustive unknown-secret detection.                                                                |

Raw ignored Playwright reports, browser internals and failure snapshots can retain
short-lived synthetic invitations entered by local tests. They are not public
evidence, are not uploaded by CI, and must not be shared without review/redaction.
This task does not claim that every private developer-tool artifact is secret-free.
No real provider configuration is loaded, and no raw artifact is committed here.
The final successful browser run leaves no failed-test snapshots to publish.

## Changed files

- `apps/web/src/security/invitationUrl.ts` — bounded invitation consumer and navigation listener cleanup.
- `apps/web/src/main.tsx` — use the same consumer at initial startup.
- `apps/web/src/RoomApp.tsx` — consume later invitation navigation without replacing active room authority.
- `apps/web/src/security/publicErrors.ts` — trusted local guidance and protocol-code mapping.
- `apps/web/src/features/pairing/RoomClient.ts` — suppress untrusted API/dependency error text, preserve local actionable errors.
- `packages/storage/src/integrity.ts` — typed receipt/manifest consistency check.
- `packages/storage/src/LedgerReconciler.ts` — drop inconsistent receipt after real byte rehash.
- `scripts/security/secret-policy.mjs` — pure redacted source-secret policy.
- `scripts/check-secrets.mjs` — apply expanded policy to tracked/unignored textual sources.
- `package.json` — deterministic `test:security-redteam` alias.
- `tests/unit/privacy-boundaries.spec.ts` — original defects, consistency positives and navigation lifecycle cleanup/bounds.
- `tests/unit/secret-policy.spec.ts` — known-key, URL, placeholder and value-redaction cases.
- `tests/security/adversarial-protocol.spec.ts` — real-signature schedules, pairing gate and receipt mutation.
- `tests/security/diagnostics-privacy.spec.ts` — allowlisted exports, raw stats/audit canaries and formula rejection.
- `tests/integration/adversarial-auth.spec.ts` — actual local origin, privilege, ticket, revocation and relay boundaries.
- `tests/faults/adversarial-transfer.spec.ts` — malicious sender/receiver controls and no false completion.
- `tests/e2e/adversarial-privacy.spec.ts` — actual rendering, downloads, copy/QR, error, local state and revoked peer UI.
- `tests/storage/adversarial-recovery.spec.ts` — real persisted-state tampering after worker termination/reload.
- `tests/pwa/adversarial-privacy.spec.ts` — built-shell URL/history and sensitive-cache exclusion.
- `tests/fixtures/rehearsal-faults.ts` — explicitly label existing offline credentials synthetic.
- `tests/integration/peer-signaling.spec.ts` — explicitly label unsafe-URL credentials synthetic, preserving the rejection assertion.
- `docs/threat-model.md` — current trust boundaries and corrected historical orphan/audit statements.
- `docs/privacy-model.md` — navigation/error/receipt/cache/log boundaries and residual risks.
- `docs/security/secrets.md` — scanner coverage and already implemented retention clarification.
- `docs/security-review.md` — correct obsolete blanket no-console claim; optional audit is sanitized.
- `docs/reports/task-15-security-privacy-redteam.md` — this evidence and limitations.

## Residual risks and release boundary

No promise is made about erasing browser/sync/clipboard history, compromised
origin/profile security, remote physical durability, provider logs/allocation expiry,
native OS export/pickers, storage eviction or arbitrary unknown secret formats.
Task 13's remaining external device evidence is unchanged. A source/artifact hash,
local receipt, CI result or this report is not human release authorization.

Hash-only navigation does not reload the entry module; `replaceState` changes the
current entry only. See the official
[hashchange documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/hashchange_event)
and [History API](https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState).
CSV quoting alone is insufficient against formulas; the current boundary excludes
untrusted strings before export, as tested against the
[OWASP formula-injection threat](https://owasp.org/www-community/attacks/CSV_Injection).

Commits, pushes and PRs by this task: **0/0/0**. Changes remain local and unstaged
for operator review. Production deployments, configuration, secret, DNS, admission,
migration and live-session mutations: **0**. Paid services and provider quota used
by adversarial tests: **0**. Task10D/Task11B and deployment workflows were not run.
No Task 16 work is started.
