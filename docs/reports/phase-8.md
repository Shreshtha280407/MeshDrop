# MeshDrop Phase 8 report — security, abuse and adversarial QA

Date: 2026-10-18. Source: P8.1–P8.6 and the strict P8 exit gate in the supplied implementation plan, with the architecture's device-owned data-plane boundary. Baseline: the user's Phase 7 commit `ca296f3`. Work is local and uncommitted; no commit, GitHub push, deployment or Phase 9 implementation was performed.

**Phase 8 is complete for its local implementation and required automated/live-browser exit demonstrations. Phase 7's physical iPhone gate remains pending.** The user explicitly requested moving to this phase; P8 tests do not substitute for that missing device evidence. No phone was needed for the P8 local gate.

## Delivered work

| Ticket | Completed behavior                                                                                                                                                                        | Main files / evidence                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P8.1   | Enumerated bearer, signaling, impersonation, browser/profile, local storage and provider trust boundaries; recorded residual risks                                                        | [Security review](../security-review.md), [privacy model](../privacy-model.md), updated threat model        |
| P8.2   | Persistent room-wide budgets, no persistent app schema for forged room IDs, bounded ticket rows, server SDP role checks, HTTP chunk/deadline limits, bounded signaling/control/ICE queues | `SessionRoom.ts`, `security/policy.ts`, `limits.ts`, `RoomClient.ts`, `PeerSession.ts`                      |
| P8.3   | Portable path/name validation, Unicode/case and ancestor conflict rejection, collision-free flat exports, conservative MIME, strict metadata                                              | `file-path.ts`, `safeFilePath.ts`, save/share/download adapters, file controls                              |
| P8.4   | Reviewed one-use/expiry/revocation admission; proved visible URL cleanup, no web-storage bearer retention and no-referrer navigation; documented browser-internal history limits          | Production privacy suite, existing admission suite, privacy model                                           |
| P8.5   | Deterministic bounded fuzzing, valid-seed mutations, range-set properties and explicit stale/replay/geometry rejection; real malformed DATA denial                                        | `packages/protocol/tests/fuzz`, `packages/recovery/tests/property`, `tests/security`, browser/Worker suites |
| P8.6   | Strict production CSP and response policies, origin/CORS and retention/error review, patched/locked/audited dependencies, privacy-safe test artifacts and CI audit                        | `security-headers.ts`, Worker errors, lockfile, CI, reviewed evidence                                       |

Existing cryptographic pairing, independent comparison, block hashes, storage commit ACKs, source-authenticated resume, final receipts and diagnostic allowlists remain enforced. File bytes, filenames, manifests, file hashes and receipts do not enter server application storage or logs.

## Engineering decisions and fixes

Room budgets are persistent and independent of client address: 180 HTTP requests, 24 ticket mints, 24 upgrade attempts and 12 successful epoch advances per minute. Only four fixed budget keys exist. They survive runtime eviction. At most two participant records exist, there is one unconsumed ticket per peer, and total ticket rows have an explicit 64-row cap plus expiry pruning. A well-shaped forged room ID no longer creates the application schema. Existing rooms migrate when activated, including closed rooms later visited by cleanup alarms. The first browser run exposed that legacy-room table requirement; an eviction/migration regression now covers it.

Streamed JSON is limited to 8 KiB, 256 chunks including empty chunks and a five-second total deadline. A source cannot retain an unbounded array of empty chunks or hold a body read indefinitely. Cancellation does not wait on an untrusted source promise. Worker errors stay generic. The forwarding server also checks owner-offer/receiver-answer roles instead of relying solely on receiver-side negotiation checks.

Client signaling is capped at 64 queued messages / 256 KiB. Signed outgoing control work is capped at 64 tasks and respects the data-channel byte budget; pending local ICE is capped at 128 candidates. Existing remote ICE, peer receive queues, replay windows, strict message sizes and bounded transfer buffers remain active. Queue counters are retained until old-generation tasks settle so reconnects cannot manufacture unbounded capacity. Provider/browser transport buffers remain outside an application-memory bound.

The path policy rejects traversal, absolute/drive/UNC forms, reserved device stems including superscript/fullwidth forms, control/bidi characters, lone surrogates, overlong/deep labels, compatibility/case collisions and file/directory conflicts. Labels stay NFC; storage remains keyed by generated identifiers. Distinct directory labels such as `one/same.txt` and `two/same.txt` now export separately as `same.txt` and `same (2).txt`, reserving later original names before suffix allocation. Independent downloads verify that the two outputs contain different expected source bytes. Existing files outside the app are handled through browser/native destination dialogs.

MIME claims on source Files are ignored. A small extension map chooses common document/media MIME types; unknown and active HTML/SVG extensions use octet-stream. No automatic preview exists and untrusted files can still be dangerous when opened elsewhere. The manifest accepts no arbitrary MIME/metadata extension fields.

Production static assets receive same-origin CSP without inline/eval scripts, no-referrer, no embedding, nosniff and restricted device permissions. Preview exercises the emitted static-host policy; Worker responses carry their own API policy. Development explicitly relaxes inline script/style rules for Vite/React refresh. Public HTTPS/header propagation and relay operations still need P9 verification.

The QR UMD with an incomplete embedded dependency version manifest was replaced by exact `@zxing/browser` 0.2.1 / `@zxing/library` 0.23.0 dependencies and lazy, self-hosted build chunks. The lockfile covers transitive versions/integrities, release scanning covers those packages, and license notices remain. Regression tests exposed detector misses on some scaled front-facing codes after replacement. A stronger perspective detector plus one bounded pure-code fallback now handles those cases; public deterministic seeds 8/13 cover the failure without retaining a live invitation. Desktop/mobile camera round trips and production-CSP camera decoding verify the corrected path. Vite 7.3.7, Vitest 4.1.11 and esbuild 0.28.1 address the initial audit findings. A targeted override covers Wrangler's affected esbuild dependency; local Worker integration and dry-run builds verify compatibility.

Default browser traces, video, automatic failure screenshots and automatic CI upload of raw failure artifacts are disabled. Explicit reviewed evidence remains available. The secret checker now tolerates deleted tracked source files before the user stages them, while still checking tracked/unignored environment files. No new provider key was needed; the existing ignored signaling `.env` remains mode 0600 and secret example fields remain empty.

## Verification

The complete `pnpm check` passed **530 unique tests without retries: 314 unit, 42 security, 47 Worker/SQLite integration, 18 fault, 104 browser/storage and 5 production PWA/privacy tests**. Strict package/root types, ESLint, Prettier, secret/ignore checks, frontend production build and Worker dry run also passed. This adds 64 automated cases to the P7 suite, as well as deterministic input iterations within those cases. Tests reused the local development services; production PWA tests built separate local preview/Worker services.

The exact `pnpm audit:release` command reports **zero known vulnerabilities**. The full graph (348 dependencies) and separate production graph (20 dependencies) both report zero advisories. The initial audit had nine dependency/advisory entries across eight distinct advisory references, including one critical entry. The existing-checkout frozen offline install passed; this is not a claim that a fresh offline checkout can download dependencies.

Evidence: [reviewed check summary](evidence/phase-8-checks.txt), [automated abuse summary](evidence/phase-8-abuse-summary.json), [dependency audit](evidence/phase-8-dependency-audit.json), [release-audit output](evidence/phase-8-release-audit.txt), [frozen install](evidence/phase-8-install.txt), [third-browser denial](evidence/phase-8-third-user-denied.png), [unsupported DATA version](evidence/phase-8-malformed-version.png), [excess fragment count](evidence/phase-8-malformed-fragment-count.png) and [out-of-order DATA](evidence/phase-8-malformed-order.png). The full generated security-test report remains in ignored `.meshdrop-artifacts/phase-8/security.json`. Repeated focused checks are not added to the unique-test count.

The suite includes the following independently meaningful checks:

- 5,000 deterministic bounded byte/JSON input iterations, 1,000 valid transfer-frame round trips with header mutations, and explicit UTF-8 SDP/ICE, numeric and unknown-field rejection.
- 2,000 generated range sets checked against an independent bitset complement, with idempotence, input immutability, overlap and extreme-bound cases.
- Real local Worker/SQLite/WebSocket access denials, expiry, ticket replay, wrong-room/peer routing, hibernation/restart, rate windows, impersonation, malformed frames and bounded ticket/epoch work.
- Six browser demonstrations: duplicate-basename exports, signaling flood denial, third-user denial and three malformed real WebRTC DATA variants. Rejected transfer variants have zero committed bytes and no export.
- Production tests for CSP script/network denial, local QR loading, history/storage/referrer behavior, offline independently verified export, install assets and explicit update behavior.
- Earlier phase tests for signed pairing/replays, storage crash consistency, quota/write failures, reload/source identity, recovery, diagnostics privacy and cross-browser behavior.

The initial full-run browser stage used the default browser cache instead of this machine's `/tmp` installation and could not launch. It is an environment failure, not a protocol result; the corrected complete command includes the local browser/library paths. An earlier focused privacy assertion also revealed Chromium's retained `userTypedURL`; the final assertion and privacy model distinguish clean navigation URLs from browser-internal metadata rather than claiming erasure. The first corrected full browser run found the QR regression (103/104 browser cases passed); it was fixed and the complete gates rerun. Upstream Rollup annotation and environment warnings remain nonfatal and visible in the raw check log.

## Privacy findings and remaining gates

The app promptly replaces the invitation fragment in its visible URL/current navigation entry; fragments never enter HTTP requests. Browser internal history metadata, sync, clipboard managers, screenshots, extensions and copied links remain outside the page's erasure authority. The canary navigation receives no Referer, web storage holds no invitation credential, and CSP blocks an external canary fetch. Neither history replacement nor a clean audit proves complete confidentiality.

No application console/payload logging or analytics is introduced. Hosting/runtime/relay logs and retention remain provider configuration work. Reports exclude raw credentials, names/hashes and addresses, but allowed UUIDs, sizes and timing remain linkable. Local files are origin-private and evictable; deletion cannot erase exported copies, and expiry runs when the app/provider can execute cleanup.

Room and address limits do not provide a global concurrent-room/spending cap or protection against distributed volumetric attacks. Public TLS/WSS, deployed headers/CORS, TURN credentials/relay policy, log configuration, account cost controls and operational recovery remain P9 work. No independent penetration test is claimed. P7 physical iPhone transfer/export and its other documented device gaps remain open.

## Commit command

Run after reviewing the local diff. Nothing has been staged, committed or pushed by the agent.

```sh
git add .
git commit -m "feat: harden security and abuse controls for phase 8"
```

The [abuse runbook](../runbooks/security-abuse.md) explains reproduction. Do not begin P9 automatically; the next phase remains for the user's next instruction.
