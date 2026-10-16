# Local development and phase gates

1. Install Node 24 LTS and pnpm 10.34.7, then `pnpm install --frozen-lockfile`.
2. Run `pnpm dev`: Vite on `127.0.0.1:5173`, local Wrangler on `127.0.0.1:8787`. No cloud login/deployment.
3. Open two independent browser profiles at the root page. Create an invitation in the owner profile; open it in the receiver profile, request admission, then approve/reject in the owner profile. After approval, exchange signaling probes. A third profile using the same link is denied. Revoke the room and observe both peers close. These are real Worker/SQLite/WebSocket operations; file transfer is P2–P3.
4. The historical synthetic workbench is `/foundation`; `pnpm demo:p0` still prints its lifecycle and all permitted transitions. It is not a transfer receipt.
5. `pnpm exec playwright install chromium`, then `pnpm test:e2e`. `pnpm test:e2e:headed` opens visible independent contexts. Pixel emulation tests layout, not actual Android/iOS compatibility.
6. Run `pnpm check` before handoff, including `pnpm check:secrets`. Integration launches workerd with real SQLite room actors, native network WebSockets, alarm expiry and explicit hibernation eviction. If a restricted environment denies subprocesses/sockets, use its approved permission escalation.

Build outputs `apps/web/dist/` and `apps/signaling/dist/`. `wrangler deploy --dry-run` bundles without deploying. SQLite migration and native rate-limit bindings are configured locally. Leave `.wrangler/` out of Git; it contains transient local room state. Copy `.env.example` to an ignored `.env` beside Wrangler config for local overrides; no provider key is needed in P1.

If you reload/close a browser, its memory-only owner/peer credential is lost. Create a fresh room; do not claim cross-tab credential recovery. A rejected invitation is revoked, so invite a different person through a new room. A manual signaling reconnect consumes a fresh ticket and replaces the previous socket. Local frontend API requests use a loopback-only Vite proxy; production HTTPS origins and deployment remain P9.

CI mirrors frozen install, Node 24, tests and builds. It runs only when code is later uploaded by the user; creating a workflow does not push code. A phase needs negative tests, an observable demo and documented limits before completion.
