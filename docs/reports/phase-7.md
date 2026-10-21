# MeshDrop Phase 7 report — mobile and PWA hardening

Original checkpoint: 2026-10-18. Source: P7.1–P7.6, contracts and acceptance gates in the supplied phase-wise plan, with the architecture's device-owned storage boundary. Baseline: the user's Phase 6 commit `232b596`. At that checkpoint, changes were local and no public deployment or Phase 8 work had been performed. The current continuation is described below.

**Current status: the real-iPhone live demonstration passes; broader Phase 7 platform acceptance remains open.** At the original 18 October checkpoint, only the Oppo and Linux laptop were available and the iPhone gate was pending. The continuation below supersedes that hardware limitation. Linux WebKit and native-API mocks remain separate from real-device results.

Continuation, 21 October 2026: the verified Free BrowserStack account provided
real iPhone 15 Pro Max/Safari and iPad hardware. Laptop → iPhone 1 MiB receive,
storage, final verification and actual exported-file hashing passed. A second
2 MiB case paused at 1 MiB, reloaded both browsers, rehashed the surviving
checkpoint, renewed admission/comparison, reselected the exact source, sent only
the missing 1 MiB, and exported an independently matching file. This satisfies
the specific live demonstration in the phase plan. iPhone → laptop and both
OPPO ↔ iPhone directions also passed at 1 MiB, including destination exports.
iPhone source selection used a synthetic File in the real input; the native
source picker was not tested.

The real iPad Pro 13 2025 passed a 1 MiB receive/verify/export. Native Windows
11 Chrome 155 and Mac Safari 26.4 then passed public laptop pairing, signed ping,
1 MiB receive/verify/export with independently matching saved files. Earlier
incomplete bundled-engine results remain recorded: Windows Chromium 153 stayed
checking across devices (a same-host control passed), and macOS Playwright WebKit
26.6 did not pass the usable-storage probe. The later native-browser passes do
not identify the cause of those earlier results.

**Larger iPhone export remains unverified:** normal and recovered 8 MiB cases
completed storage/final hashes, but cloud automation did not return saved bytes.
Both overall cases remain false. A smaller passing export is not a measured
maximum, and the cause of the larger observation is unresolved. See
[reviewed iOS evidence](evidence/phase-7-ios-cloud.json),
[tablet/desktop evidence](evidence/phase-7-device-cloud-matrix.json), and
[cloud reproduction](../runbooks/mobile-pwa.md#real-iphone-cloud-automation-on-a-free-account).
The remaining original results below retain their 18 October scope. No phone,
service, billing activation or plan upgrade was purchased.

## Implementation delivered

| Ticket | Behavior                                                                                                                                                                             | Main implementation                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| P7.1   | Usable OPFS write/flush/read, checkpoint DB commit and exclusive-lock probes; secure WebRTC, quota/persistence, file/save APIs, camera permission and app mode                       | `CapabilityProbe.ts`, `capability.worker.ts`, `MobilePanel.tsx`                 |
| P7.2   | Named verified-file download; conditional file-specific system share and streaming choose-location save; explicit cancellation/failure feedback                                      | `IosExportAdapter.ts`, `AndroidSaveAdapter.ts`, `FileExportControls.tsx`        |
| P7.3   | Size/quota preflight and consent recheck, explicit receive/export strategy, unknown-space cap and large-file acknowledgement; local invitation QR camera flow                        | `PlatformPolicy.ts`, `QuotaManager.ts`, `TransferPanel.tsx`, `QrInvitation.tsx` |
| P7.4   | Hidden-page pause, including late offer acceptance; suspension/offline transport shutdown, foreground retry guards and explicit recovery; revalidated saved-file export after reload | `Lifecycle.ts`, `RoomClient.ts`, `SavedTransfersPanel.tsx`                      |
| P7.5   | At least 44-pixel touch controls, 16-pixel mobile inputs, responsive export controls, horizontally scrollable readable chart, system dark/light theme                                | `style.css`, `NetworkPanel.tsx`, mobile components                              |
| P7.6   | Production manifest, PNG/maskable/Apple icons, install guidance, exact public-asset offline cache and explicit user-applied updates                                                  | `manifest.webmanifest`, `pwa.ts`, `PwaPanel.tsx`, PNG generator                 |

Existing signed admission, pairing, transfer frames, verified storage ACKs, receipts, checkpoint/source identity and diagnostics contracts remain in use. No new backend file-body route or cloud file storage was added. Health and the app label identify P7. The UI names P8 as future work; this report keeps the unmet P7 gate explicit.

## Important engineering decisions

The capability panel reports actual small storage operations, separate from API presence in the retained P0 workbench. Failed/unsupported probes block receive with a reason. It never requests camera permission merely to show capabilities.

Before new consent, known quota must cover offered bytes plus the larger of 10% or 4 MiB headroom. Unknown quota is distinct from zero: new offers above 64 MiB are blocked; smaller unknown-space offers require acknowledgement. Offers from 300 MiB also require acknowledgement. These are product safeguards, not empirically established maximum phone sizes. Runtime quota errors remain possible and keep verified partial checkpoints under the selected retention policy.

Saved-file export uses two steps so asynchronous worker revalidation does not consume the click's transient activation. First prepare the verified saved file; then a separate Save/Share/Choose-location click opens the system flow immediately. Live completed transfers already have their verified file. Native picker writes stream from file-backed bytes. Share completion and download initiation deliberately tell the user to check the selected destination; only a completed picker write says it finished writing. Cancellation preserves the verified browser copy and does not launch a fallback dialog automatically.

Camera QR encoding/decoding is local, validates origin and format, and only fills the invitation input. Room approval and comparison remain required. Camera tracks stop on success, cancel, hide/page exit and unmount. The pinned full ZXing browser UMD is self-hosted with SRI and wrapper/core/encoding licenses. Registry DNS was intermittent, so the official complete distribution was vendored with recorded integrity rather than adding an unresolved npm dependency. The lockfile remains unchanged. No external QR API receives invitation secrets or frames.

Hidden pages pause where possible; returning does not automatically unpause. Suspension/offline closes transport, and recovery still requires fresh pairing and authenticated saved-range reuse. Reload loses ephemeral room access while surviving bytes are rehashed. Neither callback delivery nor retention is guaranteed when the OS kills a process.

The service worker caches an exact allowlist of public shell files only. API requests, query-bearing URLs, private credentials, file payloads and file-transfer manifests are excluded. Public hashed worker code is cached so offline saved-file revalidation/export can run. A changed service worker waits for an explicit update action; the button is disabled while this tab's room is open and warns about other transfer tabs. No automatic update interrupts a transfer. Installation enables a shortcut and limited cached UI, with no closed-browser delivery promise.

The [engineering contract](../protocol/mobile-p7.md) records types, policy, cache boundaries and primary browser/platform references. The [runbook](../runbooks/mobile-pwa.md) explains reproduction and physical acceptance.

## Verification

The full `pnpm check` passed **466 tests without retries: 314 unit, 39 Worker/SQLite integration, 18 faults, 92 browser/storage and 3 production PWA tests.** Package/root strict types, ESLint, Prettier, secret checks, production frontend build and Worker dry run passed. This run reused the local development preview; the PWA suite built and started separate production test servers. Existing-checkout frozen offline installation also succeeded; this is not a fresh dependency reinstall claim. Nonfatal upstream Rollup annotation and environment warnings remain visible in the logs.

Browser checks cover real WebRTC delivery and independent downloaded-byte hashes, API activation/cancellation, quota rejection, local QR roundtrip and stopped synthetic-camera tracks, denied-camera fallback, hidden-offer pause, foreground pause/resume and offline recovery with fresh comparison. Dark-mode mobile layout, touch size and chart scrolling are checked on an actual completed-transfer UI. The PWA output directory was separated so it no longer replaces browser screenshots. The 3 PWA checks and 2 export/visual cases were rerun successfully to verify artifact preservation; they are not added again to the 466 unique-test count.

Evidence: [full check](evidence/phase-7-checks.txt), [frozen existing-checkout install](evidence/phase-7-install.txt), [production PWA verification](evidence/phase-7-pwa-checks.txt), [desktop exports](evidence/phase-7-export-desktop.png), [mobile exports](evidence/phase-7-export-mobile.png), [dark mobile layout](evidence/phase-7-dark-mobile.png) and [offline saved-file export](evidence/phase-7-offline-export.png).

After the test-runner/artifact adjustments, whole-repository lint/formatting, root strict types, secret/ignore checks and `git diff --check` also passed. HEAD remains `232b596`; no changes were staged or committed. The local development preview remains available at `http://127.0.0.1:5173`. The Oppo tests have finished, so the phone can be disconnected.

Production PWA acceptance uses a built app and real service worker on isolated loopback servers. It verifies a real 5 MiB transfer, offline reload, checkpoint revalidation and exact saved-file export; confirms the cache has only public assets; validates manifest/PNG sizes and maskable purpose; and applies a changed worker only after explicit user action and room closure.

During development, those tests exposed and corrected preview-origin fallback, shared local Worker persistence, and static cache misses caused by differing module/precache `Vary: Origin` requests. Exact public-asset cache fallback now ignores Vary; private routes never enter that path. Initial failures are not counted as passing evidence.

### Physical Oppo and laptop

The physical runner connects to the user's authorized Android Chrome and creates only its own tab. Signaling uses USB reverse; WebRTC chooses the file path. Synthetic source selection and automated pairing comparison exercise the application but are not native source-picker or human identity certification. Android downloads are checked at their exact unique test filenames, pulled and independently hashed; personal tabs and files are not enumerated.

Playwright's default CDP options can override Android download handling and force focus, masking real app switching. The runner uses `noDefaults: true` to retain native behavior, and a scoped transport attaches only newly created test tabs rather than initializing existing tabs. Physical results must come from that configuration. It writes test evidence under `/tmp` and leaves synthetic phone downloads for review. These can be removed by the user after testing.

The phone reported usable OPFS, IndexedDB and Web Locks, about 10,240 MiB estimated free browser quota, no persistent-storage grant and browser mode. Save-picker presence is only detection; the actual tested export route is recorded with each result. No browser quota is presented as hardware free disk space. Measured successes establish lower bounds for those test conditions, not maximum supported sizes.

| Physical scenario                                            | Observed result                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Laptop → Oppo, 8 MiB                                         | Direct ICE path; accepted, stored, verified, saved by native Android Chrome Downloads, pulled by exact synthetic filename and independently SHA-256 matched                                                                                                                                     |
| Oppo → laptop, 8 MiB                                         | Direct ICE path; accepted/stored/verified and independently hashed desktop download matched                                                                                                                                                                                                     |
| Oppo app switch and reload, 32 MiB                           | Paused at 2 MiB committed, Android Home produced real hidden visibility, Chrome returned without automatic resume, explicit resume completed and actual Android download hash matched; reload revalidated the checkpoint and prepared export                                                    |
| Oppo screen lock, injected offline/online and reload, 32 MiB | Real screen sleep/wake preserved a paused checkpoint. Scoped CDP offline/online was followed by reload, renewed admission/comparison and exact source preparation. Recovery reused 2,097,152 bytes and sent only the remaining 31,457,280 bytes; Android download independently SHA-256 matched |
| Oppo real camera                                             | Real video track opened, nonzero video dimensions observed and track ended on Stop camera; no frame artifacts saved/uploaded. This does not certify a physical optical QR scan                                                                                                                  |

The [basic run](evidence/phase-7-android-basic-run.json) records both 8 MiB successes; its overall invocation later failed a five-second reload assertion, so it is not presented as a fully passing multi-scenario run. The separate [recovery run](evidence/phase-7-android-recovery-run.json) passed the full 32 MiB app-switch/reload scenario; its later large-file assertion timed out waiting for source preparation before consent. Both are retained unchanged with their failure context. Focused large-file and lifecycle reruns are reported separately. Hardware-harness timeouts were extended for real rehash/source preparation; verification was not bypassed.

The [physical lifecycle/camera run](evidence/phase-7-android-lifecycle.json) passed both scenarios. The offline condition was injected on the actual phone's test target, not a physical Wi-Fi/subnet migration. The screen-lock/app-switch checks began from an explicitly paused committed checkpoint; active-hidden automatic pausing is separately covered by real-transfer browser lifecycle injection. Camera frames were consumed locally by the QR decoder; the evidence records dimensions and stopped-track state, not images. The artifact's scope label was clarified to distinguish saved images from the in-memory video stream; measurement values are unchanged.

The initial [320 MiB attempt](evidence/phase-7-android-large-initial.json) correctly required acknowledgement but remained active at the four-minute harness timeout. It is not counted as a successful complete/export result or a measured maximum file-size failure.

The focused [320 MiB rerun passed](evidence/phase-7-android-large.json): all 335,544,320 bytes were committed, verified, saved to Android Downloads, pulled by exact test filename and independently SHA-256 matched. It required the large-file acknowledgement. The [20-second progress observations](evidence/phase-7-android-large-progress.txt) show monotonically committed bytes while the real page remained visible. SHA-256: `d5c42f24fc06ebbcd7a9870eb30327f1cb417a640faebb591fe6062263a44e10`.

The complete test took 272,563 ms (about 4 min 33 sec), including acceptance, delivery/verification, native download, USB pull and independent hashing; this is not a wire-throughput benchmark. **320 MiB is an observed successful receive/export size on this Oppo, not a measured maximum or a guarantee for another phone.** No device disk was filled, and no new handset/RSS memory certification is claimed.

### Remaining gates and limitations

- **iPhone live demonstration now passed:** 1 MiB normal export and 2 MiB reload/recovery/export. Real OS lock/app switching, native source picker/share and installation remain uncertified on iPhone; 8 MiB exported bytes remain unverified.
- Android-to-iPhone and reverse roles now pass at 1 MiB. Native Windows Chrome and Mac Safari public 1 MiB receive/export also pass. Broader desktop/tablet reverse-role, recovery and size coverage remains unverified; all cloud attempts and limitations are recorded separately.
- Linux WebKit/Firefox cross-engine checks are real engine tests on Linux; they do not certify Apple's native Files/share UI or another OS.
- Mocked quota/full-destination and denied-permission tests validate failure behavior. They do not establish behavior on an actually full user's disk. No device is filled to create pressure.
- Camera API and synthetic QR roundtrip checks must be distinguished from a physical optical scan. Native sharing and PWA home-screen installation require their own OS observations before certification.
- Both peers need foreground availability and connectivity. Browser eviction, explicit site-data clearing, process termination and destination space may still prevent recovery/export.
- No unlimited iPhone, universal 10 GB, guaranteed background delivery, universal memory bound or production capacity claim is made.

The [browser/device matrix](../../tests/devices/browser-matrix.md) records scope without converting missing hardware into a pass. Later implementation through P9 exists; see the [full audit](implementation-audit-2026-10-21.md) for the remaining cross-phase acceptance debt.

## Secrets and repository state

Static/provider secrets remain only in ignored `apps/signaling/.env`, with mode 0600. `.env` variants and `.dev.vars` variants remain ignored at every depth, with empty-secret example exceptions only. P7 adds no provider secret. `MESHDROP_SIGNAL_ORIGIN` is a local server proxy setting; test-device identifiers and test destinations are optional tooling inputs. No secret belongs in `VITE_*`, source, reports or a commit. Runtime admission/signing credentials remain ephemeral and outside the shell cache and diagnostics exports.

## Reproduce and commit after review

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm bench:p7
```

Use the mobile runbook for opt-in physical Android and free cloud tests. The original P7 checkpoint command was:

```sh
git add .
git commit -m "feat: add phase 7 mobile and PWA hardening"
```

The original checkpoint did not assert an iPhone pass. For the current rollback/device-validation continuation, use the [P9 checkpoint commands](phase-9.md#reproduction-and-commit-command). No commit or push was executed by the assistant.
