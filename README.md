# MeshDrop

Account-free browser-to-browser file transfer. Cloudflare coordinates short-lived rooms; devices own file transport, verification, storage, recovery, and diagnostics.

**Current delivery: Phase 0 — foundation and contracts.** The web application is an explicitly labeled synthetic protocol workbench. Room authorization starts in P1 and live WebRTC transfer in P2–P3. P0 does not send or save a user file.

## Tech stack and architecture

pnpm/strict TypeScript monorepo, React/Vite web shell, Cloudflare Worker and planned SQLite-backed room Durable Objects, Zod runtime contracts, native WebRTC, planned OPFS/IndexedDB storage, Vitest and Playwright. The remote backend will handle authorization and signaling; file processing and diagnostic persistence run on devices. No traditional user database or compulsory accounts are needed. Four [architecture decisions](docs/adr/001-control-data-planes.md) explain these choices.

## Run locally

Use Node 24 LTS (Node >=22.12 and <27 supported) and pnpm 10.34.7. Install pnpm with `npm install --global pnpm@10.34.7` if necessary.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173> in two independent browser profiles. The Worker scaffold listens at <http://127.0.0.1:8787/health>; it does not accept sessions or files. Development hosts bind to loopback.

```sh
pnpm demo:p0                        # synthetic lifecycle and every permitted transition
pnpm -r typecheck
pnpm lint
pnpm test:unit
pnpm test:integration               # actual local workerd, no cloud account
pnpm test:faults                    # synthetic lifecycle faults in P0
pnpm build                         # web assets + Worker dry run; no deployment
pnpm exec playwright install chromium
pnpm test:e2e                      # isolated contexts + responsive shell
```

`pnpm check` runs all gates. On Linux CI, install browsers with `pnpm exec playwright install --with-deps chromium`. `pnpm test:e2e:headed` opens the two-browser harness when a graphical environment is available. Integration tests and Wrangler need permission to start a local runtime and bind loopback sockets.

## Environment variables

No application secrets or environment variables are required for P0 local use. Optional test/tool settings: `CI=true` enables strict CI behavior, `WRANGLER_SEND_METRICS=false` disables Wrangler tool telemetry, and `PLAYWRIGHT_BROWSERS_PATH` selects a browser-install directory. Room capabilities and TURN secrets will be documented when those features are implemented. `.env*` and `.dev.vars` are ignored; never commit credentials.

## Deployment

P0 has no public deployment. `pnpm build` creates local frontend assets and a Worker dry-run bundle. Production deployment is part of P9. No code is pushed automatically.

## Workspace

| Location                        | Owns                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `apps/web`                      | React/Vite responsive shell, web manifest, protocol workbench |
| `apps/signaling`                | Worker scaffold; P1 adds room actors and authorization        |
| `packages/protocol`             | Strict v1 schemas, binary framing, state machines             |
| `packages/shared-types`         | API and device interfaces                                     |
| `packages/peer-connection`      | P2 connectivity contract                                      |
| `packages/transfer-core`        | P3 transfer engine contract                                   |
| `packages/storage`              | P4 receiver commit/save contract                              |
| `packages/recovery`             | P5 checkpoint/revalidation contract                           |
| `packages/network-intelligence` | P6 measured/unsupported diagnostics contract                  |
| `packages/platform`             | Browser API presence detection; P7 platform policy            |

Later-phase packages expose interfaces, not pretend implementations. File engines remain independent of React lifecycle and server persistence. ESLint prevents protocol/shared types from importing React, Node, or Cloudflare APIs.

Read the [protocol specification](docs/protocol/v1.md), [state machines](docs/protocol/states.md), [ADRs](docs/adr/001-control-data-planes.md), [threat model](docs/threat-model.md), [runbook](docs/runbooks/local-development.md), and [Phase 0 report](docs/reports/phase-0.md).

Source requirements: the supplied **MeshDrop Backend Architecture & MVP Master Plan** and **MeshDrop Phase-Wise Implementation Plan**, October 2026. The phase plan is the implementation source of truth. Work remains local; no deployment or GitHub push is part of P0.
