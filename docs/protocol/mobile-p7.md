# Phase 7 platform and export contract

The supplied P7 plan adds browser policy around the existing P3–P6 protocol. Room admission, signed pairing, storage-committed ACKs, checkpoint verification and authenticated missing-block recovery keep their existing wire formats. There is no mobile file-upload endpoint.

## Usable capability result

`probeCapabilities()` reports secure WebRTC, OPFS, IndexedDB, exclusive access, estimated free browser space, persistent storage, save/file picker presence, camera permission, file sharing, service worker support and browser/standalone mode. OPFS is tested in a dedicated worker with a one-byte synchronous write, flush and readback. IndexedDB commits a temporary transaction; Web Locks acquires a unique temporary lock. Probe files/databases are scoped to random names and removed. A five-second worker deadline produces unavailable storage. Camera detection does not request permission.

This small probe proves neither durability nor a maximum file size. API presence remains separately visible in the P0 workbench. Permission, browser mode, storage eviction, runtime quota and OS export behavior can still prevent a transfer.

## Receive policy

New offers require usable OPFS, IndexedDB and Web Locks plus secure WebRTC. Before consent, the UI explains the selected `opfs-checkpoint` strategy or the reason it is unavailable. Consent rechecks capabilities and current quota. The storage engine independently enforces quota before allocation.

Known free space must cover the offer plus the larger of 4 MiB or 10% headroom. Missing, rejected or malformed estimates are unknown, distinct from zero: new offers above 64 MiB are blocked, and smaller offers need explicit acknowledgement. Offers from 300 MiB also need acknowledgement. These thresholds are product safeguards, not measured platform maxima. Runtime quota errors keep existing verified checkpoints under the chosen retention policy. Browser quota does not measure the free space at an external save destination.

## Export and transient activation

Only finalized, hash-verified files reach `FileExportControls`. Download uses a named file-backed object URL, retained until component disposal. Choose-location save is conditional on `showSaveFilePicker`; it opens the picker directly in the click handler, then streams to the destination. A successful close permits a finished-writing message. Cancellation or a destination failure preserves the verified browser copy.

System share is shown only when `navigator.canShare({files})` accepts the particular named file. `navigator.share()` runs directly in the click handler. Returning from the share sheet means the system flow returned; it does not prove a copy exists in Files. Cancellation does not trigger a second native dialog. No whole-file `arrayBuffer()` conversion is used for these adapters.

Saved transfers use two actions: Export saved first asks the storage worker to revalidate and prepare the file; a subsequent Save/Share/Choose-location click retains fresh user activation. Safari is never assumed to implement `showSaveFilePicker`. Download/share are offered according to capability, with explicit limits. Physical iPhone export still requires real-device acceptance testing.

## Suspension and recovery

Hidden pages pause active delivery where possible, including an offer that becomes active after the page was hidden. In-flight work may settle. Returning does not automatically unpause. `pagehide`, `freeze` and offline events close transport and preserve scoped resumable data. Hidden/suspended pages suppress automatic retries. Returning online in the foreground permits connection recovery; a broken transport still needs a fresh pairing comparison and authenticated resume. A reload loses room credentials but rehashes surviving saved blocks; renew admission and prepare the exact original source before reuse.

Visibility callbacks are best effort. OS process termination may provide no callback. No background transfer guarantee follows from installing a PWA. See the [Chrome lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

## QR privacy and PWA boundary

The invitation QR is hidden by default. Encoding and camera decoding run locally using the pinned ZXing browser bundle. It is loaded from this origin, with SRI, MIT license and provenance under `apps/web/public/vendor`. Scanning validates the invitation's origin and format and only fills the input: room approval and code comparison are still required. Camera tracks stop on success, cancel, hiding/page exit and disposal. No QR-generation service or camera-frame upload exists.

The production service worker precaches only an exact list of public shell assets: root HTML, hashed bundles/workers, manifest, icons and the local QR library. Queries, non-GET, authorization/range requests, foreign origins and all API routes bypass its cache. Exact public assets use network first with a cache fallback. The fallback ignores `Vary` because module fetches and precache fetches can differ in their Origin header; this applies only to the fixed public asset list, never private responses. File data stays in the existing OPFS/IndexedDB store, outside the service worker cache.

Updates wait. Applying an update is an explicit action, disabled while this tab has an open room; the UI asks the user to finish other transfer tabs first. The worker retains the current and one previous shell cache. Offline reload can recheck and export surviving local files. Pairing and delivery still require connectivity and active peers. Development mode does not register the production shell worker. Service workers are not a WebRTC delivery daemon; see the [service worker specification](https://www.w3.org/TR/service-workers/).

## Platform evidence

WebKit's [OPFS implementation note](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/), [storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) and [user activation explanation](https://webkit.org/blog/13862/the-user-activation-api/) inform the capability-based approach. The [Web Share specification](https://www.w3.org/TR/web-share/) and [File System Access specification](https://wicg.github.io/file-system-access/) inform native export boundaries. Actual results and missing hardware gates are tracked in the [device matrix](../../tests/devices/browser-matrix.md), not inferred from API support tables.
