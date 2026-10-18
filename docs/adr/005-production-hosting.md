# ADR 005: same-origin Pages gateway and isolated signaling Workers

**Status:** accepted; public preview deployed. Production and remaining release
acceptance are pending.

MeshDrop already uses Cloudflare-native SQLite room actors and WebSocket
hibernation. Host its React build on Pages and route control traffic through a
small module Worker using a service binding to an independently deployed signaling
Worker. File data continues directly over WebRTC. No traditional account database
is required. This preserves the tested actor semantics and same-origin CSP,
invitations, fetch and WebSocket URLs.

Preview and production are separate Pages projects and Worker names, with explicit
bindings, exact origins and independently generated operator/TURN secrets. Stable
environment URLs are supported; arbitrary Pages aliases are rejected. The gateway
sets security headers itself because static `_headers` rules do not cover Function
responses. The signaling Worker has no direct public route.

The tradeoff is an extra Function invocation for every gateway request, including
assets, and a sequential two-product rollout. Monitor quotas and retain matching
release IDs for rollback. Durable Object code rollback cannot undo SQLite changes.
Vercel/Railway/Neon would require a separate backend/storage migration to preserve
the same room and socket contracts; that migration is outside this deployment
phase. TURN remains a separately provisioned relay with a separate budget.
