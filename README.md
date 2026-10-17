# MeshDrop

Account-free browser-to-browser file transfer. Cloudflare coordinates short-lived rooms; devices own file transport, verification, storage, recovery, and diagnostics.

**Current delivery: Phase 6 — measured transfer insights and local reports.** Transfer verified files over WebRTC, retain local checkpoints and authenticate missing-block recovery. During delivery, inspect receiver-confirmed speed, application/ICE RTT, send buffer, receiver commit timing and connection events. Local bounded history survives reload and exports JSON/CSV without filenames, hashes, candidate addresses or credentials. The [Phase 6 report](docs/reports/phase-6.md) records verification; the [insights runbook](docs/runbooks/transfer-insights.md) explains the measurements. The P0 workbench remains at `/foundation`.

## Tech stack and architecture

pnpm/strict TypeScript monorepo, React/Vite web shell, Cloudflare Worker and SQLite-backed room Durable Objects, Zod runtime contracts, native WebRTC, worker-based incremental SHA-256, OPFS bytes and an IndexedDB checkpoint ledger, Vitest and Playwright. The backend handles authorization and signaling; file bytes, manifests, verification and receipts stay on devices. No traditional user database or compulsory accounts are needed. Four [architecture decisions](docs/adr/001-control-data-planes.md) explain these choices.

## Run locally

Use Node 24 LTS (Node >=22.12 and <27 supported) and pnpm 10.34.7. Install pnpm with `npm install --global pnpm@10.34.7` if necessary.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173> in two independent regular browser profiles. Create an invitation in the first, open it in the second, request admission and approve the receiver. Compare codes in person or over a separate trusted channel and confirm on both devices. The owner selects files and offers them; the receiver accepts, watches committed progress and saves the verified files and receipt. Clear transfer removes its temporary browser files. A third browser using the same invitation is blocked. The local Worker listens at <http://127.0.0.1:8787/health>. Development hosts bind to loopback. No file-upload route exists.

```sh
pnpm demo:p0                        # synthetic lifecycle and every permitted transition
pnpm -r typecheck
pnpm lint
pnpm check:secrets                 # environment ignore coverage and embedded-key checks
pnpm test:unit
pnpm test:integration               # actual local workerd, no cloud account
pnpm test:faults                    # lifecycle faults; socket faults run in integration tests
pnpm build                         # web assets + Worker dry run; no deployment
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e                      # admission, pairing, file transfer, faults + P0 workbench
pnpm bench:p3                      # live 100 MiB + 1 GiB hash/memory gate; requires pnpm dev
pnpm bench:p4                      # receive >=300 MiB, close browser, reopen/re-hash checkpoint
pnpm bench:p5                      # 1 GiB, interrupt near 70%, migrate isolated Linux subnet and resume
pnpm bench:p6                      # measured pause/recovery, exact reuse, export + local history gate
```

`pnpm check` runs all gates. On Linux CI, install browsers with `pnpm exec playwright install --with-deps chromium firefox webkit`. `pnpm test:e2e:headed` opens the two-browser harness when a graphical environment is available. Integration tests and Wrangler need permission to start a local runtime and bind loopback sockets.

Checkpoint storage requires usable OPFS, IndexedDB and Web Locks in a secure context (HTTPS or loopback); API presence alone is insufficient in some private browsing modes. Both bytes and ledger must survive; browser eviction or clearing site data can remove them. Retain interrupted files for 24 hours (default) or 7 days, or choose discard. Expiry is enforced on the next open/check. Cancel/Clear transfer and Delete saved purge scoped data. Reopening rehashes ledger-backed bytes. Renew room admission and compare new codes before network resume; memory-only room credentials are never restored. Prepare the original source on the owner, then resume the saved transfer on the receiver. See the [resume runbook](docs/runbooks/resume.md), [storage recovery runbook](docs/runbooks/storage-recovery.md) and [streaming verification runbook](docs/runbooks/streaming-verification.md).

## Environment variables

Copy `apps/signaling/.env.example` to `apps/signaling/.env` for local overrides. The example contains public local defaults only. Static server/provider secrets belong only in the ignored `.env` beside `wrangler.jsonc`, never source, Wrangler `vars`, or frontend `VITE_*` variables. Direct connectivity requires no shared signing key: it generates opaque random session credentials and stores only scoped SHA-256 verifiers. Runtime owner/invitation/peer capabilities are short-lived and remain in browser memory; they are not global configuration keys.

Public configuration: `ALLOWED_ORIGINS` (exact comma-separated origins), `ROOM_TTL_SECONDS` (900), `INVITE_TTL_SECONDS` (300), `WS_TICKET_TTL_SECONDS` (30), and `CLOSED_TOMBSTONE_SECONDS` (60). Loopback defaults are in Wrangler config so a clean local/CI checkout works without secrets. P2 also accepts `STUN_URLS` (default `stun:stun.cloudflare.com:3478`), optional `TURN_URLS`, and `TURN_TTL_SECONDS` (300, maximum 600). Configure coturn TURN REST with the same random `TURN_SHARED_SECRET` in its private server configuration and the ignored Worker `.env`. Leave both TURN settings empty to disable relay explicitly. The endpoint mints temporary credentials only for approved room members. Set exact HTTPS frontend origins before future deployment. See [secret handling](docs/security/secrets.md).

Optional tool settings: `CI=true`, `WRANGLER_SEND_METRICS=false`, and `PLAYWRIGHT_BROWSERS_PATH`. `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*` are ignored at every depth; only placeholder `.env.example` files may be tracked.

## Deployment

There is no public deployment. `pnpm build` creates local frontend assets and a Worker dry-run bundle with a SQLite migration and rate-limiter bindings. Production deployment is part of P9. No code is pushed automatically.

## Workspace

| Location                        | Owns                                                               |
| ------------------------------- | ------------------------------------------------------------------ |
| `apps/web`                      | React/Vite responsive shell, web manifest, protocol workbench      |
| `apps/signaling`                | Worker routes, SQLite room actors, admission and signaling         |
| `packages/protocol`             | Strict v1 schemas, binary framing, state machines                  |
| `packages/shared-types`         | API and device interfaces                                          |
| `packages/peer-connection`      | WebRTC sessions, ICE, signed pairing and pings                     |
| `packages/transfer-core`        | Streaming, flow control, worker hashing, storage ACKs and receipts |
| `packages/storage`              | OPFS, IndexedDB ledger, rehash/reopen, quota, retention and export |
| `packages/recovery`             | Resume proof/epoch engine, range sets, retries and source identity |
| `packages/network-intelligence` | Measured stats, rolling rates, local history and report exports    |
| `packages/platform`             | Browser API presence detection; P7 platform policy                 |

Later-phase packages expose interfaces, not pretend implementations. File engines remain independent of React lifecycle and server persistence. ESLint prevents protocol/shared types from importing React, Node, or Cloudflare APIs.

Read the [protocol specification](docs/protocol/v1.md), [state machines](docs/protocol/states.md), [ADRs](docs/adr/001-control-data-planes.md), [threat model](docs/threat-model.md), [runbook](docs/runbooks/local-development.md), [Phase 0 report](docs/reports/phase-0.md), [Phase 1 report](docs/reports/phase-1.md), [peer protocol](docs/protocol/peer-p2.md), [Phase 2 report](docs/reports/phase-2.md), [file protocol](docs/protocol/transfer-p3.md), [Phase 3 report](docs/reports/phase-3.md), [storage contract](docs/protocol/storage-p4.md) [Phase 4 report](docs/reports/phase-4.md), [resume protocol](docs/protocol/resume-p5.md) [Phase 5 report](docs/reports/phase-5.md), [diagnostics contract](docs/protocol/diagnostics-p6.md) and [Phase 6 report](docs/reports/phase-6.md).

Source requirements: the supplied **MeshDrop Backend Architecture & MVP Master Plan** and **MeshDrop Phase-Wise Implementation Plan**, October 2026. The phase plan is the implementation source of truth. Work remains local; no deployment or GitHub push is part of this phase.
