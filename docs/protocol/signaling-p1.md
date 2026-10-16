# Phase 1 session and signaling contract

The Worker is the public entry point; each random UUID resolves to one SQLite-backed `SessionRoom`. Room IDs are locators, not authorization. The canonical P0 envelope remains unchanged; HTTP contracts are exported from `packages/protocol/src/signaling.ts`.

## HTTP

Every session route requires an exact allowlisted `Origin`; missing, `null`, wildcard and lookalike origins are rejected. JSON request bodies are limited to 8 KiB, checked while streaming even without Content-Length. Query parameters on session routes are rejected, including attempted credential queries. The development Vite proxy preserves browser Origin and supplies its trusted loopback origin for same-origin GETs that browsers send without Origin. Production's separate API origin receives normal browser CORS requests.

| Method/path under `/v1/sessions` | Proof/body                                                  | Result                                                                              |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| POST `/`                         | `{}`; edge creation limit                                   | 201: roomId, peerId, ownerCapability, inviteCapability, expiries, epoch, revision   |
| GET `/:id/status`                | Owner or local peer bearer                                  | Self admission/state/epoch/revision/expiry/nextSeq; only owner sees candidatePeerId |
| POST `/:id/join`                 | Invitation bearer; `{peerId, peerCapability}`               | 201 pending self-status; exact same peer/proof retry is 200                         |
| POST `/:id/decisions`            | Owner bearer; `{candidatePeerId, decision: approve/reject}` | Current owner status; repeating the same decision is idempotent                     |
| POST `/:id/ws-ticket`            | Approved owner/receiver bearer; `{}`                        | One-use ticket, expiry, epoch, nextSeq                                              |
| GET `/:id/ws`                    | Upgrade and subprotocol ticket                              | Authenticated WebSocket; no bearer query                                            |
| DELETE `/:id`                    | Owner bearer                                                | Room closed; invites/tickets revoked; existing sockets closed                       |

Pending/rejected candidates cannot mint tickets, approve peers, close rooms or enumerate the owner's peer ID. Decisions are final for that candidate. An invitation is consumed by its first admitted candidate; after rejection it is revoked. The owner creates a new room to invite another person. A third participant is denied. Owner DELETE is idempotent while the short closed-room tombstone remains.

Responses use `Cache-Control: no-store`, `X-Request-Id`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Allowed CORS responses echo the exact origin and vary on Origin; no wildcard/cookie authorization. Errors are `{code,message,requestId,retryable}` with bounded public messages. No input, bearer, SDP/ICE or file label is echoed to logs/errors. `/health` and `/v1/protocol` are read-only public diagnostic routes; there is no upload route.

## Ticket and socket admission

The browser offers `['meshdrop.v1', 'meshdrop.ticket.<opaque-ticket>']`; the server selects only `meshdrop.v1`. Ticket rows store only a verifier, peer ID, origin, room revision, epoch, expiry and consumption timestamp. A newer unused ticket replaces that peer's earlier unused ticket. Consumption and peer socket-generation increment occur in one SQLite transaction. Reuse, expiry, wrong origin/revision/epoch/room and pending admission are denied.

Only the newest socket generation for a peer can route events. Attachments retain peer ID, revision, epoch, generation, origin, last activity and violation count through hibernation; they do not contain bearer tokens. Every application message rechecks the current SQLite peer approval/generation, room expiry/revision/epoch and origin policy. Authorized membership changes refresh existing socket revisions; outstanding admission tickets require reissuance after a revision change.

Peers may send only `SDP_OFFER`, `SDP_ANSWER`, `ICE_CANDIDATE` and `RENEGOTIATE`. The room forwards them only to its other approved peer. Claimed room/peer/epoch must match admission. Client roles and server lifecycle events are never trusted. Server lifecycle envelopes use the recipient peer ID; forwarded signaling preserves the authenticated sender ID. The room persists a separate sequence for server events.

Client sequences strictly increase per authenticated peer and room epoch and survive reconnect/hibernation. Old/equal sequence numbers always fail. A bounded recent 128-message ID window also rejects ID reuse with a newer sequence. Messages consumed while the other peer is offline are not queued; the sender receives `PEER_UNAVAILABLE` and must negotiate again. P1 starts at epoch 0; P2 must add an authenticated epoch-advance/reconnection contract before creating fresh peer connections.

## Limits and lifecycle

Default room/invite/ticket lifetimes are 900/300/30 seconds; validated config caps are 3600/3600/60 seconds. Edge limits are 30 creates and 300 total requests per 60 seconds per hashed IP key and Cloudflare location. These distributed edge limits are approximate, not a global quota. Each room additionally enforces a persisted exact per-peer signaling window of 60 messages per 10 seconds. Three malformed/replayed messages close a socket; scope/epoch/rate violations close immediately. Binary signaling messages are rejected. Control byte caps remain those of v1.

The browser sends a lightweight ping every 25 seconds; the hibernation API auto-replies without executing the actor. Housekeeping uses auto-response timestamps plus stored activity to close sockets idle for two minutes. Alarms run at the earlier of room expiry or the next 30-second housekeeping point. Room expiry/revocation closes sockets and invalidates invites/tickets. A closed tombstone remains 60 seconds by default (configurable up to 300), then all four room tables are purged. Every request/message checks time independently of alarm delivery.

SQLite tables are only `room_meta`, `invites`, `peers`, `ticket_nonces`. There are no file bytes, block hashes, detailed filenames or stored SDP/ICE. Native rate-limit bindings prevent creating room actors before the edge gate passes. The P1 UI's signaling probe is harmless synthetic SDP text relayed through real authorized sockets; it does not perform WebRTC negotiation or transfer a file.

Implementation references: [hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), and [rate-limit bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
