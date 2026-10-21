# MeshDrop implementation audit — 21 October 2026

Baseline: `2426b4e` on `main`, with a clean working tree before this audit.
Both supplied PDFs were read in full. The phase-wise plan controls execution
and acceptance; the architecture plan defines the trust boundaries. The plan
ends at P9. Its post-release ideas are not an unfinished P10.

Source fingerprints:

| PDF                                               | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| MeshDrop_Phase_Wise_Implementation_Plan.pdf       | `454b88f73a0c144f845610d9ea46cca70d33854a7c2d3cd67f7493c687f1ec93` |
| MeshDrop_Backend_Architecture_MVP_Master_Plan.pdf | `4e1a573d36dc490e571930fc865aa5912089688da48708908fce44b67a17f935` |

## Findings against every phase

Implementation is present through P9. Full acceptance is incomplete: remaining
P7 platform/lifecycle acceptance and P9 release gates remain open. The P2
cross-platform peer demonstration now passes on the tested systems. The specific
real-iPhone live demonstration also passes, including saved-file export and
surviving-storage recovery. Engine tests do not close other physical gates.

| Tickets   | Code and reproducible coverage inspected                                                                                                                        | Acceptance status                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.1–P0.6 | Strict pnpm workspace, protocol/shared types, states/frames, golden fixtures, foundational ADRs, CI and foundation demo                                         | Local foundation exit gate recorded as passed.                                                                                                                                                                                                                                                                                                                     |
| P1.1–P1.6 | Worker routing/security, SQLite `SessionRoom`, capability verifiers, admission, one-use tickets, TTL/rate limits; real Worker/WebSocket integration tests       | Local authorization/denial demonstration passed; public admission/revocation also recorded in P9.                                                                                                                                                                                                                                                                  |
| P2.1–P2.6 | Peer/ICE/pairing engine, temporary credentials, capabilities and epochs; pairing/signature/replay/cross-engine tests                                            | The required platform peer demonstration now passes: Linux laptop/OPPO, real cloud iPhone/iPad, native Windows 11 Chrome 155 and Mac Safari 26.4 all complete public admission/pairing/signed ping. Small native desktop receive/export also passes. Earlier bundled-engine failures remain recorded. Public restrictive-network relay remains P9 acceptance work. |
| P3.1–P3.6 | Manifest/frame contracts, worker SHA-256, watermarks, receiver assembly/storage ACKs, pause/cancel/receipts; file-transfer/integrity tests                      | Local 1 GiB exact exported digest and bounded-memory gate recorded; six larger P9 benchmarks also recorded.                                                                                                                                                                                                                                                        |
| P4.1–P4.6 | OPFS store, IndexedDB ledger, reconciliation, quota/retention, source reselection/save adapters; crash-consistency/storage-recovery tests                       | Recorded 300+ MiB close/reopen/rehash demonstration passed on supported desktop storage. Eviction remains a limitation.                                                                                                                                                                                                                                            |
| P5.1–P5.6 | Epoch/resume proof engine, authenticated manifests, ranges, retries and source identity; resume/fault tests                                                     | Recorded 1 GiB interruption near 70% and isolated subnet migration passed. Browser cases cover 10/50/70/95%; public Oppo outage/recovery passed separately.                                                                                                                                                                                                        |
| P6.1–P6.6 | WebRTC/app measurements, provenance, aggregates, rules, capped local history and JSON/CSV exports; diagnostics tests                                            | Measured pause/recovery, exactly reused bytes and export gate recorded as passed.                                                                                                                                                                                                                                                                                  |
| P7.1–P7.6 | Usable capability probes, foreground/visibility policy, iOS/Android export adapters, mobile controls/theme and production PWA; mobile/PWA tests                 | Implementation delivered. Real iPhone 1 MiB accept/store/verify/export and 2 MiB reload/recovery/export pass; laptop and OPPO reverse directions pass. Real iPad 1 MiB receive/export passes. Native Mac Safari 1 MiB receive/export also passes. Real OS lifecycle/picker/share/installation and larger iPhone export remain uncertified where listed.            |
| P8.1–P8.6 | Threat/privacy reviews, bounded work, safe paths/conflicts, fragment handling/CSP, fuzz/property/abuse tests and dependency audit                               | Security phase's own local demo/suite passed. This does not waive P2/P7 physical prerequisites.                                                                                                                                                                                                                                                                    |
| P9.1–P9.6 | Deployment isolation/frozen bundles, free public preview, disabled optional TURN adapter, CI/manual release tooling, sampled logs, benchmarks and documentation | Preview, Oppo demo, six local benchmarks and Worker rollback already delivered. This continuation adds real Pages rollback/restoration. Free public relay, account alert delivery, device matrix and production acceptance remain open.                                                                                                                            |

The core boundary is implemented: Cloudflare handles control messages and room
authorization. The transfer engine waits for receiver storage commitment before
sending a block ACK; final storage/hash verification precedes completion.
OPFS/IndexedDB recovery reconciles and rehashes surviving bytes. No ordinary
file-upload/cloud-file-storage route was found. These conclusions are supported
by inspected code and negative tests, not only UI or phase labels.

## Fresh verification

The baseline check passed package/root types, lint/formatting, secret checks,
340 unit, 42 security, 53 integration and 18 fault cases, production builds and
105 of 106 browser cases. WebKit initially failed to launch because the local
compatibility-library path was absent. Re-running that exact case with the
existing `.meshdrop-artifacts/webkit-deps/usr/lib/x86_64-linux-gnu` library path
passed real cross-engine pairing, transfer and exported-byte comparison. All
five production PWA/privacy cases passed separately.

The new deployment tests add 11 passing cases. **575 distinct automated cases
passed across these commands** (351 unit, 42 security, 53 integration, 18 fault,
106 browser, 5 production PWA). This aggregates the baseline and focused runs;
the initial single `pnpm check` did not exit zero. Repeated focused cases are
counted once. The npm release audit reports no known vulnerabilities after
retrying outside the sandbox's restricted DNS environment. No new dependency
was installed for the rollback work.

Raw logs are `/tmp/meshdrop-current-check.log`, `/tmp/meshdrop-webkit-check.log`,
`/tmp/meshdrop-current-pwa.log` and `/tmp/meshdrop-current-audit-final.log`.
Reviewed deployment evidence is [tracked separately](evidence/phase-9-pages-rollback.json).
Existing large-file and earlier physical Oppo results were inspected rather than
repeated. New real iPhone/OPPO/iPad checks are recorded separately below; they are
not included in the 575 local automated cases.

## P9 continuation delivered

`pnpm verify:pages-rollback preview` selects an older successful production-branch
deployment of the isolated **preview project**, records the restore IDs privately,
switches Pages, checks CSP/readiness and the same approved SQLite room, checks
that a different client module is served, then restores and checks the original
module SHA-256. It closes the synthetic room and records reviewed-safe evidence.
The Worker is unchanged. This does not exercise a coordinated frontend/backend
release rollback or an end-to-end transfer during rollback.

The public drill passed and restored Pages deployment
`d00a8791-2d5d-4bc4-affb-aee33b178bf3`. Tests cover lost mutation responses,
failed public checks, failed restoration, concurrent-release detection, unsafe
project/branch/build targets and suppression of provider secrets.

## Real device continuation

The provider plan API reported `Free` before every session. Real iPhone 15 Pro Max
Safari passed public laptop → iPhone 1 MiB delivery and independently hashed
export; iPhone → laptop and both OPPO ↔ iPhone directions passed at 1 MiB. The
2 MiB iPhone recovery/export case paused after 1 MiB, reloaded, rehashed surviving
bytes, renewed admission/comparison, reselected the exact source, sent only the
missing 1 MiB and independently matched the saved download. This closes the
specific iPhone live demonstration in the phase plan.

Both normal and recovered 8 MiB iPhone cases reached final verified storage, but
cloud automation did not return exported bytes. Those overall cases remain
false; the smaller passing case does not establish a maximum or explain the
larger export observation. iPhone source selection was programmatic, so native
picker interaction is not certified. See [iPhone evidence](evidence/phase-7-ios-cloud.json).

A real cloud iPad Pro 13 2025 passed 1 MiB public receive/verify/export. Native
Windows 11 Chrome 155 and native Mac Safari 26.4 also passed public pairing,
signed ping, 1 MiB committed/hash-verified receive and independently matching
saved downloads. These complete the specific P2 platform peer demonstration.

Earlier attempts remain recorded: Windows bundled Chromium 153 stayed in peer
`checking` across devices, while a same-host control passed; cloud macOS Playwright
WebKit 26.6 did not pass the usable-storage probe. Neither result is relabeled by
the later branded-browser successes, and no cause for those differences is claimed.
See [tablet/desktop evidence](evidence/phase-7-device-cloud-matrix.json). Android
tablets and every laptop/PC model have not been tested. All test sources were
synthetic; the Android runner used only its own tab and exact download filename.
The OPPO can be disconnected now.

## Remaining work and phone requirements

1. **Remaining P7 coverage:** real OS interruptions,
   picker/share/installation where required, and larger iPhone saved-file export.
   Keep the measured iPhone and iPad sizes explicit.
2. **Other device coverage:** extend native Windows/Mac/tablet reverse-role,
   recovery and size coverage as needed. The required P2 peer demonstration and
   Android–iPhone directions now pass. The OPPO is next needed for a regression after a
   transport/mobile change or for an actual relay/network test; it is not needed
   for documentation and account checks.
3. **Free relay:** verify a public relay with an enforceable no-charge boundary;
   test relay-only and UDP-blocked TCP/TLS paths, metering and capacity. Keep
   direct mode until possible. An initial allowance is insufficient.
4. **Operations:** verify quota/failed-join alerts and delivery; configure GitHub
   environment protections if using manual CI, and exercise a matching product
   release rollback when release records exist. Read-only checks of notification
   types/policies and TURN keys all returned 403 with the existing deployment
   OAuth; see [permission evidence](evidence/phase-9-operations-preflight.json).
5. **Production:** provision/publish and run acceptance for the separate origin
   after preceding gates. Moving origins does not migrate browser checkpoints.

All services must remain free. No billing activation, plan upgrade, paid device
testing, paid relay or domain purchase is authorized. No Git staging, commit or
push was performed. P9 remains unfinished, with earlier physical acceptance
debt explicitly retained.
