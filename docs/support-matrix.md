# Measured support and release coverage

Evidence is device/browser/scenario specific. Browser API presence, an emulated
viewport and a WebKit engine test do not certify a physical iPhone or macOS Safari.
The [public preview](https://meshdrop-8ab9cb08-preview.pages.dev) passes HTTPS/WSS,
8 MiB Wi-Fi delivery, 32 MiB real Wi-Fi disconnect/resume and 1 MiB existing
mobile-data delivery between the laptop and Oppo. Native downloads, independent
hashes, receipts and diagnostics passed. See the detailed
[device matrix](../tests/devices/browser-matrix.md) and phase reports. Real iPhone normal/recovery/export, both OPPO ↔ iPhone directions, and a real iPad receive/export also pass within the sizes below. These do not establish every tablet, PC or network.

| Platform                                                                   | Evidence already recorded                                                                                                                                                                                                        | Limits / remaining coverage                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux Chromium                                                             | Automated pairing, transfer, independent digest/export, OPFS/IndexedDB checkpoints, resume/faults, diagnostics, PWA/CSP/offline export; all six P9 local 100 MiB/1 GiB/2 GiB normal/disconnect cases                             | Full-size matrix is local desktop evidence. Public physical Wi-Fi/mobile results use smaller files.                                                                                                                       |
| Linux Firefox                                                              | Real Firefox engine transfer/peer checks in the cross-browser suite                                                                                                                                                              | No claim that every Chromium-specific storage/export/PWA workflow has the same support.                                                                                                                                   |
| Linux WebKit                                                               | Real WebKit engine transfer/peer checks                                                                                                                                                                                          | This is not physical Safari/iPhone coverage.                                                                                                                                                                              |
| Pixel 7 viewport                                                           | Chromium mobile layout and lifecycle/storage/error automation                                                                                                                                                                    | Emulation, not a physical Pixel test.                                                                                                                                                                                     |
| Oppo F19 Pro, Android 13, Chrome 155.0.8059.79                             | P7 physical 8 MiB both directions, 32 MiB lifecycle/recovery, 320 MiB receive/export/hash. P9 public Wi-Fi 8 MiB delivery and 32 MiB real outage/recovery; mobile data 1 MiB delivery; native downloads/hash/receipt/diagnostics | Optical QR, native file picker/share and PWA installation are not certified. P7 screen-lock/app-switch scenarios began paused; injected lifecycle events are identified separately. No public large-file or relay result. |
| iPhone 15 Pro Max / Safari 26.6–26.6.1, real BrowserStack hardware         | Public laptop → iPhone 1 MiB receive/verify/export; 2 MiB reload/recovery/export reusing 1 MiB; iPhone → laptop and both OPPO ↔ iPhone directions at 1 MiB; exported bytes independently hashed                                  | Native picker/share/installation and real OS lifecycle cases remain uncertified. Normal/recovered 8 MiB storage/hash passed but exported bytes were not returned; no maximum-size claim.                                  |
| iPad Pro 13 2025 / iPadOS 26.6 / Safari 26.6.1, real BrowserStack hardware | Public laptop → iPad 1 MiB admission, signed pairing, committed/hash-verified receive and independently matching export                                                                                                          | Single receiving scenario; reverse roles, recovery, native picker/share/installation and larger sizes not certified. Android tablets untested.                                                                            |
| Windows 11 / native cloud Chrome 155                                       | Public laptop → Windows admission/pairing/signed ping, 1 MiB stored/final-hash verified receive and independently matching saved download                                                                                        | Small receiving scenario; reverse roles, recovery, native picker/share and larger sizes untested.                                                                                                                         |
| Windows 11 / cloud Playwright Chromium 153                                 | Separate contexts on one cloud host passed 1 MiB pairing/transfer/export; earlier cross-device attempt stayed checking                                                                                                           | The cross-device attempt remains incomplete. Its cause is not established by the later native Chrome pass.                                                                                                                |
| macOS Tahoe / native cloud Safari 26.4                                     | Public laptop → Mac admission/pairing/signed ping, 1 MiB stored/final-hash verified receive and independently matching actual saved download via provider retrieval                                                              | Receive-only small-file case; reverse roles, recovery, native picker/share, installation and larger sizes untested.                                                                                                       |
| macOS Tahoe / cloud Playwright WebKit 26.6                                 | Shell loaded; usable OPFS capability gate did not pass                                                                                                                                                                           | Incomplete engine result; retained separately from the passing native Safari case.                                                                                                                                        |

Large-file acceptance requires an actual quota estimate and available disk, plus
headroom and the explicit warning from 300 MiB. Unknown quota permits at most
64 MiB per new offer in this application. A measured 1/2 GiB desktop transfer is
not a universal mobile maximum. Browser eviction and OS background restrictions
can interrupt delivery or remove saved data. WebRTC transport requires both
devices online and the app open; installing a PWA does not change this contract.

## P9 release evidence

- Passed: stable public HTTPS and WSS on the available Wi-Fi and mobile network.
- Passed: physical laptop/Oppo create → admit → compare → transfer → disconnect → compare
  fresh codes → resume → inspect diagnostics → export independent file and receipt.
- Pending: managed/coturn relay under the owner's free-only constraint, forced relay path and
  UDP-blocked TCP/TLS fallback.
- Passed locally: normal and controlled-disconnect 100 MiB, 1 GiB and 2 GiB matrix,
  exact SHA-256, missing-only resumed payload, bounded queues and memory scope.
- Passed: public admission/revocation and recorded-version Worker rollback/restore;
  local rate-limit, TTL cleanup, drain and gateway outage tests. Pending: actual
  account quota alerts, coordinated product rollback and separate production environment acceptance.

The separate public preview Pages rollback/restoration passed on 21 October 2026,
including changed asset hashes, readiness and same approved-room access. Its
[evidence](reports/evidence/phase-9-pages-rollback.json) complements the prior
Worker drill. Neither drill certifies a paired release or physical file transfer
during rollback.

Every evidence record must identify local/emulated/physical and direct/relay/unknown
scope. An incomplete row remains pending; do not promote it using unrelated tests.

The successful public Oppo tests used normal Chromium/Android Chrome networking,
without USB reverse forwarding or a browser mDNS workaround, and selected direct
paths. Wi-Fi recovery reused 23 MiB at a fresh epoch after an observed real outage;
mobile-data delivery used an already-enabled connection, with Wi-Fi disabled.
Both loaded the current client in the mobile run. Earlier public recovery failed;
the pending-retry fix, regression and successful rerun are described in the
[P9 report](reports/phase-9.md), along with all reviewed evidence and limitations.
This does not establish relay, every carrier/router or universal mobile size support.
