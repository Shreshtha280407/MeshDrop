# MeshDrop threat model — P0

Review date: 2026-10-16. Scope: contract/boundary review against both supplied plans, not an independent penetration test. Future controls remain unimplemented until their named phase passes.

Assets: capabilities, peer identity, room isolation, file bytes, checkpoint integrity, local capacity, diagnostics and addresses. Attackers include unauthenticated callers, leaked-invite holders, malicious approved peers, compromised signaling and stale/replayed clients. Local corruption and eviction are also threats to correctness.

| Threat / boundary                | Required control                                                             | P0 evidence / later gate                            |
| -------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| Guess/leak invite → Worker       | Expiring random capabilities, verifier storage, referrer minimization        | ADR-002; actual tests P1                            |
| Unapproved/third peer → room     | Owner approval, capacity, room-bound roles                                   | Illegal lifecycle tests; authorization P1           |
| Cross-room/stale socket → peer   | Membership, epoch/revision checks, one-use tickets, hibernation revalidation | UUID/epoch schemas only; enforcement P1/P2          |
| Signaling impersonation → P2P    | Ephemeral keys, independent code comparison                                  | ADR-004; mismatch tests P2                          |
| Replay/duplicate → engine        | Epoch, sequence, idempotency key                                             | Strict fields/reducers; replay caches P1/P3/P5      |
| Huge/malformed → parser          | Pre-parse UTF-8 cap, strict bounded variants/frames                          | Negative tests P0; fuzz/throttles P8                |
| File data → cloud                | No upload route; schemas exclude file payload                                | Worker upload rejection; forwarding/log audit P1/P8 |
| False success → receiver         | ACK after hash/write/checkpoint; final hash/export                           | Reducer guards P0; real evidence P3/P4              |
| Corrupt checkpoint → recovery    | Re-hash identity and blocks                                                  | ADR-004; reopen/reselection P4/P5                   |
| Path traversal/conflict → export | Untrusted labels, normalized safe paths                                      | No export P0; filename tests P3/P8                  |
| Disk exhaustion → storage        | Quota preflight, bounded buffers, failure/purge                              | Honest API presence P0; write failures P4/P7        |
| Secrets/SDP/IP/labels → logs     | Redaction, no routine upload                                                 | Parser errors hide input; log audit P1/P6/P8        |
| Suspension → user                | Lifetime limits, truthful recovery                                           | No background promise; actual phones P7             |

P0 review: no upload/authentication backdoor is exposed; shared contracts are independent of framework/runtime code; completion is guarded at the lifecycle boundary. Production requires HTTPS/WSS; local loopback is permitted for development.

P1 adds tested capability admission, owner approval, two-peer isolation, single-use origin/revision/epoch-bound tickets, per-message membership/sequence checks, stale-socket generations, alarm expiry and row cleanup. Actual hibernation eviction verifies restored authorization. All raw capabilities remain outside SQLite and logs. See the [P1 signaling contract](protocol/signaling-p1.md) and [secret handling](security/secrets.md). P2 adds signed, DTLS-bound ephemeral identity handshakes; independently compared pairing fingerprints; authenticated epoch changes; bounded ICE queues; signed ping replay rejection; and temporary TURN credentials. Physical Oppo Chrome direct-path and forced local TURN tests are documented in the [P2 report](reports/phase-2.md). File integrity, persistent recovery, hostile-network deployment and the remaining physical OS/browser matrix remain later gates. A matching code proves a shared transcript only after an independent comparison; it does not name a person or protect a compromised browser/application origin.
