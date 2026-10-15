# Phase 0 completion report

Date: 16 October 2026. Status: **complete — P0 exit gate passed locally**.

Scope follows the supplied **MeshDrop Backend Architecture & MVP Master Plan** and **MeshDrop Phase-Wise Implementation Plan**, October 2026. The phase plan takes precedence for implementation contracts. No later phase is declared complete.

## Delivered against every ticket

| Ticket | Completed work                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0.1   | pnpm workspace with two apps and eight packages: protocol, shared-types, peer-connection, transfer-core, storage, recovery, network-intelligence and platform. React/Vite shell and Cloudflare Worker scaffold compile against the shared protocol. Later engines have typed interfaces with explicit phase ownership. |
| P0.2   | Strict TypeScript, unchecked-index and exact-optional checks, shared ESLint/Prettier rules, framework/runtime import restrictions, exact direct dependency versions, pnpm lockfile, build-script allowlist and reproducible root/package scripts.                                                                      |
| P0.3   | Room, peer and transfer state machines; discriminated event unions; explicit legal and idempotent edges; deterministic rejection of illegal edges; terminal cancellation and completion guards.                                                                                                                        |
| P0.4   | Strict Zod v1 signaling variants, UUID/time/uint32 validation, pre-parse UTF-8 message caps, safe parse errors, binary DATA codec, negotiated frame limits and independently specified golden wire bytes.                                                                                                              |
| P0.5   | Four ADRs covering plane separation, room actors, local storage and resume trust; reviewed threat model and phase-specific security responsibilities.                                                                                                                                                                  |
| P0.6   | Sanitized fixtures; unit, local workerd integration, synthetic fault and Playwright suites; CI workflow; CLI lifecycle/transition demo; independent browser-context harness; desktop/mobile layout evidence; local runbook.                                                                                            |

## Verification results

| Gate                    | Result                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`     | All ten app/package targets passed.                                                                                                                                                            |
| `pnpm typecheck`        | Root tests, tools and configuration passed.                                                                                                                                                    |
| `pnpm lint`             | ESLint and formatting passed.                                                                                                                                                                  |
| `pnpm test:unit`        | **210 passed**, four files.                                                                                                                                                                    |
| `pnpm test:integration` | **4 passed**, actual local workerd through Miniflare.                                                                                                                                          |
| `pnpm test:faults`      | **8 passed**, explicitly synthetic P0 lifecycle faults.                                                                                                                                        |
| `pnpm build`            | Web assets and Worker dry-run bundle generated successfully; no deployment.                                                                                                                    |
| `pnpm test:e2e`         | **4 passed**, desktop Chromium and Pixel 7 Chromium emulation.                                                                                                                                 |
| `pnpm demo:p0`          | Synthetic session completed; all permitted transitions printed.                                                                                                                                |
| Clean source install    | Fresh copy excluded Git metadata, dependencies, build outputs and environment-owned directories; `pnpm install --frozen-lockfile --offline` reused only the external package cache and passed. |
| Clean full gate run     | `CI=true pnpm check` passed in that fresh copy, including production builds and all 226 automated checks.                                                                                      |

Environment: Linux, Node **26.8.2**, pnpm **10.34.7**, TypeScript **5.9.3**, Playwright **1.64.1** / Chromium **156.0.8078.4**. CI is configured for Node 24 LTS. The hosted GitHub workflow has not been executed because code has not been pushed. Local CI-equivalent checks were executed successfully. pnpm and Playwright were bootstrapped under `/tmp`; standard developer prerequisites are documented in the README.

### Negative coverage

Schemas reject unsupported versions, missing fields, invalid UUIDs, invalid epoch/sequence values, malformed JSON, unknown fields/events, caller-supplied roles, oversized UTF-8 messages and mismatched payloads. Parser errors do not echo sensitive input.

Frame tests cover fixed golden bytes, header-inclusive size limits, smaller negotiated caps, bad magic/version/kind/flags/reserved fields, truncation, trailing data, wrong lengths, invalid IDs/integers, empty payloads, cross-block fragments, nonzero typed-array offsets and independent decoded payload buffers.

The lifecycle suite exercises every state/event pair, idempotent repeats, cancellation, terminal states, reconnection requiring renegotiation, premature verification, incomplete receiver commitment and missing integrity/storage evidence. Worker integration checks read-only health/protocol responses and rejection of unavailable session/upload routes. Browser tests exercise premature approval, request/approve/close/reset, the synthetic full lifecycle, API-presence reporting, browser errors and viewport overflow.

## Contract decisions and engineering note

1. Canonical envelope: `version`, `type`, `roomId`, `peerId`, `messageId`, `epoch`, `seq`, `sentAt`, `payload`. The architecture PDF's abbreviated illustrative aliases are rejected. Sequence is explicit for later authenticated replay enforcement.
2. Control messages are capped at 64 KiB UTF-8; SDP at 48 KiB and ICE text at 4 KiB. Zod rejects unknown fields rather than silently stripping them.
3. A DATA message starts with a fixed 64-byte network-order header. The initial **16 KiB total message** ceiling includes this header, leaving 16,320 payload bytes. This conservatively resolves the two documents' payload/total wording. Verification blocks are 1 MiB.
4. Completion requires both integrity and finalized storage evidence. These lifecycle guards are not a substitute for the real hashing/checkpoint implementations in P3/P4.
5. Shared contracts cannot import React, Node or Cloudflare APIs. UI only consumes protocol/device logic; it does not define core state. Future engines are interfaces, not simulated feature implementations.

## Observable demonstration and evidence

The documented `pnpm dev` harness was started successfully. Vite on port 5173 and Wrangler on port 8787 both passed direct HTTP probes, including the Worker's `/health` response.

Run `pnpm demo:p0` for the synthetic lifecycle and every permitted transition. Run `pnpm dev` and open `http://127.0.0.1:5173` in separate browser profiles for the labeled local workbench. The Worker scaffold serves `/health` and `/v1/protocol` on port 8787. The [runbook](../runbooks/local-development.md) contains the full steps.

- [Clean gate output](evidence/phase-0-checks.txt)
- [Lifecycle and permitted transition output](evidence/phase-0-demo.txt)
- [Desktop screenshot](evidence/phase-0-desktop.png)
- [Mobile emulation screenshot](evidence/phase-0-mobile.png)

Screenshots were visually inspected. Pixel emulation is layout evidence, not a physical Android/iPhone test. Real cross-device and network verification remains in the appropriate later phases.

## Limits and P1 handoff

P0 intentionally has no functional room authorization, Durable Object session database, live WebSocket signaling, WebRTC connection, file transfer, persistent receiver blocks, recovery engine, TURN configuration or public deployment. The phase's specified fake session is clearly labeled synthetic in the browser and CLI; it does not claim actual delivered bytes.

P1 starts from the Worker scaffold and must implement routing/limits/origin policy, SQLite-backed SessionRoom, capability verifiers, pending/approved roles, single-use WebSocket tickets, expiry/revocation and authenticated room/epoch isolation. Parsing a schema does not authenticate a peer or prevent replay.

Tooling emitted nonblocking upstream Zod/Rollup annotation notices, a tsx deprecation notice under Node 26, and Playwright environment/color notices. All relevant commands exited successfully after resolving sandbox socket/cache restrictions through approved local execution. No product fallback or fake network/storage success was introduced to bypass a failed check.

All work is local. **No GitHub push or cloud deployment was performed.**
