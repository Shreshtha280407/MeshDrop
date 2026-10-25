# MeshDrop implementation audit — 25–26 October 2026

This continues baseline `2cfc05c` against both supplied MeshDrop PDFs. The supplied
plan ends at P9. Implementation exists through P9; acceptance below records the
actual tested scope. The user deferred further iPhone work. Existing staged
changes were preserved; no Git commit or push was performed. No PARAKH document
or keystore belongs to this audit.

The [production site](https://meshdrop-7ce2dc2e-production.pages.dev) and
[preview](https://meshdrop-8ab9cb08-preview.pages.dev) are live on Cloudflare
Pages/Workers with Metered Free TURN. No Railway, Vercel or Neon migration was
needed. Both deployments run independently of the developer's laptop.

## Phase status

| Phase | Implementation and acceptance                                                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Workspace, strict contracts, state machines, CI and golden fixtures implemented; recorded foundation gate passed.                                                                                                                                                     |
| P1    | SQLite rooms, capabilities, admission, origin/rate/TTL checks and revocation implemented; local and deployed checks passed.                                                                                                                                           |
| P2    | Authenticated pairing, separate code comparison, epochs, approved temporary ICE credentials and free relay implemented. Hosted UDP/TCP/TLS and physical Android relay delivery passed.                                                                                |
| P3    | Streaming, hashes, bounded buffers, committed-storage ACKs, pause/cancel and receipts implemented. Recorded exact 1 GiB exported bytes and bounded-memory gate passed.                                                                                                |
| P4    | OPFS/IndexedDB checkpoints, quota/retention, reconciliation and rehashing implemented. Recorded 300+ MiB reopen/recovery gate passed.                                                                                                                                 |
| P5    | Source identity, renewed authorization/epochs and missing-only authenticated resume implemented. Recorded 1 GiB gate and new physical production 32 MiB relay outage/recovery passed.                                                                                 |
| P6    | Measurement provenance, rates, diagnostics, bounded local history and exports implemented; pause/recovery/export checks passed.                                                                                                                                       |
| P7    | Capability checks, foreground policy, save/share adapters, responsive controls and PWA implemented. Physical Android downloads and relay recovery passed; native chooser/install results are recorded separately below. Further native iPhone work is deferred.       |
| P8    | Threat/privacy boundaries, bounded input, CSP, safe filenames and abuse/fuzz checks implemented; security suite and patched dependency audit passed.                                                                                                                  |
| P9    | Preview/production isolation, free managed relay, provider request analytics, alert journal, paired v2 rollback, benchmarks and runbooks implemented. Actual hosted delivery, webhook delivery, isolation and rollback gates passed within the measured scopes below. |

The earlier [full audit](implementation-audit-2026-10-21.md) maps all P0.1–P9.6
tickets and source PDF fingerprints. Earlier passing and failing results retain
their dated scope. A complete implementation does not establish every browser,
carrier, file size or native platform workflow.

## Changes delivered

A SQLite relay pool requests ten-minute Metered credentials, waits two minutes
for propagation and rotates with overlap. Only approved peers receive temporary
credentials, bounded by the room lifetime. The adapter requires the known
0.5 GB Free quota and zero overage, stops new issuance at 0.45 GB, and falls back
to direct connectivity if relay availability or usage cannot be established.
The provider's verified Free hard stop is the no-charge boundary. Master and
credential-scoped provider keys stay server-side.

Independent aggregate and journal actors implement authenticated HTTPS alerts,
bounded retention, retries and idempotent delivery. Failed joins, server errors,
control request budgets and relay quota thresholds use redacted fixed schemas.
Cloudflare account analytics covers Workers plus Pages requests and Durable
Object requests; unknown measurements never become zero. The read-only token
expires on 23 January 2027 and needs rotation before then. Provider analytics
can be sampled/delayed and is not an invoice or exact real-time spending cap;
duration and storage quotas still need separate provider inspection. Alerts are
available in a private polling journal; no email or human-recipient message was
sent. Both environments passed actual failed-join → monitor → HTTPS webhook →
independent journal delivery.

The Worker runtime rejected `fetch` with `redirect: 'error'`. Provider adapters
and the webhook sender now use `manual` and reject unexpected responses. Frozen
deployment tooling clears unused provider secrets explicitly when switching
providers. Additive SQLite migration v2 introduces the relay/monitor actors;
room migration v1 is unchanged.

Vitest is patched to 4.1.12 and undici 7.x to 7.30.1. The forged-checkpoint
regression waits for the receiver's asynchronous storage-lock handoff before
fault injection; exclusive locking remains enforced. Three focused repeats and
the final complete suite passed. Android/cloud verification tools now record
actual selected relay candidates, and native iOS lifecycle tooling uses the
provider's OS commands without foregrounding Safari through script probes.

## Deployment and free-plan evidence

Both hosted environments passed actual 1 MiB MeshDrop transfers over UDP, TCP and
TLS: admission, approval, code comparison, signed ping, committed storage, exact
saved-file SHA-256, receipt and diagnostics. Two simultaneous rooms/four peers
also passed at 1 MiB per pair. This is measured small-file load, not a maximum
concurrency guarantee. A separate local-signaling Docker test blocked outbound
UDP except DNS at the OS firewall: TCP/TLS transfers passed with 15 dropped UDP
packets; the host firewall was unchanged.

Preview and production have separate private Workers, room/relay/monitor
namespaces and operator proofs. Actual cross-environment room access returned
404, the other operator proof returned 403, and each own room remained accessible.
They share Cloudflare account and Metered quotas. The latest read-only provider
check at 18:35 UTC on 25 October returned no Cloudflare billable coverage, zero
subscriptions, and Metered usage 0.17/0.5 GB with zero overage. The Metered
dashboard confirmed $0/month and a service hard stop at the Free allowance.
No payment method, paid plan, billing activation or domain purchase was used.

See [hosted release evidence](evidence/phase-9-hosted-release.json),
[local relay/firewall evidence](evidence/phase-9-free-relay-integration.json),
[deployment guide](../deploy.md) and [operations runbook](../runbook.md).

## Rollback acceptance

The actual paired v2 preview drill passed persisted-room and fresh 1 MiB
transfer/export/receipt/diagnostics checks before rollback, during rollback and
after restoration. Both original component versions were restored and test rooms
closed. Both versions serve the same frontend asset digest; this drill verifies
backend/configuration switching. It does not claim changed frontend bytes.

Earlier attempts failed safely with Cloudflare 10220 because provider secret
bindings differed. The final tool accepts only an explicit private release record
and a reviewed allowlist of those provider-secret names, retries once for the
matching provider error and rejects operator-secret or unreviewed changes.
The original operator secret was unchanged. Both rollback versions must contain
the v2 actor exports; a v1-only Worker is not a valid rollback target.

## Physical Android and retained iPhone evidence

On the user's USB-authorized Oppo F19 Pro, Chrome 155.0.8059.84, the production
site passed an 8 MiB relay transfer and native download, then a 32 MiB actual
Wi-Fi outage/recovery and native download. Recovery reused 24,117,248 bytes
(23 MiB), advanced epoch 1 → 2 and sent only missing bytes. Exported files
matched independent SHA-256 checks; receipts and diagnostics passed, with zero
CSP/API failures. Both endpoints checked actual relay candidates. USB carried
debugging only, with no reverse tunnel for application traffic. Original network
settings were restored. See [physical evidence](evidence/phase-9-android-production-relay.json).

ANDROID_NATIVE_RESULT_PENDING

Previously completed real cloud iPhone checks additionally passed an 8 MiB
forced-relay receive/export and a 2 MiB forced-relay reload/recovery/export that
reused 1 MiB. Actual provider-returned downloads were independently hashed.
These do not relabel older incomplete export runs as successes. A native
app-background run passed recovery subchecks but could not retrieve exported
bytes; a native lock command was rejected. Those overall cases remain
incomplete. Native iPhone picker/share/install and further iOS lifecycle work are
deferred at the user's request. See [retained evidence](evidence/phase-7-ios-relay-continuation.json).
Optical QR and untested platform/size/network combinations retain their explicit
limits in the [support matrix](../support-matrix.md).

## Final verification

The final full `pnpm check` passed **642 distinct tests**: 406 unit, 42 security,
65 integration, 18 fault, 106 browser and 5 production PWA tests. Package/root
strict types, lint/formatting, secret checks and all builds passed. Dependency
audit reported zero known vulnerabilities. Failed intermediate attempts remain
failed; focused repeats and physical checks are not added to the distinct suite
count. The existing staged patch was verified unchanged.

GitHub CI will run against the pushed revision after the user's manual push.
Ignored private credentials, cloud release records, raw browser/device artifacts
and synthetic local exports are excluded from Git. Only reviewed redacted
summaries are included here.
