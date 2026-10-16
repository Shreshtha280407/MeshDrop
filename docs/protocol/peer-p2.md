# P2 peer connectivity and pairing contract

P2 implements six connectivity tickets from the supplied phase plan. Signaling remains the P1 authorized Worker/SQLite room plane; user-file transfer belongs to P3. Wire version remains 1, with additive server lifecycle variants.

## Connection epochs and signaling

Both approved peers must have current signaling sockets. Admission broadcasts `PEER_READY { ownerPeerId, receiverPeerId }`. The owner calls `POST /v1/sessions/:id/connection` with its Bearer capability and strict `{ expectedEpoch, mode }`, where mode is `new-connection` or `ice-restart`. SQLite compares and advances the current uint32 epoch atomically; the initial epoch must use a new connection. A pending peer, receiver, expired room, stale expected epoch or missing participant cannot advance it. A receiver requests reconnection by forwarding `RENEGOTIATE`; the owner performs the authorized compare-and-swap.

The actor invalidates old admission tickets, advances socket attachment epoch/revision and broadcasts `CONNECTION_EPOCH { epoch, mode, ownerPeerId, receiverPeerId }`. Existing authorized sockets remain usable. Signaling sequences stay monotonic across epochs. Every forwarded event retains the P1 room/member/epoch/sequence checks, including after hibernation. Old-epoch client events fail at the server; delayed older server events are ignored by the client. SDP/ICE is never persisted or queued on the server.

Only the owner creates offers and the single `meshdrop.v1` data channel. It is ordered and fully reliable: no `maxRetransmits` or `maxPacketLifeTime`. The receiver accepts one channel with the exact label/protocol/settings. Browser sessions validate signaling identity, SDP role, duplicate descriptions and epoch. An epoch-local ICE manager queues at most 64 remote candidates until remote SDP is applied. Local candidates follow the local description; candidate username fragments prevent old gathered candidates being sent under a fresh ICE epoch. No media devices or permissions are needed.

States use the P0 peer reducer: idle → signaling → checking → connected, with reconnecting/closed paths. A 25-second unanswered handshake times out and closes its transport; there is no infinite retry loop. ICE restart reuses an open stable peer connection/channel with new ICE credentials and identity handshake. If reuse is unavailable, request a new connection. A new connection closes the old channel/peer connection. Both modes require a strictly newer server epoch. Signaling loss, local room closure or revocation closes the cooperative browser's WebRTC transport. A signaling server cannot forcibly destroy an independently running connection between malicious clients.

## Signed identity handshake

Each epoch generates a non-extractable ECDSA P-256/SHA-256 private key and a fresh random 32-byte nonce. Each peer sends a strict signed `HELLO` on the encrypted data channel containing version, roomId, peerId, epoch, role, nonce, raw public key, SHA-256 DTLS fingerprint and feature capabilities. The signature covers canonical JSON with lexicographically sorted object keys and preserved array order. Public keys/nonces/signatures use unpadded base64url. Fingerprints are lowercase hex. The hello's signature is verified and its DTLS fingerprint must equal the fingerprint in the applied remote SDP; room, member, role and epoch must match independently supplied admission context.

The pairing transcript is SHA-256 of canonical `{ domain: 'meshdrop-pairing-v1', owner: ownerHello, receiver: receiverHello }`. Both peers therefore display the same 256-bit fingerprint and its first 64 bits as `XXXX-XXXX-XXXX-XXXX`. This is an account-free comparison protocol, not a certified human identity system or a formally audited authentication protocol. A compromised browser, application origin or dependency is outside its protection.

The UI starts **unverified**. A user must enter the code observed on the other device and explicitly confirm comparison in person or over a separate trusted channel. Matching server-mediated invitation codes do not qualify. Mismatch/rejection closes the connection and shows mismatch. Verification is local to the confirming device, never inferred for the remote user. Every new epoch clears it and derives a new code. Automated tests exercise this workflow; they do not attest to a real person's identity. Before sensitive transfer, independent comparison remains the user's decision.

## Capabilities and signed ping/pong

The strict hello advertises `protocolVersion`, `preferredFrameBytes`, `maxMessageBytes`, `supportedHashes`, `storageModes`, and `resumeMode`. Current sessions honestly offer memory only and resume unavailable; OPFS/direct-save/persistent recovery are not implemented yet. Frame ceilings take the minimum of both peers' preferred/message limits and the 16 KiB protocol ceiling, including the 64-byte DATA header. The local offer also accounts for SCTP `maxMessageSize`. SHA-256 support and a compatible storage mode are required.

Signed `PING` and `PONG` carry version, type, roomId, peerId, epoch, transcript hash, UUID messageId and monotonic seq. Signatures use the authenticated hello key. The receiver checks all context, signature, sequence and PONG correlation. A signed-message replay fails closed; older epoch packets are discarded. Control messages are capped at 16 KiB UTF-8, outgoing pings and browser buffering are bounded, and signing/sending is serialized so asynchronous cryptography cannot reorder sequences. File bytes and acknowledgments are not part of P2.

## ICE configuration and privacy

`POST /v1/sessions/:id/ice-credentials {}` requires an approved member in an approved, active room. Response: `{ iceServers, relayAvailable, expiresAt }`, no-store, with existing Origin/TLS/request throttles. Public STUN endpoints are configurable through `STUN_URLS`. With optional coturn REST configuration, username is `expiryUnixSeconds:randomUUID` and credential is `base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`. TTL defaults to 300 seconds, is capped at 600 and room expiry. A new request mints fresh credentials for each approved peer/epoch; these credentials authorize relay service until their TTL, not immediate per-room revocation at coturn. Relay quotas and production abuse controls still belong to deployment/hardening.

`TURN_URLS` and a server-only shared secret must be configured together; malformed/partial configuration fails closed. Disabled relay returns `relayAvailable: false`, never fake credentials. This implements coturn-compatible TURN REST, not Cloudflare's managed TURN credential API. The default Cloudflare endpoint is used only for STUN.

`getStats()` inspection returns only direct/relay/unknown, candidate categories and UDP/TCP. It does not expose addresses, ports, raw candidate strings, SDP or relay passwords in UI/events/evidence. No throughput, loss or route-quality claims are made in P2.

Sources: [W3C WebRTC](https://www.w3.org/TR/webrtc/), [RFC 8831 data channels](https://www.rfc-editor.org/rfc/rfc8831.html), [coturn REST authentication](https://github.com/coturn/coturn/blob/master/README.turnserver), [Cloudflare STUN endpoints](https://developers.cloudflare.com/realtime/turn/).
