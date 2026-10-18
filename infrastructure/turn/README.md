# TURN operations

Cloudflare Pages/Workers host the control plane. They do not host coturn or
provide free unlimited relay bandwidth. A TURN service needs a public VPS or a
managed provider. No paid service is provisioned automatically. This project's
current authorization is **free services only, with no billing activation or
paid plan**. The deployed preview remains `TURN_PROVIDER=direct` until the account
can supply a relay with a verified no-charge boundary.

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
