# MeshDrop

Account-free browser-to-browser file transfer. Cloudflare coordinates short-lived rooms; devices own file transport, verification, storage, recovery, and diagnostics.

**Current delivery: Phase 1 — authorized signaling rooms.** Create a private invitation, request admission in another browser, approve/reject the receiver, exchange a signaling probe and revoke the room. Room state survives Durable Object hibernation/restart. WebRTC transport and file transfer are planned for P2–P3; this phase does not send or save user files. The synthetic P0 workbench remains at `/foundation`.

## Tech stack and architecture

pnpm/strict TypeScript monorepo, React/Vite web shell, Cloudflare Worker and SQLite-backed room Durable Objects, Zod runtime contracts, native WebRTC, planned OPFS/IndexedDB storage, Vitest and Playwright. The remote backend will handle authorization and signaling; file processing and diagnostic persistence run on devices. No traditional user database or compulsory accounts are needed. Four [architecture decisions](docs/adr/001-control-data-planes.md) explain these choices.

## Run locally

Use Node 24 LTS (Node >=22.12 and <27 supported) and pnpm 10.34.7. Install pnpm with `npm install --global pnpm@10.34.7` if necessary.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173> in two independent browser profiles. Create an invitation in the first, open it in the second, request admission, approve the receiver, and exchange signaling probes. A third browser using the same invitation is blocked. The local Worker listens at <http://127.0.0.1:8787/health>. Development hosts bind to loopback. No file-upload route exists.

```sh
pnpm demo:p0                        # synthetic lifecycle and every permitted transition
pnpm -r typecheck
pnpm lint
pnpm check:secrets                 # environment ignore coverage and embedded-key checks
pnpm test:unit
pnpm test:integration               # actual local workerd, no cloud account
pnpm test:faults                    # lifecycle faults; socket faults run in integration tests
pnpm build                         # web assets + Worker dry run; no deployment
pnpm exec playwright install chromium
pnpm test:e2e                      # Worker-backed admission/signaling + P0 workbench
```

`pnpm check` runs all gates. On Linux CI, install browsers with `pnpm exec playwright install --with-deps chromium`. `pnpm test:e2e:headed` opens the two-browser harness when a graphical environment is available. Integration tests and Wrangler need permission to start a local runtime and bind loopback sockets.

## Environment variables

Copy `apps/signaling/.env.example` to `apps/signaling/.env` for local overrides. The example contains public local defaults only. Static server/provider secrets belong only in the ignored `.env` beside `wrangler.jsonc`, never source, Wrangler `vars`, or frontend `VITE_*` variables. P1 requires no shared signing key: it generates opaque random session credentials and stores only scoped SHA-256 verifiers. Runtime owner/invitation/peer capabilities are short-lived and remain in browser memory; they are not global configuration keys.

Public configuration: `ALLOWED_ORIGINS` (exact comma-separated origins), `ROOM_TTL_SECONDS` (900), `INVITE_TTL_SECONDS` (300), `WS_TICKET_TTL_SECONDS` (30), and `CLOSED_TOMBSTONE_SECONDS` (60). Loopback defaults are in Wrangler config so a clean local/CI checkout works without secrets. Set exact HTTPS frontend origins before future deployment. See [secret handling](docs/security/secrets.md).

Optional tool settings: `CI=true`, `WRANGLER_SEND_METRICS=false`, and `PLAYWRIGHT_BROWSERS_PATH`. `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*` are ignored at every depth; only placeholder `.env.example` files may be tracked.

## Deployment

There is no public deployment. `pnpm build` creates local frontend assets and a Worker dry-run bundle with a SQLite migration and rate-limiter bindings. Production deployment is part of P9. No code is pushed automatically.

## Workspace

| Location                        | Owns                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `apps/web`                      | React/Vite responsive shell, web manifest, protocol workbench |
| `apps/signaling`                | Worker routes, SQLite room actors, admission and signaling    |
| `packages/protocol`             | Strict v1 schemas, binary framing, state machines             |
| `packages/shared-types`         | API and device interfaces                                     |
| `packages/peer-connection`      | P2 connectivity contract                                      |
| `packages/transfer-core`        | P3 transfer engine contract                                   |
| `packages/storage`              | P4 receiver commit/save contract                              |
| `packages/recovery`             | P5 checkpoint/revalidation contract                           |
| `packages/network-intelligence` | P6 measured/unsupported diagnostics contract                  |
| `packages/platform`             | Browser API presence detection; P7 platform policy            |

Later-phase packages expose interfaces, not pretend implementations. File engines remain independent of React lifecycle and server persistence. ESLint prevents protocol/shared types from importing React, Node, or Cloudflare APIs.

Read the [protocol specification](docs/protocol/v1.md), [state machines](docs/protocol/states.md), [ADRs](docs/adr/001-control-data-planes.md), [threat model](docs/threat-model.md), [runbook](docs/runbooks/local-development.md), [Phase 0 report](docs/reports/phase-0.md), and [Phase 1 report](docs/reports/phase-1.md).

Source requirements: the supplied **MeshDrop Backend Architecture & MVP Master Plan** and **MeshDrop Phase-Wise Implementation Plan**, October 2026. The phase plan is the implementation source of truth. Work remains local; no deployment or GitHub push is part of this phase.
