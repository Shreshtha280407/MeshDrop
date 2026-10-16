# ADR-002: One SQLite-backed Durable Object per room

Status: accepted in P0; implemented and validated in P1, 2026-10-16.

Each random room UUID will address a single SQLite-backed Durable Object. The actor serializes admission, two-peer capacity, approval, revocation, ticket consumption, revision, expiry and socket membership. SQLite contains only `room_meta`, `invites`, `peers`, and `ticket_nonces`, with verifier forms of secrets. No global user database is needed.

Worker routing must authenticate before forwarding operations; the actor must enforce role/room/epoch association again. A locator UUID is never permission. Hibernation attachments and alarms must rehydrate and revalidate current authorization, not revive stale access. P1 must test expiry, replay, third peers and cross-room routing.

P0 shipped a scaffold. P1 implements the four SQLite tables, room-scoped role checks, verifier-only credentials, hibernatable sockets, alarms and edge/per-peer throttles. No global signing key is needed. Deployment remains deferred; local Miniflare and Wrangler run the real control plane without a cloud account.
