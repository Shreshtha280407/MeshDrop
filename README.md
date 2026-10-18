# MeshDrop

Account-free browser-to-browser file transfer. Cloudflare coordinates short-lived rooms; devices own file transport, verification, storage, recovery, and diagnostics.

**Current work: Phase 9 — production deployment and benchmark release.** The [public preview](https://meshdrop-8ab9cb08-preview.pages.dev), public Oppo Wi-Fi recovery/mobile-data delivery, Worker rollback, all six local 100 MiB/1 GiB/2 GiB benchmarks and 564 automated tests pass. Production rollout, free-only relay verification, account alerts and remaining physical-device gates are pending. See the [Phase 9 report](docs/reports/phase-9.md), [deployment guide](docs/deploy.md), [operations runbook](docs/runbook.md), [user guide](docs/user-guide.md), [privacy notice](docs/privacy-notice.md) and [measured support matrix](docs/support-matrix.md). The [Phase 7 physical iPhone gate remains pending](docs/reports/phase-7.md). The [Phase 8 report](docs/reports/phase-8.md) records the prior security baseline.

## Tech stack and architecture

pnpm/strict TypeScript monorepo, React/Vite web shell, Cloudflare Worker and SQLite-backed room Durable Objects, Zod runtime contracts, native WebRTC, worker-based incremental SHA-256, OPFS bytes and an IndexedDB checkpoint ledger, Vitest and Playwright. The backend handles authorization and signaling; file bytes, manifests, verification and receipts stay on devices. No traditional user database or compulsory accounts are needed. Five [architecture decisions](docs/adr/001-control-data-planes.md) explain these choices.

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
pnpm test:security                 # deterministic fuzz, range properties and abuse input/queue checks
pnpm audit:release                 # all resolved dependencies; network access required
pnpm test:integration               # actual local workerd, no cloud account
pnpm test:faults                    # lifecycle faults; socket faults run in integration tests
pnpm build                         # web assets + Worker dry run; no deployment
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e                      # admission, pairing, file transfer, faults + P0 workbench
pnpm bench:p3                      # live 100 MiB + 1 GiB hash/memory gate; requires pnpm dev
pnpm bench:p4                      # receive >=300 MiB, close browser, reopen/re-hash checkpoint
pnpm bench:p5                      # 1 GiB, interrupt near 70%, migrate isolated Linux subnet and resume
pnpm bench:p6                      # measured pause/recovery, exact reuse, export + local history gate
pnpm bench:p7                      # focused mobile checks plus real production PWA/offline tests
pnpm test:pwa                      # production shell, CSP/privacy, offline export and explicit updates
pnpm bench:p8                      # generated abuse report, Worker suite and real browser denial demos
pnpm bench:p9                      # 100 MiB / 1 GiB / 2 GiB normal + controlled-disconnect release matrix
```

`pnpm check` runs all automated gates. Physical-device acceptance is recorded separately. On Linux CI, install browsers with `pnpm exec playwright install --with-deps chromium firefox webkit`. `pnpm test:e2e:headed` opens the two-browser harness when a graphical environment is available. Integration tests and Wrangler need permission to start a local runtime and bind loopback sockets.

Checkpoint storage requires usable OPFS, IndexedDB and Web Locks in a secure context (HTTPS or loopback); API presence alone is insufficient in some private browsing modes. Both bytes and ledger must survive; browser eviction or clearing site data can remove them. Retain interrupted files for 24 hours (default) or 7 days, or choose discard. Expiry is enforced on the next open/check. Cancel/Clear transfer and Delete saved purge scoped data. Reopening rehashes ledger-backed bytes. Renew room admission and compare new codes before network resume; memory-only room credentials are never restored. Prepare the original source on the owner, then resume the saved transfer on the receiver. See the [resume runbook](docs/runbooks/resume.md), [storage recovery runbook](docs/runbooks/storage-recovery.md) and [streaming verification runbook](docs/runbooks/streaming-verification.md).

New offers need estimated free space plus 10%/4 MiB headroom. Unknown quota limits a new offer to 64 MiB with acknowledgement; offers from 300 MiB also show an extra warning. These are policy safeguards, not certified file-size maxima. Saved-file export first revalidates/prepares the file, then a separate Save/Share click opens the system flow. Keep both devices in the foreground; returning from a hidden page requires an explicit resume. A production PWA caches public UI assets only and can export surviving verified files offline. Pairing and delivery need connectivity. No background WebRTC, guaranteed retention or universal iPhone size/export claim is made.

## Environment variables

Copy `apps/signaling/.env.example` to `apps/signaling/.env` for local overrides. The example contains public local defaults only. Static server/provider secrets belong only in the ignored `.env` beside `wrangler.jsonc`, never source, Wrangler `vars`, or frontend `VITE_*` variables. Direct connectivity requires no shared signing key: it generates opaque random session credentials and stores only scoped SHA-256 verifiers. Runtime owner/invitation/peer capabilities are short-lived and remain in browser memory; they are not global configuration keys.

Public configuration: `ALLOWED_ORIGINS` (exact comma-separated origins), `ROOM_TTL_SECONDS` (900), `INVITE_TTL_SECONDS` (300), `WS_TICKET_TTL_SECONDS` (30), and `CLOSED_TOMBSTONE_SECONDS` (60). Loopback defaults are in Wrangler config so a clean local/CI checkout works without secrets. P2 also accepts `STUN_URLS` (default `stun:stun.cloudflare.com:3478`), optional `TURN_URLS`, and `TURN_TTL_SECONDS` (300, maximum 600). Configure coturn TURN REST with the same random `TURN_SHARED_SECRET` in its private server configuration and the ignored Worker `.env`. Leave both TURN settings empty to disable relay explicitly. The endpoint mints temporary credentials only for approved room members. Production environment configuration uses one exact HTTPS frontend origin. P9 adds `OPS_REVOKE_SECRET`, `ADMISSION_PAUSED`, `ENVIRONMENT` and `AUDIT_LOGS`; see [deployment configuration](docs/deploy.md). See [secret handling](docs/security/secrets.md).

Optional tool settings: `CI=true`, `WRANGLER_SEND_METRICS=false`, and `PLAYWRIGHT_BROWSERS_PATH`. `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*` are ignored at every depth; only placeholder `.env.example` files may be tracked.

`MESHDROP_SIGNAL_ORIGIN` optionally changes the Vite server/preview's backend proxy target for local tests; it is server-side configuration, not a frontend secret. Production PWA tests use 4173/8788 with separate local Worker persistence. The Android test runner accepts `MESHDROP_ANDROID_SERIAL`, `MESHDROP_EVIDENCE_DIR` and opt-in scenario flags described in the mobile runbook. No new provider key is required for P7/P8.

## Deployment

The [public preview](https://meshdrop-8ab9cb08-preview.pages.dev) is deployed and its HTTPS/WSS admission/revocation checks pass. Production release is pending the remaining gates. Follow the [deployment guide](docs/deploy.md) to prepare, dry-run, provision and publish isolated Cloudflare Pages + Worker environments. `pnpm deploy:cloud init preview` creates a private ignored `.env` with a random operator secret. `prepare` creates frozen bundles and a hash manifest; it makes no cloud changes. The stable public address will run independently of the developer's laptop. TURN requires a separately configured [relay and bandwidth budget](infrastructure/turn/README.md). A manual CI deployment workflow is included; no code is committed or pushed automatically.

## Workspace

| Location                        | Owns                                                                |
| ------------------------------- | ------------------------------------------------------------------- |
| `apps/web`                      | React/Vite responsive shell, web manifest, protocol workbench       |
| `apps/signaling`                | Worker routes, SQLite room actors, admission and signaling          |
| `packages/protocol`             | Strict v1 schemas, binary framing, state machines                   |
| `packages/shared-types`         | API and device interfaces                                           |
| `packages/peer-connection`      | WebRTC sessions, ICE, signed pairing and pings                      |
| `packages/transfer-core`        | Streaming, flow control, worker hashing, storage ACKs and receipts  |
| `packages/storage`              | OPFS, IndexedDB ledger, rehash/reopen, quota, retention and export  |
| `packages/recovery`             | Resume proof/epoch engine, range sets, retries and source identity  |
| `packages/network-intelligence` | Measured stats, rolling rates, local history and report exports     |
| `packages/platform`             | Usable browser capability probes, quota policy and lifecycle events |

Unimplemented later-phase features remain outside the delivered scope. File engines remain independent of React lifecycle and server persistence. ESLint prevents protocol/shared types from importing React, Node, or Cloudflare APIs.

Read the [protocol specification](docs/protocol/v1.md), [state machines](docs/protocol/states.md), [ADRs](docs/adr/001-control-data-planes.md), [threat model](docs/threat-model.md), [runbook](docs/runbooks/local-development.md), [Phase 0 report](docs/reports/phase-0.md), [Phase 1 report](docs/reports/phase-1.md), [peer protocol](docs/protocol/peer-p2.md), [Phase 2 report](docs/reports/phase-2.md), [file protocol](docs/protocol/transfer-p3.md), [Phase 3 report](docs/reports/phase-3.md), [storage contract](docs/protocol/storage-p4.md) [Phase 4 report](docs/reports/phase-4.md), [resume protocol](docs/protocol/resume-p5.md) [Phase 5 report](docs/reports/phase-5.md), [diagnostics contract](docs/protocol/diagnostics-p6.md), [Phase 6 report](docs/reports/phase-6.md) and [mobile contract](docs/protocol/mobile-p7.md).

Source requirements: the supplied **MeshDrop Backend Architecture & MVP Master Plan** and **MeshDrop Phase-Wise Implementation Plan**, October 2026. The phase plan is the implementation source of truth. See the [Phase 9 report](docs/reports/phase-9.md) for deployed preview, verification and remaining release gates. Services must remain free; no billing activation or paid plan is authorized. The preview remains direct-only until a no-charge relay setup is verified. No GitHub push is performed automatically.
