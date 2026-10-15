# Local development and phase gates

1. Install Node 24 LTS and pnpm 10.34.7, then `pnpm install --frozen-lockfile`.
2. Run `pnpm dev`: Vite on `127.0.0.1:5173`, local Wrangler on `127.0.0.1:8787`. No cloud login/deployment.
3. Open two browser profiles. Both can independently request/approve/close the **synthetic** room or run its full lifecycle. Premature approval shows an illegal-transition error without changing state. Cross-browser signaling is P1.
4. Run `pnpm demo:p0` for the lifecycle and all permitted transitions. This uses synthetic completion evidence, not a transfer receipt.
5. `pnpm exec playwright install chromium`, then `pnpm test:e2e`. `pnpm test:e2e:headed` opens visible independent contexts. Pixel emulation tests layout, not actual Android/iOS compatibility.
6. Run `pnpm check` before handoff. Integration launches workerd through Miniflare. If a restricted environment denies subprocesses/sockets, use its approved permission escalation.

Build outputs `apps/web/dist/` and `apps/signaling/dist/`. `wrangler deploy --dry-run` bundles without deploying. Keep the compatibility date within the installed runtime's support; revisit before P1 production behavior.

CI mirrors frozen install, Node 24, tests and builds. It runs only when code is later uploaded by the user; creating a workflow does not push code. A phase needs negative tests, an observable demo and documented limits before completion.
