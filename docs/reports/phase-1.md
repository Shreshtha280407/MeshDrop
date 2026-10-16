# Phase 1 completion report

Date: 16 October 2026. Status: **complete — P1 exit gate passed locally**. Scope: signaling server and room authorization, following the supplied architecture and phase-wise implementation PDFs.

## Delivered against the phase tickets

| Ticket | Delivered implementation                                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.1   | Worker routing with generated request IDs, exact origin/CORS policy, HTTPS outside loopback, strict request schemas, streamed 8 KiB body caps, safe typed errors and edge throttles. Missing/malformed proof is rejected before allocating a room actor.                                  |
| P1.2   | One SQLite-backed `SessionRoom` per random room UUID. Four tables persist room state/revision/epoch/expiry, invitation verifiers, peers and ticket nonces. The SQLite migration is configured in Wrangler.                                                                                |
| P1.3   | Random 256-bit owner/invitation credentials and a separate random local receiver credential. SQLite contains only domain/room/peer-scoped SHA-256 verifiers. No raw capability, ticket, SDP, ICE candidate, detailed filename or file data is persisted.                                  |
| P1.4   | Invitation → pending candidate → owner approve/reject. A room contains one owner and at most one receiver. Exact join and decision retries are idempotent. Third users, guest decisions and cross-room credentials are denied. Rejection revokes the consumed invitation.                 |
| P1.5   | Short-lived single-use WebSocket tickets bound to peer, room revision, epoch and exact origin. Atomic ticket consumption and socket-generation replacement; per-message approval, room, peer, epoch and replay checks. Only approved opposite peers receive SDP/ICE/renegotiation events. |
| P1.6   | Owner revocation, timed room expiry, alarm housekeeping, stale socket checks, persisted per-peer rate windows, hibernation attachments and cold-runtime rehydration. Closed room tombstones are purged with all peer/invite/ticket rows after retention.                                  |

The React application now uses these real APIs and sockets. It supports room creation, private invitation copying, candidate requests, owner approval/rejection, pending/connected/error states, manual signaling reconnect, a harmless signaling probe, and room revocation. The historical P0 synthetic workbench remains separately labeled at `/foundation`.

## Secret handling requested by the user

- Static server/provider secrets belong in ignored `apps/signaling/.env`; a public-default-only `.env.example` is committed. The local `.env` has mode 0600.
- Git ignores `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*` and `.aws/`, including nested paths. `.env.example` is the only environment-template exception.
- `pnpm check:secrets` checks ignore coverage, tracked/unignored environment files, and common embedded credential/private-key patterns. The check is included in `pnpm check` and CI.
- P1 needs no global API/signing key. Session capabilities are generated at runtime, retained in browser memory and represented in SQLite only by scoped verifiers. No secret is placed in a frontend `VITE_*` variable or Wrangler `vars`.
- Invitations use URL fragments, which are promptly removed from browser history. WebSocket tickets use the handshake subprotocol rather than query strings. Logs/event views omit bearer values and SDP/ICE. Live browser network traces are disabled and saved invitation screenshots are masked.

See [secret handling](../security/secrets.md) for the exact policy and the scope of the preventive scanner.

## Contracts and operational defaults

HTTP routes are `POST /v1/sessions`, `GET /v1/sessions/:id/status`, `POST /join`, `POST /decisions`, `POST /ws-ticket`, `GET /ws`, and `DELETE /v1/sessions/:id`. Status exposes only the caller's admission; the owner may also see the candidate ID. Signaling supports JOINED, pending/approved/rejected events, SDP offer/answer, ICE, renegotiation, room closure and typed errors.

Defaults: room 900 seconds, invitation 300 seconds, admission ticket 30 seconds, closed tombstone 60 seconds. Edge limits are 30 room creations and 300 total requests per 60 seconds per hashed address key/location. Each peer additionally has a persisted 60-message/10-second signaling window. Three malformed/replayed messages close a socket; scope/epoch/rate violations close immediately. Idle sockets expire after two minutes, with browser heartbeats and 30-second housekeeping.

Client sequences survive socket replacement and hibernation; duplicate/old sequences are rejected, with an additional bounded 128-message ID window. The current room epoch is 0. Socket attachments carry authorization context, and every application message reads current SQLite state. No file payload queue or cloud file store was added.

The [P1 wire/API specification](../protocol/signaling-p1.md) describes role checks, ticket admission, idempotency, limitations and expiry semantics in full.

## Verification and evidence

| Gate                    | Final clean-run result                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Frozen installation     | Passed with `--frozen-lockfile --offline`; 227 packages restored from the external cache. |
| `pnpm -r typecheck`     | All ten app/package targets passed.                                                       |
| `pnpm typecheck`        | Root tests/tools/configuration passed.                                                    |
| `pnpm lint`             | ESLint and formatting passed.                                                             |
| `pnpm check:secrets`    | Environment ignore coverage and embedded-credential checks passed.                        |
| `pnpm test:unit`        | **217 passed**, including P0 contracts and P1 HTTP schemas.                               |
| `pnpm test:integration` | **33 passed**, actual workerd/SQLite/network WebSockets.                                  |
| `pnpm test:faults`      | **8 passed**; additional real room/socket faults are in integration tests.                |
| `pnpm build`            | Frontend production assets and Worker dry-run bundle passed; no deployment.               |
| `pnpm test:e2e`         | **12 passed**, desktop Chromium and mobile Chromium emulation, with no retry needed.      |
| `CI=true pnpm check`    | Passed in the clean source environment: **270 automated tests** in total.                 |

Environment: Linux, Node 26.8.2, pnpm 10.34.7, TypeScript 5.9.3, Wrangler 4.151.0, Miniflare 5.20261012.0-beta (the version used by that Wrangler release), and Playwright 1.64.1. Hosted CI targets Node 24 LTS and remains unexecuted until code is published by the user. Upstream Zod/Rollup annotation and Playwright color notices are nonblocking; all final commands exited successfully.

Saved artifacts:

- [Clean full gate output](evidence/phase-1-checks.txt)
- [Approved owner view, invitation masked](evidence/phase-1-approved.png)
- [Receiver view after bidirectional signaling](evidence/phase-1-receiver.png)
- [Desktop shell](evidence/phase-1-desktop.png)
- [Mobile shell](evidence/phase-1-mobile.png)

The clean verification starts from a source copy with no dependency directories, `.env` files, build output or persisted room state. Temporary Git metadata/index support the secret guard without creating a project commit or remote. Frozen/offline installation reuses only the external package cache. Application, protocol, test, tool and dependency files were checked against the primary workspace before executing the full CI-equivalent command.

The suite exercises invalid/missing/expired/revoked/replayed proofs, pending-role isolation, wrong-room and spoofed-peer signaling, forbidden server events, unsupported origins, HTTP/WS size caps, request and message throttles, duplicate joins/decisions, single-use ticket consumption, ticket origin/revision/epoch binding, socket replacement, actual hibernation eviction, full process restart, real expiry alarms and row purge. SQLite inspection verifies that raw credentials never enter its tables.

Browser evidence uses separate owner, receiver and third-user contexts. It demonstrates pending admission, owner approval, bidirectional signaling receipt, blocked third-user admission and revocation. A separate real-browser test ignores application-level close calls and still observes a server-initiated transport close. Rejection and invalid invitation states, responsive layouts and the P0 regression workbench are tested too. Pixel emulation is layout/browser evidence, not physical-phone certification.

Test infrastructure pins the same Miniflare/workerd generation used by Wrangler, through the SDK's configuration converter. Native network WebSocket tests use a bounded 250 ms close-handshake grace period; the timer starts after an actual close is initiated. No mocked authorization, socket success or persistence was used to satisfy a phase gate.

## Live demonstration

1. `pnpm install --frozen-lockfile`, then `pnpm dev`.
2. Open `http://127.0.0.1:5173` in an owner browser profile and create an invitation.
3. Open the private invitation in another profile and request admission. The receiver stays pending and cannot open signaling until approved.
4. Approve in the owner window. Both clients connect; send a signaling probe from each side and observe receipt in the other.
5. Open the same invitation in a third profile and observe `INVITE_USED` denial.
6. Revoke the room; both existing peers lose signaling access. Separately try rejection and an expired/invalid invitation through the tests.

`pnpm test:e2e` automates the demo. `pnpm test:integration` adds the role, replay, scope, expiry and restart negatives. See the [local runbook](../runbooks/local-development.md).

## P2 handoff and limits

Phase 1 is an authorized control plane. The signaling probe relays synthetic SDP text through real sockets; it does not establish WebRTC or transfer files. Independent peer identity, real SDP/ICE connectivity, STUN/TURN, frame-cap negotiation and authenticated epoch advancement are P2 work. Transfer correctness, persistent receiver blocks and recovery remain P3–P5; physical Android/iPhone support remains subject to later gates.

Browser admission credentials are memory-only. Reloading a browser loses that local credential; the user must create a new room. After rejecting a candidate, create a new room for a different invitation. Edge limits are provider/location-scoped approximations, not global quotas. HTTPS origins, public hosting and provider budget/abuse review must be completed before production deployment in P9.

The CI workflow is saved locally and has not run on GitHub. **No GitHub push or cloud deployment was performed.**
