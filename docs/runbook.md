# Production operations

Use the exact stable origin and generated configuration for the selected
environment. Keep provider, operator and relay secrets in its ignored `.env`.
Never paste invitations, Authorization headers, WebSocket tickets, SDP/ICE,
filenames or raw network dumps into an incident report.

## Health and outage

`GET /health` is liveness without a room actor. `GET /ready` validates exact
origins, production operator configuration, TTLs and complete ICE/relay settings,
and returns 503 when admission is paused. Neither endpoint proves TURN reachability,
working SQLite bindings or end-to-end file delivery. Use the actual device smoke
test and provider dashboard for those. HTTP 429 carries `Retry-After: 60`.

If the app is unavailable, check Cloudflare status and request/CPU/DO/Pages usage,
then readiness and the selected origin/service binding. An API error must remain
an API error rather than fall through to SPA HTML. The gateway returns a generic
uncached 503 if signaling cannot be reached. Users keep original sources and
retained browser checkpoints; outage alone must never mark a transfer complete.
Existing P2P transport may continue while signaling is down, but new admission or
recovery cannot be promised until the service returns. Do not clear users' site
data as an outage fix.

Set `ADMISSION_PAUSED=true` in the affected deployment `.env`, prepare/dry-run and
publish to stop **new rooms** while existing room operations and closure remain
available. Readiness becomes 503 intentionally; the publish health step reports
that condition after applying the release. This is admission drain, not a total
network kill switch. Restore `false` through the same reviewed path.

## Abuse and revocation

Investigate aggregate failures and provider usage, then revoke an identified room:

```sh
pnpm deploy:cloud revoke production ROOM_UUID
```

The script reads the separate operator proof from `.env`; it is never a URL
parameter or command argument. An owner capability cannot invoke this action.
The Worker and room actor both verify the operator secret. Revocation closes
signaling sockets, clears outstanding ticket proofs and disables further room
access. Already delivered bytes cannot be recalled. A malicious independent P2P
client cannot be forced to erase data; coturn allocations can survive until their
server-side lifetime expires. Rotate a leaked operator secret on the selected
Worker and local `.env`, and review the other environment independently.

## Monitoring without file content

Signaling emits fixed `meshdrop.control` classifications with environment,
operation (`create/join/ws/revoke/control/other`) and numeric response status.
No request ID, room/peer identifier, capability, IP, URL, file content, file hash,
SDP/ICE or request body is included by this application logger. Worker invocation
logs are disabled because they include request URLs. Provider platform metadata
and optional operational tail tools can still reveal identifiers: access is
restricted to operators, with short retention, and is never public evidence.
The configured 10% head sampling makes logs approximate signals. Compare create
successes, join failures, 429/5xx/WS-upgrade status and provider quota trends; a
missed sample does not prove no failure. There is no centralized file telemetry.
Client diagnostics export is user initiated and locally retained.

Alert at quota thresholds from the deployment guide, on sustained 5xx/readiness
failure and failed joins, and on relay bandwidth/capacity from the TURN runbook.
Define actual alert destinations and budgets in the provider dashboard before
claiming monitored production. No alert subscription or paid monitor is silently
created by this repository.

## Rollback

Before each production publish, record the current successful Worker version and
Pages **production** deployment ID in a private release record, along with the
artifact manifest, origin, configuration and timestamp. Keep the prior successful
static bundle until acceptance. Do not record secrets in the release record.
Pause new rooms when practical, then use Wrangler `rollback VERSION_ID --config
.meshdrop-artifacts/deploy/production/worker.json` and roll back Pages to its
recorded production deployment in Cloudflare's dashboard. Choose the matching
frontend/backend pair, verify `/ready` and protocol compatibility, and execute a
new-room/pair/transfer/receipt smoke test before reopening admission. Each action
is separate; rollback is not atomic across products.

Reproduce the local persisted-state drill with `pnpm verify:rollback` (requires the
P8 baseline commit in local Git history). It reads the old source into ignored
artifacts, creates/adopts/approves a P9 room, reads it using the P8 Worker, then
rolls forward and checks existing-room access/closure during admission drain. It
never changes Git or cloud deployments. `pnpm verify:public preview` separately
checks the public HTTPS/WSS admission/revocation path with a synthetic room.

`pnpm verify:public-rollback preview` **changes the public preview Worker** to a
previous recorded version, verifies the same persisted approved synthetic room,
then restores the latest recorded version in `finally` and verifies readiness
and room access. It requires a single active version and an actual previous
version, reads account authentication privately, closes its test room afterward,
and is restricted to preview. Run only during an authorized preview maintenance
window. The recorded P9 drill passed and restored the latest Worker; see
[reviewed evidence](reports/evidence/phase-9-public-rollback.json). It does not
change Pages assets or prove a Pages rollback.

Code rollback does not restore a SQLite backup or undo migrations. P9 introduces
no SQL schema change; the v1 SQLite migration and P8 actor tables remain compatible.
Future migrations must remain readable by the previous release or block rollback
until an explicit forward recovery is prepared. Existing rooms have short TTLs
and capability state; version changes do not extend expired invitations or restore
memory-only browser secrets. If no previous healthy release exists, repair and
redeploy rather than invent a rollback target. Public Worker rollback/restore is
verified in preview; a matching Pages rollback and production drill remain pending.

## Retention and cleanup

Room/invitation/ticket defaults are 900/300/30 seconds. Actor alarms purge all
room/peer/invitation/ticket/budget rows after closure plus the 60-second tombstone;
alarms may execute late. Verify this with local integration tests, and monitor DO
storage growth remotely. Browser file retention is separate (24 hours or 7 days,
enforced on the next access); Cancel/Clear/Delete saved purges that transfer's
scoped bytes. Clearing a cloud room cannot erase browser files.

Local automation covers rate limits, TTL/alarm cleanup, proof denial, operator
revocation, admission drain, configuration failure and gateway outage behavior.
Cloud quota alerts, paired Pages/Worker production rollback and seamless physical
Wi-Fi/mobile handover need separate evidence. The P9 Oppo test exercised a real
Wi-Fi outage/recovery and a separate mobile-data transfer, not seamless handover.
Never deliberately exhaust a paid public quota as
a test; simulate outages in preview and verify fail-closed behavior.
