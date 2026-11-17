# Local development and phase gates

Current source, counts and roadmap: [CURRENT_STATUS](../CURRENT_STATUS.md).

1. Use Node 24 (CI), supported range `>=22.12.0 <27`, and pnpm 10.34.7; then `pnpm install --frozen-lockfile`.
2. Run `pnpm dev`: Vite on `127.0.0.1:5173`, local Wrangler on `127.0.0.1:8787`. No cloud login/deployment.
3. Open two independent regular browser profiles at the root page. Create an invitation in the owner profile; open it in the receiver profile, request admission, then approve/reject in the owner profile. Compare pairing codes over a separate trusted channel and confirm on both devices. The owner offers files, the receiver accepts into temporary OPFS, and both display committed bytes followed by verified completion. Save files/receipt before clearing the transfer or closing the page. A third profile using the same link is denied. Revoke the room and observe both peers close; completed downloads remain available until cleared. These use real Worker/SQLite/WebSocket admission and WebRTC file transport.
4. The historical synthetic workbench is `/foundation`; `pnpm demo:p0` still prints its lifecycle and all permitted transitions. It is not a transfer receipt.
5. `pnpm exec playwright install chromium firefox webkit`, then `pnpm test:e2e`. `pnpm test:e2e:headed` opens visible independent contexts. Pixel emulation tests layout, not actual Android/iOS compatibility.
6. Run `pnpm check` before handoff, including `pnpm check:secrets`. Integration launches workerd with real SQLite room actors, native network WebSockets, alarm expiry and explicit hibernation eviction. If a restricted environment denies subprocesses/sockets, use its approved permission escalation.

Build outputs `apps/web/dist/` and `apps/signaling/dist/`. `wrangler deploy --dry-run` bundles without deploying. SQLite migration and native rate-limit bindings are configured locally. Leave `.wrangler/` out of Git; it contains transient local room state. Copy `.env.example` to an ignored `.env` beside Wrangler config for local overrides; no provider key is needed for direct P2 sessions. Optional coturn credentials are described in the [P2 testing runbook](peer-connectivity.md).

If you reload/close a browser, its memory-only owner/peer credential is lost. Create a fresh room; do not claim cross-tab credential recovery. A rejected invitation is revoked, so invite a different person through a new room. A manual signaling reconnect consumes a fresh ticket and replaces the previous socket. Local frontend API requests use a loopback-only Vite proxy. The Pages/private-Worker architecture is documented separately; historical P9 hosting does not establish that current source is deployed, and current production publication remains blocked.

CI mirrors frozen install, Node 24, tests and builds. It runs only when code is later uploaded by the user; creating a workflow does not push code. A phase needs negative tests, an observable demo and documented limits before completion.

The large-file regression is `pnpm bench:p3` while `pnpm dev` is running. It verifies 100 MiB and 1 GiB downloads with independent SHA-256 and measured page/worker memory; leave several GiB free. Results stay in ignored `.meshdrop-artifacts/phase-3-streaming`. See the [streaming runbook](streaming-verification.md) for exact scope and browser setup. P4 now adds an OPFS/IndexedDB ledger and startup rehash. Run `pnpm bench:p4` for the required >=300 MiB receive/close/reopen demonstration and see the [storage runbook](storage-recovery.md). P5 resumes revalidated missing ranges after renewed admission/pairing and exact source preparation. See the [resume runbook](resume.md); `pnpm bench:p5` creates its own guarded Linux namespace and local app servers for the 1 GiB subnet-change gate.

P6 adds measured transfer insights and bounded local report history. `pnpm bench:p6` runs the real-browser pause/recovery, exact reused-byte, export, reload/delete and diagnostics failure checks. See the [insights runbook](transfer-insights.md) and [measurement contract](../protocol/diagnostics-p6.md) for units, unavailable fields, evidence rules and retention limits.

P7 adds usable capability probes, receive limits, native export adapters, private QR scanning, foreground lifecycle handling and a production PWA shell. `pnpm bench:p7` and `pnpm test:pwa` cover focused mobile and production offline/update scenarios. The [mobile runbook](mobile-pwa.md) describes authorized physical Android testing; the [device matrix](../../tests/devices/browser-matrix.md) records measured iPhone/iPad/Mac Safari coverage and remaining device gates. Historical small iPhone demonstrations passed, but Task 13's 8 MiB native export retrieval remains incomplete on Free automation; the support matrix distinguishes them.

## Full-check prerequisites and focused commands

The complete harness is exercised on Linux/Ubuntu CI. Install Git and OpenSSL plus GitHub CLI at `/usr/bin/gh`; existing offline Sigstore tests read that exact binary path and need no GitHub login or network service. Docker fixtures use `unix:///var/run/docker.sock`. This is a test-host requirement, not a claim that Windows/macOS browser apps are unsupported or that their native full development harness has been certified. Install Playwright engines (`pnpm exec playwright install chromium firefox webkit`); Linux may need `--with-deps`. Docker must be running with the pinned PostgreSQL image used in `.github/workflows/ci.yml` and `tests/release-trust/` available locally. Those tests use disposable, network-isolated local containers with synthetic credentials, not a production database. They intentionally fail when prerequisites are absent rather than silently skipping. Browser checks own loopback 5173/8787 and PWA 4173/8788; keep unrelated services off those ports. No cloud account, BrowserStack credential or TURN secret is required by the normal full check.

Run the final complete check from the reviewed committed source. The release-provenance tests bind source/lockfile fingerprints to Git; a modified lockfile must not be treated as the old HEAD. Reports explicitly identify any disposable committed source snapshot used while an operator keeps the main checkout uncommitted.

```sh
CI=true pnpm check
pnpm check:docs
pnpm audit:release
pnpm verify:rollback
```

`check:docs` is read-only: it checks public tracked/unignored Markdown inline/reference links, HTML media targets and heading anchors, plus root pnpm commands in code blocks/spans. It does not execute examples, fetch external links, certify CI truth, or parse every possible Markdown extension. It rejects links into ignored/private files or outside the repository. Workspace-filter/recursive commands are reviewed against their package scripts separately.

| Focused command                                                                     | Scope; executions are not extra full-suite test cases                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test:unit`, `pnpm test:security`, `pnpm test:integration`, `pnpm test:faults` | Individual deterministic application suites                                                 |
| `pnpm test:release-store`                                                           | Disposable local PostgreSQL                                                                 |
| `pnpm test:e2e`, `pnpm test:a11y`, `pnpm test:pwa`                                  | Local browser/storage, four accessibility engine/viewport projects, built PWA               |
| `pnpm test:transfer-reliability`, `pnpm test:storage-lifecycle`                     | Focused Task 12/16 correctness and lifecycle cases                                          |
| `pnpm test:load`, `pnpm test:load:browser`                                          | Isolated logical/local control-plane and representative browser load; never hosted capacity |

Benchmarks and device/provider runners are opt-in and have separate prerequisites/evidence. In particular, legacy `verify:ios` uses a historical public-preview default; Task 13's `verify:platform-cloud` requires an explicitly isolated test identity/origin. Neither belongs to normal CI or should be run as an unsolicited live-site test. See the mobile and benchmark runbooks before using them.
