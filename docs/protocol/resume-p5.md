# P5 authenticated, receiver-owned resume

P5 preserves stable transfer/file IDs and the strict v1 manifest (revision, file paths/sizes/full SHA-256, 1 MiB block layout). Resume uses fresh room authorization, an admitted connection epoch and newly compared pairing codes. It never recovers an invitation, capability, ticket or signing key from disk. Both peers must return online with surviving receiver storage and exact sender source access.

## Components and trust boundary

`packages/recovery` owns bounded range validation/complements, deterministic checkpoint digests, epoch validation, retry policy, source ID mapping and the pure `ResumeMachine`. `TransferMachine` integrates that handshake with the signed peer transport and existing streaming/receipt engine. Hashing and file access stay in dedicated workers. `RoomClient` owns browser admission/reconnect scheduling; React renders state and explicit source/receiver actions.

Every resume control uses the existing signed envelope: room ID, sender peer ID, epoch, transcript, message ID, sequence and transfer ID. `PeerSession` checks membership, current transcript, ECDSA signature, fresh sequence and bilateral code confirmation before dispatching it. Strict schemas alone do not authenticate. Old epochs are ignored, including old DATA still draining during an ICE restart. Future or invalid contexts fail closed. The transfer engine additionally deduplicates message IDs and enforces the active resume attempt UUID, page and phase.

After reload or expiry, create a new room, request/approve admission and independently compare both new codes. This verifies a newly authorized human peer and content identity; it is not persistent cryptographic identity or proof that the same physical device returned. A compromised origin/profile is outside the local-storage trust boundary.

## Resume exchange

The owner first prepares the original source. Reopening maps selected files to the original IDs, checks basename/size and recomputes every full-file SHA-256 in a worker. Wrong content fails even with identical filename/size. A live reconnect can reuse the still-accessible `File` objects, but rehashes them again. Reload requires explicit reselection; stored manifests contain no filesystem permission or file bytes.

The receiver explicitly resumes its saved transfer. Its worker takes the exclusive store lock, validates the strict manifest/digest and retention, then rereads/re-hashes all ledger-backed blocks. Missing, truncated, changed, out-of-bounds and uncertain rows are discarded. Surviving complete files also undergo full-file verification. It recreates missing scoped files and refuses writes over blocks selected for reuse.

1. **RESUME_HELLO:** receiver sends attempt UUID, manifest digest and a digest of its complete revalidated proof set.
2. **MANIFEST_CONFIRM:** prepared sender returns the exact original manifest and the same attempt/digest binding. The receiver rejects any identity/layout change.
3. **HAVE_RANGES:** receiver sends up to 32 `{fileId, index, digest}` proofs per page. Each page is scoped and ordered; non-final pages contain exactly 32 entries. Empty progress uses one empty final page. A proof identifies a single-block inclusive range.
4. **NEED_RANGES:** sender rereads each corresponding source block, hashes it and returns the rejected offsets within that proof page. Both sides accumulate the same accepted set. The next HAVE page is sent only after this response. Absent blocks plus rejected proofs define the requested complement of the accepted set within the manifest. No unbounded range list/control message is needed, including fragmented checkpoints.
5. **RESUME_ACCEPT:** receiver removes rejected ledger rows, persists the new binding and accepted checkpoint digest, then returns that digest and reused byte count. Sender verifies the original proof-set digest, accepted digest, reused count and final-page completion before sending data.

At most one proof page is outstanding. Signed controls remain below the negotiated 16 KiB limit for the supported transfer frame capability. A prepared source is required: `RESUME_UNAVAILABLE` stops the receiver attempt with a visible instruction to prepare the original files; local data stays retained and a manual retry may use the still-unaccepted epoch. Completed handshakes cannot be silently repeated in the same connection.

The checkpoint digest is SHA-256 over a domain-separated manifest digest and proofs sorted by file UUID then block index. Each proof contributes file ID, index and digest with explicit delimiters. The protocol validates IDs/digests and bounds before use. The digest binds an agreed snapshot, not an assertion that a browser cannot lose storage later.

## Persistence and epoch scope

The P4 IndexedDB schema remains version 1 with backward-compatible optional transfer fields. `checkpointDigest` is recomputed from rehashed rows during reconciliation, and invalidated when new blocks commit. `lastResume` contains only `{roomId, epoch, attemptId, checkpointDigest, reusedBytes}`. It is committed before RESUME_ACCEPT; same-room reuse requires a strictly greater epoch. A different, freshly authorized room starts its own server-controlled epoch namespace. Old room controls cannot cross that boundary because signatures, membership, transcript and scope must all match.

No credential/private key is in these fields. An existing P4 record can resume without migration. If a process dies after binding but before the peer sees acceptance, reconnect on a fresh epoch and revalidate again; do not roll back to an older admission. OPFS/IDB commit ordering and API-level durability limitations remain in the [P4 contract](storage-p4.md).

## Data and completion

The accepted set initializes both peers' confirmed progress. The sender skips every accepted block, sends only the complement and retains the original one-block ACK window/backpressure. Receiver block admission advances over reused ranges, including gaps in a file and fully reused files. New ACKs still follow readback SHA-256, flush and strict ledger transaction completion. Progress can fall after discovering damaged/missing/unauthenticated stored blocks; counters never promote such blocks to reused progress.

Every file still requires full stored-file SHA-256 and FILE_VERIFIED. Empty files, fully reused files and the final-block/receipt interruption all pass through finalization. The terminal receipt is scoped to the current epoch; completion needs the existing receipt/acknowledgement and local receipt persistence. An old receipt is not used to shortcut a resumed finalization.

The UI separates reused verified bytes from payload sent in the current attempt on the source, and payload committed in this attempt on the receiver. The source counter counts emitted DATA payload bytes, excluding binary headers, proof/control traffic, ICE/DTLS/SCTP overhead and transport retransmissions. It is not a wire-byte meter or public-network throughput benchmark. On a successful missing-only run it equals total file bytes minus reused bytes. Initial/local-revalidation counts are separate from the eventual source-authenticated reuse decision.

Identical message IDs are idempotent at the engine boundary. A signed replay with a new sequence but an out-of-order page, attempt or closed handshake fails without editing previously accepted ledger data or creating completion. The surrounding peer signature/sequence checks reject ordinary wire replays earlier. Explicit cancel is terminal and deletes scoped local bytes/metadata; interruption/retry preserves the selected retention policy. Cancellation cannot delete an offline remote browser's local data.

## Recovery scheduling and limits

When both room authorizations survive, owner reconnect first tries ICE restart. Failed/unavailable restart falls back to a new peer connection. Signaling reconnect consumes a fresh socket ticket; the owner remains epoch authority. Delays are 1, 2, 4, 8 and 16 seconds, at most five automatic attempts, with connection timeouts between attempts. A ready peer or explicit manual retry resets the budget. A fresh pairing comparison is still mandatory; reconnect never starts sending files on its own. Receiver signaling can reconnect independently and otherwise waits for the owner. Code mismatch and explicit cancellation suppress further automatic retries.

Expiry/revocation stops reconnect and keeps retained data available for a fresh authorized room. Browser eviction, denied/private storage, source disappearance, OS/process suspension and user-cleared data can prevent resume. This is foreground recovery, not background delivery. It promises neither iOS background persistence nor unlimited file sizes.

Primary browser APIs: [WebRTC restartIce and connection state](https://www.w3.org/TR/webrtc/), [File System Standard](https://fs.spec.whatwg.org/), [Web Locks](https://www.w3.org/TR/web-locks/).
