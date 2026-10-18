# MeshDrop Phase 9 report — deployment and benchmark release

Date: 2026-10-19. Requirements: P9.1–P9.6 and the strict exit gate in the supplied
phase-wise implementation plan. Baseline: P8 commit `e108e7a`. All source changes
remain local and uncommitted. No Git staging, commit or push was performed.

**The public preview and available-device verification are delivered. Phase 9's
full release gate remains open** for a verified free-only relay, account quota
alerts, production rollout and the remaining required physical platforms. The
public multi-device transfer/disconnect/resume demonstration passed on the Oppo
and laptop; it is no longer a pending gate.

Public preview: <https://meshdrop-8ab9cb08-preview.pages.dev>.
Cloudflare hosts the application independently of the laptop. Both devices
participating in a transfer still need to stay online with MeshDrop open.

## Implementation delivered

| Ticket | Delivered work                                                                                                                                                                                                                                                                | Remaining acceptance                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P9.1   | Separate preview/production Pages and private signaling Worker configuration; SQLite Durable Object migration v1; distinct room/rate namespaces and operator secrets; ignored 0600 `.env`; frozen bundles and SHA-256 manifest; prepare/dry-run/publish tooling; live preview | Production resources and rollout after release acceptance                                                                           |
| P9.2   | coturn configuration/capacity template; optional Cloudflare TURN API adapter; approved-peer short-lived credentials; fixed provider endpoint, bounded response/deadline and strict ICE validation; documented fallback and costs                                              | Account permission/key and a verified no-charge boundary; actual managed relay, bandwidth metering and UDP-blocked TCP/TLS fallback |
| P9.3   | Full CI reusable by a manual default-branch deployment workflow; separate GitHub Environments; no push-triggered deployment; bundle/config integrity validation; local P9→P8→P9 persisted-room rollback and public recorded-version Worker rollback/restore                   | Actual GitHub environment protections; Pages rollback and production rollout acceptance                                             |
| P9.4   | Liveness/readiness, admission drain, independently authorized operator revocation, sampled fixed-field audit events without file content/IDs/URLs; quota/failed-join/relay operations guide                                                                                   | Configure actual account alert destinations and verify quota notifications; relay capacity/usage evidence                           |
| P9.5   | All six normal/disconnect 100 MiB, 1 GiB and 2 GiB benchmark cases passed; exact downloaded SHA-256 and receipts; missing-only resume; bounded queues and measured memory; public physical Wi-Fi recovery and mobile-data transfer                                            | Large-file measurements are local desktop evidence; no universal public/mobile throughput or size claim                             |
| P9.6   | Deployment guide, runbook, user guide, privacy notice, measured support matrix, hosting ADR, release notes and reviewed evidence; existing protocol documentation retained                                                                                                    | Keep measured limits and open release gates explicit                                                                                |

The Pages gateway exposes one exact HTTPS/WSS origin and forwards control routes
through a private service binding. The signaling Worker has no public workers.dev
endpoint. Branch/hash aliases are rejected. Function-served assets receive CSP
and security headers directly. Files do not pass through Pages, Workers or
SQLite, and no server file-storage fallback was added. The product header now
describes private device-to-device sharing instead of an implementation phase.

Wrangler requires `--force` on initial project creation to select native Pages
instead of Workers Assets delegation. This selects the hosting product and does
not affect Git. Initial account Workers subdomain setup preserves an existing
subdomain. No domain purchase or GitHub connection was created. Production has
separate local configuration and secrets, but no remote production resources.

## Defects found and fixed

An already queued recovery retry could replace a newer admitted connection while
it was still negotiating. The original client made three connection requests and
advanced to epoch 4 in a controlled regression. Cancelling the stale timer when
the new epoch is admitted keeps it at one request and epoch 2. The regression
injects a valid synthetic peer-unavailable signal plus 2.5 seconds of ordered
signaling latency. The original implementation fails it; the fixed client passes
it and the full browser suite. The subsequent public Oppo recovery also passed.

The original 2 GiB recovery run produced the correct downloaded file and receipt
but reached 282,341,623 bytes of combined JS/backing storage, above the existing
268,435,456-byte ceiling. The ceiling was retained. Full-file hashing now uses a
BYOB stream reader and reuses its returned backing buffer, with a standard reader
fallback for older Blob streams. Independent digest, empty-file, fallback and
read-failure tests pass. Every final matrix case stays below 256 MiB.

The benchmark runner now waits for the asynchronous receive policy before
checking a large-file acknowledgement, records safe failure stages and sampling
gaps, checks disk headroom, and rejects mismatched/stale child reports. A failed
run with a long signaling interruption and an isolated stalled retry remain
failures; they were not counted as successes. The final matrix used a temporary
sleep/idle inhibitor that ended with its process. About 17 GiB of disposable
synthetic fixtures/profiles from old runs was removed while preserving reports.
No personal files were removed. The memory defect also occurred with adequate
disk, so disk cleanup is not presented as its fix.

## Automated verification

The final application code passed **564 unique automated tests**:

| Group          | Passed | Coverage                                                                                                |
| -------------- | -----: | ------------------------------------------------------------------------------------------------------- |
| Core           |    453 | 29 files covering unit, security/fuzz/property, Worker/SQLite/WebSocket integration and faults          |
| Browser        |    106 | Complete browser run, including delayed-retry regression, real Firefox/WebKit and mobile viewport cases |
| Production PWA |      5 | Production CSP/privacy, UI-only cache, offline verified export and lifecycle behavior                   |

Provider tests include short TTLs, fixed endpoints, malformed/oversized responses,
embedded-secret denial, near-expiry denial and readiness without provider calls.
Existing admission and source authentication still precede credential issuance.
Repeated focused tests are not added to the unique count. See
[check evidence](evidence/phase-9-checks.json).

Workspace/root type checking, ESLint, formatting, secret checks, application
builds and the Worker deployment dry run pass. The dependency audit reports zero
known vulnerabilities after a registry timeout/retry. Final edits after the
application test runs were documentation and verification tooling. Browser
binaries and pnpm were restored under ignored workspace artifacts after `/tmp`
tooling was cleared. WebKit's required shared libraries were extracted locally
from checksum-verified official packages; its ignored launcher forwards that
library path. This Linux WebKit run does not certify physical Safari/iPhone.

## Large-file benchmark results

All six cases used fresh Chromium 156.0.8078.4 profiles and rooms against a local
Worker and frozen production client containing both fixes. The matrix records
`pass=true` and `fullSizeMatrix=true`. Each case independently hashes the exported
download and validates the receipt and diagnostics. Recovery cases compare fresh
codes, retain verified blocks and send only missing payload.

| File size | Scenario              | Elapsed seconds | Peak combined JS/backing storage, MiB | Verified bytes reused |
| --------- | --------------------- | --------------: | ------------------------------------: | --------------------: |
| 100 MiB   | Normal                |            15.6 |                                 125.1 |                     0 |
| 100 MiB   | Controlled disconnect |            24.2 |                                 137.5 |            73,400,320 |
| 1 GiB     | Normal                |           127.3 |                                 190.8 |                     0 |
| 1 GiB     | Controlled disconnect |           183.1 |                                 229.9 |           751,828,992 |
| 2 GiB     | Normal                |           271.7 |                                 229.7 |                     0 |
| 2 GiB     | Controlled disconnect |           305.7 |                                 202.4 |         1,503,657,984 |

The largest observed total was 241,117,261 bytes, below the unchanged 256 MiB
ceiling. All cases respected the sender's 512 KiB channel buffer and 1 MiB block
ceilings and the receiver's 1 MiB block/2 MiB queue ceilings. These results show
bounded measured JS-owned memory across the tested file sizes; they do not prove
total browser RSS is bounded by 256 MiB.

CDP samples both page isolates and their dedicated workers every 500 ms, without
forced GC, including ArrayBuffer/external-string backing storage. Maximum
observed gaps were 543–591 ms. Native WebRTC buffers, OS cache and total process
RSS are outside this metric. Timing includes hashing/recovery and uses loopback;
it is not a public internet throughput measurement. Controlled disconnect uses
browser network denial/offline lifecycle at a verified block boundary, separately
from the real phone radio outage below. See
[reviewed matrix evidence](evidence/phase-9-benchmarks.json) and
[benchmark reproduction](../../scripts/benchmarks/README.md).

## Public and physical-device verification

The public HTTPS/WSS smoke passed shell/CSP/readiness, exact-origin denial,
create/join/approval, direct-only ICE issuance, actor JOINED through the private
Pages binding, independent operator authorization, socket closure and ticket
revocation. See [public control-plane evidence](evidence/phase-9-public-smoke.json).

The Oppo F19 Pro, Android 13, Chrome 155.0.8059.79 and laptop Chromium 156 passed:

- **Public Wi-Fi, 8 MiB:** create invitation → approve → compare codes → transfer
  → native Android download → independent SHA-256 → receipt/diagnostics export.
- **Public Wi-Fi recovery, 32 MiB:** pause at a verified boundary → disable phone
  mobile fallback and Wi-Fi → observe real offline/reconnecting state → restore
  Wi-Fi → compare fresh codes at epoch 3 after epoch 1 → resume. It reused exactly
  24,117,248 bytes (23 MiB), sent only the remaining bytes, and produced the exact
  native Android file hash, receipt and diagnostics.
- **Existing phone mobile data, 1 MiB:** with Wi-Fi disabled, public HTTPS/WSS
  admission, code comparison, direct transfer, native Android download, exact
  SHA-256, receipt and diagnostics all passed. Both devices loaded the current
  `/assets/index-BisTmpzy.js` client. No stale-shell bypass was needed.

See [Wi-Fi evidence](evidence/phase-9-public-oppo.json) and
[mobile-network evidence](evidence/phase-9-public-mobile.json). Both runs selected
a **direct** path with ordinary browser networking defaults and zero observed
CSP/API HTTP errors. USB was used for debugging only; no USB reverse forwarding
carried application traffic. Wi-Fi and the original mobile-data setting were
restored. No plan was activated. Automation attached only to its own new Chrome
tab and pulled exact synthetic download names; personal tabs and other Downloads
were not inspected. Test transfer data was cleared from the browser afterward.
The phone can be disconnected now.

These small public physical transfers and the separate local 2 GiB measurements
do not certify 2 GiB phone delivery, every mobile carrier/router, background
delivery, native Share, optical QR, or PWA installation. Physical
iPhone/Windows/macOS coverage remains pending where required by the supplied plan.

## Operations and rollback

The local persisted-state drill passed P9 create/admit → P8 reads the same
approved SQLite room → P9 drain/read/close. See
[local rollback evidence](evidence/phase-9-local-rollback.json).

The public preview drill created and approved a synthetic room on Worker
`9da41241-eb08-4675-8268-b6f72a6e390f`, rolled back to recorded version
`97ca9828-267a-41ff-8a84-e4f320aa839d`, and verified the same approved persisted
room. It restored the latest version and rechecked readiness and room access.
The room was then closed. See
[public rollback evidence](evidence/phase-9-public-rollback.json).
**Pages assets were unchanged:** this is Worker rollback/restore evidence, not
Pages rollback or SQLite backup restoration. Protocol v1 and SQLite migration v1
remain unchanged. Rate limits, TTL/alarm cleanup, operator revocation, drain and
gateway outage behavior pass automated local tests; remote quota notifications
and a full paired-product rollback remain unverified.

## Free-only constraint and open release gates

The owner requires free services and no paid plan/billing activation. The preview
remains `TURN_PROVIDER=direct`. No TURN key, payment method, paid service or domain
purchase was created. The existing deployment OAuth token returned 403 for TURN
management and does not grant Calls permissions. Cloudflare's initial TURN
allowance is not a guaranteed spending cap. The implemented adapter stays
disabled until a compatible no-charge setup is verified; application logs cannot
enforce provider billing. See [TURN operations](../../infrastructure/turn/README.md).

The open release items are:

1. Verify a relay setup under the free-only constraint, then prove forced relay,
   UDP-blocked TCP/TLS fallback, capacity and bandwidth monitoring. Direct paths
   passed on the tested networks; restrictive networks can still fail.
2. Configure and verify account quota/failed-join alert destinations. A runbook
   and sampled logs do not prove operational alert delivery.
3. Configure actual GitHub environment protections if the manual CI deployment
   path is used; prove Pages rollback alongside the tested Worker rollback.
4. Complete remaining physical iPhone/Windows/macOS evidence required by the
   supplied cross-phase device gates. Engine tests do not replace those devices.
5. Provision/publish and accept the separate production environment after the
   preceding release gates. The current public address is the preview.

No universal connection guarantee, free unlimited TURN or universal mobile
large-file support is claimed. The local full-size matrix and the public Oppo
demonstration are complete within their recorded scopes.

## Reproduction and commit command

See [deployment](../deploy.md), [operations](../runbook.md),
[benchmarks](../../scripts/benchmarks/README.md), [support](../support-matrix.md)
and [user guide](../user-guide.md). Credentials belong only in ignored private
`.env` files or deployed secret stores. `.env.example` contains field names only;
Wrangler retains OAuth credentials in its private CLI store. Verified deployment
`.env` files have mode 0600 and are excluded by `.gitignore`.

After reviewing the local diff, create a checkpoint commit with:

```sh
git add .
git commit -m "feat: add Cloudflare deployment and phase 9 release tooling"
```

This does not push or mark open release gates complete. No commit or push was
executed by the agent.
