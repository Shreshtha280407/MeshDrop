# P4 local storage and checkpoint contract

P4 replaces P3's volatile temporary destination with OPFS bytes and an IndexedDB ledger. The signed P3 wire protocol, one-block flow window and `browser-temporary` destination value remain compatible: this is still origin-local browser storage subject to eviction. Files, names, manifests, block digests, source metadata and receipts stay on the device. Room credentials and ephemeral signing keys remain memory-only. A restored local checkpoint does not restore network admission. P5 now adds the [authenticated resume exchange](resume-p5.md) after fresh admission and pairing.

## ReceiverStore and identity

`ReceiverStore` defines `prepare(manifest, options)`, `writeBlock(fileId, index, bytes)`, `readBlock(fileId, index)`, `commitBlock(fileId, index, digest)`, `finalize(fileId)`, `purge(transferId)` and `close()`. The worker-only `OpfsReceiverStore` implements these operations. The live transfer worker delegates storage to this package; React does not own file buffers or database transactions.

Strict P3 manifests, UUID file IDs, exact block lengths and SHA-256 remain mandatory. OPFS paths are `meshdrop-receiver-v1/<validated transfer UUID>/<locally generated storage UUID>/<validated file UUID>`. Peer labels never select filesystem paths. `prepare` refuses an existing transfer ID, acquires an exclusive Web Lock, commits discoverable manifest/transfer metadata, then creates its own files. A partial preparation is recoverable as an empty/incomplete checkpoint. File writes never target another transfer's slot.

Each live/recovery store holds `meshdrop-store:<transferId>` exclusively. Recovery and deletion fail visibly while another tab owns it. Worker termination releases the lock; the live adapter briefly allows that release before user-directed cleanup. OPFS sync access handles additionally protect file writes. Browsers without the required storage/locking APIs fail closed.

## IndexedDB schema version 1

Database: `meshdrop-checkpoints-v1`. Readwrite transactions request `durability: strict` and resolve only at transaction completion. Crypto/OPFS awaits stay outside IDB transactions.

| Object store | Key and content                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifests`  | Transfer UUID; strict normalized manifest, file IDs/paths/sizes/full digests                                                                                                 |
| `transfers`  | Transfer UUID; schema version, manifest digest, block size, storage key, created/updated/expiry timestamps, retention, state, finalized file IDs, optional completed receipt |
| `blocks`     | Compound `[transferId, fileId, index]`; exact byte count, authenticated in-session digest reference, commit timestamp; transfer index                                        |
| `sources`    | Source transfer UUID; manifest/digest/expiry only, never a persisted File, permission, signing key or room capability                                                        |

Verified ranges are compact inclusive `[first, last]` pairs derived from valid block rows after reopening. Cached byte counters/booleans are not trusted checkpoint evidence. `Checkpoint` includes transfer/manifest identity, schema version, block size, storage key, timestamps, per-file ranges/verified counts, discarded-row count and verification time. Source manifests enable later exact reselection but do not preserve filesystem access.

## Commit ordering and crash windows

Only one block is pending. The receiving worker performs:

1. Write all block bytes at the exact manifest offset, handling partial writes.
2. Reread that block in a bounded buffer and check its SHA-256 against the signed sender digest.
3. Await sync-handle flush where the browser provides it.
4. Commit the block row and transfer timestamp/state together in one strict IDB transaction; await completion.
5. Return ACK eligibility to `TransferMachine`, which advances confirmed progress and sends `BLOCK_ACK`.

OPFS and IndexedDB do **not** share a transaction. A crash before metadata commit leaves unconfirmed bytes; a crash after metadata commit but before the ACK can leave a valid recoverable block the sender has not counted. Neither case implies false completion. An aborted IDB transaction rolls back its block and transfer metadata together.

Startup runs `LedgerReconciler` in a local worker. It checks schema/manifest digest, validates file/block bounds, rereads and rehashes every ledger-backed block, removes missing/corrupt/out-of-bounds rows, and excludes all unledgered bytes. It trims uncommitted tails. Fully present files also need the complete manifest SHA-256 before being exposed for export. Receipt state survives only when its finalized files remain valid. Reconciliation records compact verified ranges; it sends no new file data and does not contact the signaling plane. Permission/locking errors leave evidence intact and show an unavailable reason.

Flush/strict durability are browser API requests, not proof against physical power loss, a compromised origin or user-cleared storage. Stored digest references were authenticated during the original session; P5 must independently bind them to the returning peer/manifest before requesting network resume.

## Quota, retention and cleanup

Acceptance preflight estimates free space with a 4 MiB margin, reports unknown capacity and large-file/eviction warnings, and actually opens storage before accepting data. The user may request persistent storage; denial remains visible and does not become a recovery guarantee.

A mid-block `QuotaExceededError` withholds ACK/progress for that block, preserves prior valid ledger rows, retains only that pending block in the worker, and sends a flow pause. Free space then Retry storage retries write/verification/flush/ledger before ACK and clears the pause. The sender does not proceed to the next block while waiting. Closing the page loses that pending in-memory retry, while earlier committed blocks remain recoverable. P5 will request missing bytes again.

The receiver explicitly chooses 24 hours (default), 7 days, or discard on interruption/reopening. Retention is measured from the last committed block; completed browser copies also expire under that policy. Cancel/Clear explicitly deletes scoped receiver data, while interruption/failure preserves it under the selected policy. Expiry is enforced when the app next opens/checks storage; there is no background cleanup promise. Source manifest retention defaults to 24 hours and can be forgotten separately.

Deletion commits a `deleting` tombstone before removing OPFS, then removes manifest/block/transfer rows. Startup retries a surviving tombstone. Orphan collection is limited to valid UUID directories inside this package's namespace, takes the same exclusive lock and rechecks IDB before removal. It never touches unrelated origin files. Legacy P3 temporary directories have no retention metadata and are not silently migrated/deleted by P4 startup; clear old data explicitly if needed.

## Finalization, export and source reselection

Finalization checks complete ledger coverage and rereads full stored-file SHA-256 before a file is finalized. The receiver persists the completed receipt only after processing P3's receipt acknowledgement, before showing completion. Reopening revalidates bytes rather than trusting that old success marker. A fully verified individual file may be exported from an interrupted multi-file checkpoint without claiming that the whole transfer completed.

`SaveAdapters` uses a file-backed Blob URL with a validated basename. Live and recovered exports avoid assembling an entire file in JavaScript and do not require a universal save picker. The browser handles destination/collision prompts. Partial files are not offered as verified downloads. Exported copies are outside later origin cleanup.

Source reselection checks basename, size and the entire SHA-256 off the UI thread. A same-name/same-size wrong file is rejected. Matched File access remains in that page's worker session only; the manifest survives within its retention window. P5 owns reconnect authentication and missing-range transport.

Primary API references: [File System Standard](https://fs.spec.whatwg.org/), [IndexedDB](https://w3c.github.io/IndexedDB/), [Web Locks](https://www.w3.org/TR/web-locks/).
