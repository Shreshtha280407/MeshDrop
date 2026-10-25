# TURN operations

Cloudflare Pages/Workers host the control plane. They do not host coturn or
provide free unlimited relay bandwidth. A TURN service needs a public VPS or a
managed provider. No paid service is provisioned automatically. This project's
current authorization is **free services only, with no billing activation or
paid plan**. Preview and production now use `TURN_PROVIDER=metered` with a verified Free
0.5 GB shared monthly hard stop. Cloudflare Realtime TURN and coturn remain
optional alternatives, disabled in the current deployment.

## Cloudflare Realtime TURN

The Worker supports Cloudflare's credential-generation API separately from the
coturn HMAC contract. In the target's private deployment `.env`, set
`TURN_PROVIDER=cloudflare`, `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`; leave both coturn fields empty. Create a separate key
for each environment in Realtime → TURN. Wrangler's Pages/Workers OAuth scopes
do not grant `Calls Write`, so an existing deployment login cannot create those
keys. A TURN key is a long-term provider secret, not a browser credential.

Only approved members may request credentials. The Worker calls the fixed HTTPS
provider endpoint with just a short TTL, checks the deadline and bounded JSON,
restricts returned relay URLs to Cloudflare's documented hosts/ports, and returns
only temporary usernames/passwords. Keys stay in Worker secrets and ignored
`.env` files. Provider outages return a generic 503. Readiness validates local
configuration without making credential requests; the public smoke test checks
actual issuance separately. A five-second deadline reserve keeps issued TTLs
inside the room lifetime, and clients use the earliest conservative expiry.

Cloudflare currently includes the first 1,000 GB/month shared across TURN and
SFU, then charges $0.05/GB egress. That is an allowance, **not a hard spending
cap**. No account-wide hard cap has been verified for this project. Do not enable
a billable relay merely because its initial usage is free. Do not add payment
details or subscribe under the current free-only authorization. Provider usage
and alerts at 50/80/95% of an approved budget are required before release;
application byte counters and sampled logs are not billing counters.

References: [credential generation](https://developers.cloudflare.com/realtime/turn/generate-credentials/),
[pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/),
[TURN key permissions](https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/).

## coturn alternative

The Worker also implements **coturn TURN REST**, using expiry-bound usernames
and HMAC-SHA1. A managed provider must explicitly support this contract; an
arbitrary provider API key is not a compatible shared secret. Use independent
preview/production instances and secrets. Keep the static shared secret only in
the VPS `.env` and the selected deployment `.env` (0600). Temporary credentials
go only to approved room members and expire within 300 seconds by default.

Use `turnserver.conf.example` as a starting point with a maintained, pinned
coturn package. Set the real hostname, TLS certificate paths and public/private
IP mapping if the VPS is behind NAT. Render a private runtime config from `.env`
with file mode 0600; do not place secrets in process arguments. Firewall inbound
UDP/TCP 3478, TCP 5349 and UDP 49160–49259. Permit outbound relay traffic only to
public peers. Review IPv6 rules for the host; private-network destinations must
remain blocked. Do not put this behind an ordinary HTTP proxy.

Set `TURN_PROVIDER=coturn` and configure `TURN_URLS` in the deployment `.env`, for example:
`turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp`.
Use the matching `TURN_SHARED_SECRET`. The template limits 100 allocations,
4 per temporary username, 12.5 MB/s per allocation and 50 MB/s aggregate. These
are starting ceilings, not throughput promises. A user can obtain multiple
temporary usernames, so per-user quota is not a unique-person spending limit.
Existing room/API credential-issuance budgets also apply.

Meter network-interface ingress/egress on the relay host and reconcile daily with
the provider's billed bandwidth. Track active allocations, rejected allocations,
authentication errors and capacity drops. Keep logs private and short-lived:
coturn/provider logs can reveal IPs and temporary usernames. Do not enable verbose
logs or username-labelled public metrics. Alert at 50/80/95% of the selected
monthly bandwidth budget and 80% of allocation/network capacity. A 1 GiB file can
traverse multiple charged links and incur retransmission/protocol overhead; the
provider's billing policy is the cost source of truth. Configure its spending cap
before exposing the relay publicly.

Before release, force a relay-only connection using the relay test harness in
`scripts/local-dev/verify-relay.ts`, then run a real cross-network device transfer
and independent digest/export. Its local synthetic relay tests from P2 do not
certify a new public relay. Test UDP blocked so TCP/TLS fallback is actually used.
Relay unavailability must produce an explicit connection failure; no file-server
upload fallback exists. Direct-only is permitted as an explicitly limited preview
with `TURN_PROVIDER=direct` and all provider fields empty; it does not meet the restrictive-network P9
release gate. Removing relay from an existing deployment also requires removing
its old server secret (see the deployment runbook).

Configuration reference: [coturn's maintained configuration example](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

## Metered Free relay pool

The `metered` adapter supports the verified $0/month 500 MB plan whose service
stops at its monthly quota. It requires `METERED_DOMAIN`, `METERED_SECRET_KEY`
and the explicit `METERED_FREE_ONLY=true`; leave other providers' settings empty.
The adapter rejects a changed quota, nonzero overage or invalid usage response.
This validation supplements the provider's hard stop; a lagging API counter
cannot enforce a spending limit on a paid account. Never upgrade this account or
add payment details under the project's current authorization.

The SQLite `RelayPool` creates ten-minute credentials ahead of use, waits the
provider's full two-minute propagation window, and rotates every five minutes
with overlap. Its alarm and the deployment cron keep the small pool warm.
Credentials are issued only after room approval, and only when their latest
possible expiry is inside the room lifetime. Cold starts, unknown usage and
provider errors return direct/STUN-only configuration. `/ready` validates local
configuration; it does not assert that a relay key is ready. Operators can use:

```sh
pnpm ops:warm-relay preview
pnpm ops:status preview
```

Usage is refreshed at most once a minute. New issuance stops at 0.45 GB, reserving
the last 10% for in-flight allocations; a `relay_quota` alert starts at 0.4 GB.
Existing allocations can continue until provider expiry or its quota hard stop.
The shared free quota is not separate preview and production allowances. The
pool has at most two live credential records per deployment; this is not a
measured simultaneous-transfer capacity guarantee.

`pnpm verify:free-relay` runs actual MeshDrop admission, comparison, transfer,
committed storage, independently hashed file export, receipt and diagnostics
through the real provider over UDP, TCP and TLS. It uses port 5193 and an isolated
local Worker. Put only the provider settings and explicit free-only confirmation
in mode-0600 `.meshdrop-artifacts/relay-cloud/.env`. The runner makes at most
three 1 MiB transfers, then closes its rooms, browsers, web server and Worker.
Reports remain ignored. Each credential expires naturally in ten minutes.

TCP/TLS use the browser's UDP-disabled policy in the normal runner. For a genuine
OS test, run it inside a disposable isolated network namespace with OUTPUT UDP
blocked except DNS, verify the firewall counter, and set
`MESHDROP_TEST_UDP_BLOCKED=true` inside that namespace. That flag is an external
assertion, not firewall proof. Never change the developer's host firewall. The
25 October audit separately records a successful isolated Docker firewall test.
These are real remote relay transfers with local signaling, not hosted-production
or physical cross-network device acceptance.

References: [credential propagation and rotation](https://www.metered.ca/docs/turnserver-guides/rotating-turn-credentials/),
[temporary credential API](https://www.metered.ca/docs/turn-rest-api/post-create-credential/),
[provider usage](https://www.metered.ca/docs/turn-rest-api/get-current-usage/).

## Hosted acceptance — 25–26 October 2026

Both deployed environments passed actual UDP/TCP/TLS 1 MiB MeshDrop transfers
and two simultaneous 1 MiB pairs, with independent saved-file hashes, receipts
and diagnostics. The physical Oppo passed production 8 MiB receive/export and
32 MiB actual Wi-Fi outage/recovery/export, reusing 23 MiB. Selected candidate
types were relay at both endpoints. USB carried debugging only. These measured
sizes and four-peer load do not establish maximum size or concurrency. See the
[hosted release evidence](../../docs/reports/evidence/phase-9-hosted-release.json)
and [physical Android evidence](../../docs/reports/evidence/phase-9-android-production-relay.json).
