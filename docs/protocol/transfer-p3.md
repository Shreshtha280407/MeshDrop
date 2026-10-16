# P3 verified streaming protocol v1

P3 implements correct, bounded, consented transfer on the P2 reliable ordered data channel. Cloudflare still receives only authorization/signaling traffic. File bytes, file names, manifests, block hashes and transfer receipts stay on the peer data plane or the user's device. No HTTP file route was added.

## Admission, identity and offers

Both devices independently compare the P2 code and explicitly confirm it. A signed, epoch/transcript-bound `PAIRING_CONFIRMED` control lets the other device observe that confirmation; approval or an open encrypted channel alone does not enable files. Each endpoint's local verified flag and remote confirmation must both be present. This is a cooperative application policy, not hardware attestation or proof of a person's name.

The owner offers 1–16 files. A manifest contains version 1, random transfer/file UUIDs, revision 1, 1 MiB block size, safe relative paths, file sizes, complete SHA-256 values and an exact total byte count. Total size is bounded at 64 GiB by the schema; the measured supported test size is 1 GiB, not a promise that every browser can store 64 GiB. Source hashes are computed incrementally in a dedicated worker before sending an offer. Manifest SHA-256 covers the normalized, strict schema output serialized as JSON in schema field order. The receiver recomputes it and checks the offer's transfer UUID.

Names are NFC-normalized at selection. Runtime validation rejects absolute/drive paths, traversal, empty/dot segments, backslashes, control/bidi characters, reserved Windows names, trailing spaces/dots, unsafe punctuation and excessive UTF-8 length/depth. Duplicate IDs and case-insensitive path collisions are rejected. Destination storage uses independently generated local keys and file UUIDs, never an untrusted path. Downloads suggest a validated basename; selecting an existing filename in the browser's own Save dialog remains an explicit user action.

A receiver must accept the particular offer and destination. Only then is the source allowed to send bytes. The implemented destination is **browser-temporary OPFS storage**. A small capability/API declaration is not proof of usable quota: storage preparation actually opens the destination first and fails visibly if permission, quota or browser mode prevents it. No data ACK is sent when preparation fails. Memory buffering of an entire file, direct-save picker integration and persistent checkpoint recovery are not fallback claims in P3.

## Signed controls

`{ control, signature }` uses the P2 canonical JSON/ECDSA P-256 signing mechanism. Every control includes version, roomId, peerId, epoch, transcript hash, UUID messageId, monotonically increasing sequence and transferId. The signed peer-message sequence is shared with ping and pairing confirmation messages, and signing/sending is serialized. The receiver validates sender identity, room, epoch, transcript, signature, sequence and the strict payload variant. Older epoch packets cannot advance transfer state. Text controls must fit both the 16 KiB control limit and negotiated message maximum.

Variants:

| Control             | Purpose                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `TRANSFER_OFFER`    | Strict manifest and manifest digest                                                     |
| `TRANSFER_ACCEPT`   | Exact manifest digest and `browser-temporary` destination                               |
| `TRANSFER_REJECT`   | Decline/unsupported/storage refusal                                                     |
| `BLOCK_START`       | File/block identity, expected byte count and SHA-256                                    |
| `BLOCK_ACK`         | Verified/flushed file/block digest plus cumulative committed bytes                      |
| `FLOW_STATE`        | Sender-specific pause boolean                                                           |
| `TRANSFER_CANCEL`   | User/connection/timeout/integrity/storage/invalid-data termination                      |
| `FILE_END`          | Source has finished this file's blocks                                                  |
| `FILE_VERIFIED`     | Complete stored-file SHA-256 and successful finalization                                |
| `TRANSFER_FINALIZE` | Request the terminal manifest-bound receipt                                             |
| `TRANSFER_RECEIPT`  | Immutable receipt UUID, epoch, manifest/files/digests, total, destination and timestamp |
| `RECEIPT_ACK`       | Acknowledge that exact receipt and manifest                                             |

## Binary DATA framing

P0's golden 64-byte DATA type 1 remains unchanged. Actual P3 transfer DATA **type 2** adds explicit fragment index/count using a 72-byte header. This makes the phase plan's fragment contract explicit without reinterpreting the historical fixture or changing its codec. Integers use network byte order.

| Byte offset | Field                           |
| ----------- | ------------------------------- |
| 0           | `MDP1` magic, uint32            |
| 4           | Wire version 1, uint8           |
| 5           | DATA type 2, uint8              |
| 6           | Zero flags, uint16              |
| 8           | Transfer UUID, 16 bytes         |
| 24          | File UUID, 16 bytes             |
| 40          | Connection epoch, uint32        |
| 44          | Logical block index, uint32     |
| 48          | Offset within the block, uint32 |
| 52          | Payload length, uint32          |
| 56          | Transfer frame sequence, uint32 |
| 60          | Zero reserved word, uint32      |
| 64          | Fragment index, uint32          |
| 68          | Fragment count, uint32          |
| 72          | Payload                         |

Default total message size is 16 KiB, including the header, so payload is at most 16,312 bytes. The actual ceiling is the negotiated preference/message maximum; P3 requires at least 1 KiB messages. Fragment count and offsets must exactly match the offered file size, block index and negotiated payload capacity. Zero-byte files have no DATA frames or block ACKs. Bad lengths, unsupported headers, invalid IDs, duplicates, gaps, inconsistent counts and out-of-bounds frames fail closed without overwriting another file.

## Bounded flow and hashing

Only one 1 MiB logical block is in flight. A worker reads one source block, computes its digest and transfers the ArrayBuffer to the scheduler. Frames are sent under a 512 KiB channel high watermark and 128 KiB low watermark using `bufferedAmount`/`bufferedamountlow`, with abort, close and stall handling. The next block cannot be read/sent until its exact storage ACK arrives. The receiver assembles at most one block. The peer adapter also caps queued incoming application data at 2 MiB and message count at 4,096. Controls and frame windows therefore do not grow with file size.

Incremental source/full-file hashing and block validation run in a dedicated worker using pinned `@noble/hashes`. Main-thread manifest hashing operates on small metadata only. The receiver validates a complete block, writes it at its exact offset through a worker-only sync access handle, awaits flush, advances its volatile in-session commit frontier, and only then sends `BLOCK_ACK`. Both endpoints' visible progress is committed bytes, never enqueued/sent bytes. The source requires the exact next cumulative count, file, block and digest before advancing.

After `FILE_END`, the receiver rereads the entire stored file in bounded 1 MiB windows, computes SHA-256 incrementally, checks the expected complete digest and size, awaits flush/close and obtains the finalized File. Corrupt or incomplete stored data cannot issue successful final verification. Files are exposed for download only after the terminal receipt handshake completes. Export uses a file-backed Blob URL, not `arrayBuffer()`/an accumulated whole-file JavaScript Blob.

## Lifecycle and terminal safety

P0 transfer reducers remain authoritative. Pause is independent for each participant; one endpoint cannot clear the other's pause. Bytes already in flight may finish committing. Pausing does not manufacture progress or completion. Abort stops worker/scheduler work and clears pending waits; cancellation and errors purge only the transfer's own temporary directory. An unanswered offer or active transfer times out; hashing/final verification have bounded longer timeouts. A new connection epoch aborts an unfinished P3 transfer. P3 does not resume across reconnect/reload.

The source sends finalization only after exact block ACKs and complete-file verification. The receiver generates one manifest-bound receipt only after all its files are verified and finalized. The source validates the receipt, acknowledges it, then reports complete; the receiver reports complete after that acknowledgment. Repeated file verification/finalization messages reuse existing results/receipt, exact repeated storage ACKs do not count bytes twice, and terminal controls cannot reverse a completed receipt. Disconnection before this exchange cannot be inferred as success.

A finalized receiver file remains downloadable after room revocation until Clear transfer/reset/disposal. Clear transfer explicitly removes its temporary files and revokes URLs. A browser crash/page close may leave orphaned private-origin files because there is no durable cleanup/checkpoint database yet. Persistent manifests, ledger reconciliation, reload recovery and retention/cleanup policy are P4. No universal physical-disk durability, background execution or malicious-peer storage attestation is claimed.

Sources: [File System Standard](https://fs.spec.whatwg.org/), [File API](https://www.w3.org/TR/FileAPI/), [WebRTC](https://www.w3.org/TR/webrtc/), [incremental SHA-256 library](https://github.com/paulmillr/noble-hashes).
