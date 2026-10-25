# Measured support and release coverage

Evidence is device/browser/scenario specific. Browser API presence, an emulated
viewport and a WebKit engine test do not certify a physical iPhone or macOS Safari.
The [production site](https://meshdrop-7ce2dc2e-production.pages.dev) and
[preview](https://meshdrop-8ab9cb08-preview.pages.dev) pass actual hosted
UDP/TCP/TLS relay delivery. The physical Oppo additionally passed production
8 MiB relay delivery and 32 MiB actual Wi-Fi outage/recovery with native exports,
independent hashes, receipts and diagnostics. Earlier preview direct Wi-Fi and
mobile-data results remain valid. See the [latest audit](reports/continuation-2026-10-25.md)
and [device matrix](../tests/devices/browser-matrix.md) for exact measured scopes.
Further iPhone work is deferred at the user's request; retained prior results
below do not establish every tablet, PC or network.

| Platform                                                                   | Evidence already recorded                                                                                                                                                                                                                                                          | Limits / remaining coverage                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux Chromium                                                             | Automated pairing, transfer, independent digest/export, OPFS/IndexedDB checkpoints, resume/faults, diagnostics, PWA/CSP/offline export; all six P9 local 100 MiB/1 GiB/2 GiB normal/disconnect cases                                                                               | Full-size matrix is local desktop evidence. Public physical Wi-Fi/mobile results use smaller files.                                                                                                 |
| Linux Firefox                                                              | Real Firefox engine transfer/peer checks in the cross-browser suite                                                                                                                                                                                                                | No claim that every Chromium-specific storage/export/PWA workflow has the same support.                                                                                                             |
| Linux WebKit                                                               | Real WebKit engine transfer/peer checks                                                                                                                                                                                                                                            | This is not physical Safari/iPhone coverage.                                                                                                                                                        |
| Pixel 7 viewport                                                           | Chromium mobile layout and lifecycle/storage/error automation                                                                                                                                                                                                                      | Emulation, not a physical Pixel test.                                                                                                                                                               |
| Oppo F19 Pro, Android 13, Chrome 155.0.8059.79 / .84                       | P7 direct 8 MiB both ways, 32 MiB lifecycle/recovery and 320 MiB receive/export/hash. P9 preview direct Wi-Fi/mobile data; new production forced-relay 8 MiB receive/export and 32 MiB actual Wi-Fi outage/recovery/export reusing 23 MiB; independent hashes/receipts/diagnostics | ANDROID_NATIVE_MATRIX_PENDING Optical QR and universal sizes/networks remain uncertified. Earlier P7 lock/app-switch scenarios began paused.                                                        |
| iPhone 15 Pro Max / Safari 26.6–26.6.1, real BrowserStack hardware         | Public direct 1 MiB receive/export, 2 MiB recovery/export, reverse and OPPO directions. New forced-relay 8 MiB receive/export and 2 MiB reload/recovery/export reuse 1 MiB; actual exported bytes independently hashed                                                             | Further iPhone work deferred. Native picker/share/install and complete OS lifecycle cases remain uncertified. Older incomplete 8 MiB export runs remain historical failures; no maximum-size claim. |
| iPad Pro 13 2025 / iPadOS 26.6 / Safari 26.6.1, real BrowserStack hardware | Public laptop → iPad 1 MiB admission, signed pairing, committed/hash-verified receive and independently matching export                                                                                                                                                            | Single receiving scenario; reverse roles, recovery, native picker/share/installation and larger sizes not certified. Android tablets untested.                                                      |
| Windows 11 / native cloud Chrome 155                                       | Public laptop → Windows admission/pairing/signed ping, 1 MiB stored/final-hash verified receive and independently matching saved download                                                                                                                                          | Small receiving scenario; reverse roles, recovery, native picker/share and larger sizes untested.                                                                                                   |
| Windows 11 / cloud Playwright Chromium 153                                 | Separate contexts on one cloud host passed 1 MiB pairing/transfer/export; earlier cross-device attempt stayed checking                                                                                                                                                             | The cross-device attempt remains incomplete. Its cause is not established by the later native Chrome pass.                                                                                          |
| macOS Tahoe / native cloud Safari 26.4                                     | Public laptop → Mac admission/pairing/signed ping, 1 MiB stored/final-hash verified receive and independently matching actual saved download via provider retrieval                                                                                                                | Receive-only small-file case; reverse roles, recovery, native picker/share, installation and larger sizes untested.                                                                                 |
| macOS Tahoe / cloud Playwright WebKit 26.6                                 | Shell loaded; usable OPFS capability gate did not pass                                                                                                                                                                                                                             | Incomplete engine result; retained separately from the passing native Safari case.                                                                                                                  |

Large-file acceptance requires an actual quota estimate and available disk, plus
headroom and the explicit warning from 300 MiB. Unknown quota permits at most
64 MiB per new offer in this application. A measured 1/2 GiB desktop transfer is
not a universal mobile maximum. Browser eviction and OS background restrictions
can interrupt delivery or remove saved data. WebRTC transport requires both
devices online and the app open; installing a PWA does not change this contract.

## P9 release evidence

- Passed: preview and production HTTPS/WSS control-plane delivery, approval and revocation.
- Passed: real hosted Metered Free UDP/TCP/TLS 1 MiB transfer/export/receipt/diagnostics in both environments; two simultaneous 1 MiB pairs per environment.
- Passed: OS-firewall UDP-blocked TCP/TLS complete transfers in an isolated Docker namespace with local signaling and real remote relay; host firewall unchanged.
- Passed: physical production laptop/Oppo forced-relay 8 MiB delivery and 32 MiB actual Wi-Fi outage, fresh-epoch comparison, missing-only recovery, native export and independent hash.
- Passed locally: normal/disconnect 100 MiB, 1 GiB and 2 GiB matrix with exact exports, missing-only resumed payload and bounded queues/memory.
- Passed: account request analytics availability, actual failed-join HTTPS alert-journal delivery, room/operator isolation and v2 paired Pages/Worker rollback/restoration with persisted-room and fresh transfer checks.
- Verified free: no Cloudflare billable coverage/subscriptions; Metered $0/month, 0.5 GB shared hard stop and zero overage. Relay/provider quotas are shared between preview and production.

The [hosted release evidence](reports/evidence/phase-9-hosted-release.json) and
[Android production evidence](reports/evidence/phase-9-android-production-relay.json)
record the actual scopes. Request analytics may be sampled/delayed and do not
replace provider duration/storage quota inspection. The alert destination is a
private journal; no email was sent. Two small simultaneous pairs do not prove a
maximum concurrency. Whole-size local benchmarks do not certify large public
relay transfers or universal mobile support.

Historical component rollback drills retain their original v1 scope; the new
paired v2 drill verifies compatible actor bindings and restores the current
versions. Both v2 pairs serve the same frontend digest. Earlier failed recovery
and rollback attempts remain failures in their dated evidence.

USB on the successful production Oppo run carried debugging only; no reverse
tunnel carried application traffic. Original network settings were restored.
Every evidence record must distinguish local/emulated/physical and direct/relay
scope. Untested optical QR, native platform variants and size/network combinations
remain unclaimed. Browser eviction, OS suspension and exhausted Free relay quota
can interrupt availability; installing a PWA does not enable background delivery.
