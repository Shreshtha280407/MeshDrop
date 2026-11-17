# MeshDrop — current project status

Reviewed 17 November 2026. Start here for current claims; dated reports and media remain evidence for their own source/device/scenario. This is the canonical status entry point, not release authorization.

## Source and verification

| Property                         | Verified state                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final roadmap acceptance source  | `130bf45b5711d4d4014428d1094792a74b2653bf`                                                                                                                                   |
| Phase Gates / successful attempt | [44079358491, attempt 2](https://github.com/Shreshtha280407/MeshDrop/actions/runs/44079358491/attempts/2): core SUCCESS, browser SUCCESS, foundation SUCCESS                 |
| Distinct complete-check cases    | 1,816: unit 1,075; security 105; integration 154; faults 66; release-store 46; browser/storage 282; accessibility 80; PWA 8                                                  |
| Task 18 final verdict            | **PASS — FINAL PROJECT AUDIT AND PORTFOLIO READINESS COMPLETE**; [final hosted acceptance](reports/task-18-final-project-audit.md#final-hosted-acceptance--17-november-2026) |
| Production authorization         | `productionApproved=false`; release publication and acceptance remain blocked                                                                                                |
| Current deployed public source   | UNVERIFIED in this audit. Tasks 12–18 did not deploy their source; P9 hosted evidence does not establish that current main is deployed                                       |

Both attempts were independently checked through GitHub run/job metadata. Attempt 1 passed core but failed browser and foundation after two retained accessibility timing/focus failures. Attempt 2 reran the unchanged source and passed all three jobs. The initial hosted browser flake remains recorded; its root cause is not established, and no test, timeout, retry, assertion or security control was weakened.

This acceptance SHA identifies the audited roadmap state, not every later Git HEAD. Documentation-only synchronization commits may have newer SHAs and receive their own CI without redefining the application baseline. Focused repetitions, property schedules, benchmarks and external-device sessions are not added to the distinct complete-check total. No machine-readable status copy is maintained alongside this document.

## Architecture and verified engineering scope

- React/Vite provides explicit room approval, bilateral independent code comparison, accessible transfer/export/recovery controls and local diagnostics.
- A same-origin Pages gateway uses a service binding to a private signaling Worker. Three SQLite Durable Objects serve separate roles: `SessionRoom`, `RelayPool` and `OperationsMonitor`; configuration retains migrations v1/v2.
- WebSockets carry bounded control-plane SDP/ICE and membership state. File bodies, manifests, ACKs and receipts use encrypted WebRTC. TURN, when configured, forwards encrypted packets; MeshDrop has no central file-upload/storage service.
- Transfer workers hash incrementally, bound queues and acknowledge receiver-committed blocks. Whole-file verification and a scoped receipt handshake precede completion. An external save/share request remains distinct from independently verified exported bytes.
- OPFS and IndexedDB retain scoped checkpoints/source metadata; recovery rehashes storage, checks the exact source and requires fresh network admission/pairing. Cleanup is conservative, locked and triggered by later access.
- The PWA caches only public shell resources. Diagnostics are bounded, local and opt-in for export. Neither installation nor saved storage supplies background delivery or network authority.

The [architecture diagram](assets/readme/architecture.svg), [ADRs](adr/001-control-data-planes.md) and [protocol contracts](protocol/v1.md) match these responsibilities. Task 18 changes no runtime/protocol/storage architecture.

| Measured highlight                                               | Evidence boundary                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 GiB logical streaming simulation; real 64 MiB browser transfer | [Task 12](reports/task-12-transfer-reliability.md); simulation is not a physical-device 1 GiB result                                                 |
| 100 local paired rooms / 200 local TCP signaling sockets         | [Task 14](reports/task-14-concurrency-load.md); not 100 hosted users or a provider capacity guarantee                                                |
| Four simultaneous local browser transfers                        | Task 14 desktop/mobile-emulated representative cases, independent saved hashes                                                                       |
| 2,000 adversarial schedules                                      | [Task 15](reports/task-15-security-privacy-redteam.md); deterministic internal tests, not an independent penetration test                            |
| 2,000 storage lifecycle schedules                                | [Task 16](reports/task-16-storage-lifecycle.md); simulated APIs plus separate real browser storage tests                                             |
| 99 accessibility scans and 80 engine/viewport executions         | [Task 17](reports/task-17-accessibility-ux.md); zero reported violations in that final run, separately reviewed incomplete SVG contrast calculations |

## Platforms and remaining limitations

The [support matrix](support-matrix.md) is authoritative for scenario detail; the [device matrix](../tests/devices/browser-matrix.md) preserves historical observations. Linux Chromium/Firefox, Playwright WebKit and mobile emulation are separate from physical Android and native cloud iPhone/iPad/Windows/macOS evidence.

- Task 13's real cloud iPhone 8 MiB normal/recovered bytes and final hashes verify, but Free automation cannot independently retrieve those native downloads. These complete export cases remain incomplete. Earlier P9 results belong to different dated builds/scenarios.
- True Windows reverse cross-network connectivity remains unverified after an ICE-checking failure. A same-cloud-host sender-engine pass is not cross-network proof.
- Native picker/share/install matrices, optical physical QR and personally held iOS lifecycle remain incomplete. Playwright WebKit is not native Safari. No NVDA, VoiceOver or formal WCAG certification was performed.
- Browser/OS eviction, quota, permission changes or site-data clearing can remove checkpoints. Closed browsers cannot run scheduled cleanup; physical power-loss durability and secure erasure are not promised. Exported copies are outside app cleanup.
- Both peers must stay online/open. Unknown quota limits new offers to 64 MiB; 300 MiB offers require the existing warning acknowledgement. These are policy thresholds, not universal supported-device sizes.
- Historical Metered Free configuration uses a shared 0.5 GB monthly hard stop. No current provider balance, plan state or retention policy was queried. Hosted capacity evidence remains small, separately scoped from local load tests.
- Intermittent local workerd/pairing failures were recorded during Task 17, followed by unchanged zero-retry diagnostics and a clean complete run. Their complete cause remains unproven; no claim that every race is eliminated is made.

## Security and release boundaries

The [internal security review](security-review.md), [threat model](threat-model.md) and [privacy model](privacy-model.md) distinguish tested controls from limits. A compromised origin/profile can access this origin's data. Malicious exported files, external clipboard/history, provider metadata and a receiver lying about physical disk persistence remain outside the protocol's guarantees. Receipts and hashes are not identity or release-authority credentials.

```text
productionApproved = false
acceptanceEnabled = false
production publication = disabled
humanAuthorizationVerified = false
independentWitnessVerified = false
```

`hostedProvider()`, hosted approval/acceptance and witness integration remain fail-closed. The isolated preview path requires exact separate-account/resource pins and explicit configuration; its hosted validation was skipped. Historical P9 production operation does not override these current release controls. No deployment or provider configuration is performed by Task 18.

## Final normal roadmap

| Task | Scope                             | Current final status / acceptance evidence                                                                                                                                 |
| ---- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10D  | Hosted trust rehearsal            | **SKIPPED — HOSTED TRUST EVIDENCE NOT ESTABLISHED**                                                                                                                        |
| 11B  | Hosted isolated preview           | **SKIPPED — HOSTED PREVIEW VALIDATION NOT ESTABLISHED**                                                                                                                    |
| 12   | Transfer reliability              | **PASS — TRANSFER RELIABILITY HARDENED**; [42671820721, attempt 2](https://github.com/Shreshtha280407/MeshDrop/actions/runs/42671820721/attempts/2)                        |
| 13   | Cross-platform reliability        | **PARTIAL — APPLICATION HARDENING COMPLETE, EXTERNAL DEVICE EVIDENCE INCOMPLETE**; [43074089192](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43074089192)     |
| 14   | Concurrency / abuse               | **PASS — CONCURRENCY AND ABUSE RESILIENCE HARDENED**; [43286704187](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43286704187)                                  |
| 15   | Security / privacy                | **PASS — ADVERSARIAL SECURITY AND PRIVACY HARDENED**; [43467956839](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43467956839)                                  |
| 16   | Storage lifecycle                 | **PARTIAL — APPLICATION STORAGE HARDENED, PLATFORM LIMITATION REMAINS**; [43625992715](https://github.com/Shreshtha280407/MeshDrop/actions/runs/43625992715)               |
| 17   | Accessibility / UX                | **PASS — ACCESSIBILITY AND PRODUCT UX HARDENED**; [44062526570](https://github.com/Shreshtha280407/MeshDrop/actions/runs/44062526570)                                      |
| 18   | Final audit / portfolio readiness | **PASS — FINAL PROJECT AUDIT AND PORTFOLIO READINESS COMPLETE**; [44079358491, attempt 2](https://github.com/Shreshtha280407/MeshDrop/actions/runs/44079358491/attempts/2) |

The deliberate skipped release-certification work is not a failed core application feature. Partial platform results remain visible. Task 18 is the last normal roadmap task; no Task 19 is being started or required for ordinary portfolio readiness.

**NORMAL DEVELOPMENT ROADMAP COMPLETE.** Task 18's exact-source hosted acceptance is established. Completion does not mean zero future bugs, production authorization, independent security certification or universal platform support. The skipped and partial results above remain unchanged.

## Reproduce and maintain

Use the [local-development runbook](runbooks/local-development.md), frozen dependencies and the documented Linux full-suite prerequisites: Playwright libraries, Git/OpenSSL, GitHub CLI at `/usr/bin/gh` for offline signature fixtures, and Docker's Unix socket for disposable PostgreSQL. Native Windows/macOS app evidence is separate from full test-host portability. `CI=true pnpm check` includes the read-only documentation validator; `pnpm audit:release` separately requests current npm advisories. Never count an unavailable registry response as clean. Root source is MIT; dependency licenses remain separate. Self-hosted QR notices remain, and development-only axe-core is MPL-2.0 and absent from application bundles.

After a manual push of reviewed changes, verify that commit's exact SHA and all three completed `core/browser/foundation` results. A later documentation-only CI run validates that synchronized repository state; it does not replace the final roadmap acceptance source recorded above. YAML and this status file alone prove neither hosted settings nor production acceptance. Future work should follow actual feedback/bugs/contributions or an explicit optional release-certification decision, rather than invented roadmap phases.
