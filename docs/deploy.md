# Cloudflare deployment

**Current boundary:** start with [CURRENT_STATUS](CURRENT_STATUS.md) and the [release provenance/admission procedure](release-provenance.md). Versioned preparation, read-only provider observations and approval/recovery verification foundations exist. The real publisher and hosted approval/acceptance authority remain unconfigured and fail closed. The read-only adapter does not enable publication. Task10D and Task11B were deliberately skipped; their trust/isolated-preview evidence is not established. Historical examples below grant no permission to configure or mutate hosted resources.

P9 runs on Cloudflare Pages plus separate private Workers with SQLite Durable
Objects. [Production](https://meshdrop-7ce2dc2e-production.pages.dev) and
[preview](https://meshdrop-8ab9cb08-preview.pages.dev) were recorded as deployed in the dated P9 evidence; current deployment identity/availability was not read during Task 18. The laptop can be
switched off unless it is transferring a file; no tunnel or local server hosts
the deployed site. Hosted control-plane and UDP/TCP/TLS relay checks, real HTTPS
alert-journal delivery, request analytics and environment isolation passed in those historical scenarios. Physical
production Android receive/export and Wi-Fi outage/recovery also have dated evidence. The compatible
v2 paired rollback drill passed in preview. See the [dated P9 audit](reports/continuation-2026-10-25.md)
for actual scope and limits.

The owner requires free services only. No billing activation, paid plan or payment
method is authorized. Both environments use Metered Free with a shared 0.5 GB
monthly service hard stop in P9 configuration; the historical provider check reported zero Cloudflare
subscriptions and zero relay overage. Current account plans/balances were not queried. The Cloudflare Realtime TURN adapter is
implemented but disabled because an included allowance alone is not a hard
spending cap. See [TURN operations](../infrastructure/turn/README.md).

## Environments and request path

The original P9 projects could share provider-account quotas. The later [isolated preview/canary contract](preview-canary.md) instead requires a genuinely separate preview account plus independently reviewed production deny pins. The old public preview is not proof that this later contract has been configured or validated.

Each environment has its own Pages project, signaling Worker, SQLite namespace,
rate-limit namespaces, operator secret and optional TURN service/secret. Local
development continues using the loopback Wrangler configuration. A Pages module
Worker forwards `/v1/*`, `/ops/*`, `/health` and `/ready` through a private service
binding; it serves remaining GET/HEAD requests through `ASSETS`. HTTPS and WSS use
the same public origin. The signaling Worker has no public workers.dev route.
The gateway rejects branch/hash aliases, preserving exact-origin authorization.
Share the stable project URL only. Preview uses a separate stable Pages project,
not a production binding attached to an arbitrary Git branch.

The gateway adds browser security headers to Function-served assets; `_headers`
alone does not protect those responses. Requests and errors remain uncached.
Files never pass through Pages, Workers or SQLite. Keep both transfer devices
online and MeshDrop open. See [ADR 005](adr/005-production-hosting.md).

## First account and local preparation

1. Create and verify a [Cloudflare account](https://dash.cloudflare.com/sign-up).
   Use the free plan for the initial deployment. A paid domain is optional.
2. Run the initializer once per environment (do not overwrite an existing `.env`):

   ```sh
   pnpm deploy:cloud init preview
   pnpm deploy:cloud init production
   ```

3. Edit `infrastructure/cloudflare/preview/.env` and `production/.env` locally.
   The initializer already generated unique project names and independent random
   operator secrets. Copy the account ID from your dashboard into each private
   file. Keep mode 0600. Never put keys in chat, source, `vars`, frontend `VITE_*`
   configuration or command arguments. A checked-in `.env.example` documents keys.
4. Authenticate interactively:

   ```sh
   pnpm --filter @meshdrop/signaling exec wrangler login --scopes account:read user:read workers_scripts:write pages:write
   ```

   Wrangler manages its OAuth credentials in its own private CLI store. If you
   prefer API-token authentication, keep `CLOUDFLARE_API_TOKEN` in the target `.env`
   instead. Restrict it to the intended account and the Pages/Workers/Durable
   Objects operations required by Wrangler. Do not grant zone/DNS permissions
   for a pages.dev deployment. No Neon database or Railway service is needed.

5. Build and validate without publishing:

   ```sh
   pnpm deploy:cloud prepare preview
   pnpm deploy:cloud dry-run preview .meshdrop-artifacts/deploy/preview/run-EXACT_DIRECTORY
   ```

   `.meshdrop-artifacts/deploy/preview/` contains a frozen Worker bundle, static
   assets, the Pages gateway, two Wrangler configurations and a SHA-256 manifest.
   There are no static secrets in those bundles/configurations. Current `publish` validates the exact release directory and records a blocked publication before credential access; it does not upload. Private runtime configuration stays outside public evidence.

## Historical provisioning reference; publication remains blocked

A brand-new account needs a free Workers subdomain even with `workers_dev: false`.
Run `pnpm deploy:cloud bootstrap preview` once to initialize one only when absent;
existing subdomains are preserved. You can alternatively open Workers & Pages in
the dashboard to finish first-time setup. This does not buy a domain or expose
the signaling Worker. The account-level subdomain is shared infrastructure;
preview and production room namespaces and URLs remain separate.

The provisioning command below is a real external mutation requiring separate operator authorization. The publication example names the required exact directory, but deliberately fails closed in current source; it is not an executable rollout procedure:

```sh
pnpm deploy:cloud provision preview   # once; creates only the named Pages project
pnpm deploy:cloud publish preview .meshdrop-artifacts/deploy/preview/run-EXACT_DIRECTORY # blocked
```

The production branch for each standalone Pages project is `release`, independent
of the local Git branch. The script uploads directly from disk. It never stages,
commits or pushes Git, and does not connect a GitHub repository to Cloudflare.
Public permission is configured in the Cloudflare account; protect that account.

Recent Wrangler versions delegate first-time Pages project creation to Workers
Assets by default. The provisioner uses the native Pages `--force` option only on
initial creation to select the architecture specified here. This flag selects the
hosting product; it is not a repository force-push or an overwrite. Subsequent
deployments use the existing Pages project without it. OAuth needs
`workers_scripts:write`; the legacy `workers:write` scope alone cannot deploy this
Worker with current permissions.

Production publication remains unavailable even after local preparation or a preview result. Do not repeat this reference as a production rollout or reopen admission; current release trust and explicit authorization requirements still apply. An already existing Pages project does not need `provision` again.
Each `.env` must use a project name ending in its own environment. Public origin
defaults to `https://PAGES_PROJECT.pages.dev`; a custom origin requires its domain
binding and TLS to be configured before changing `PUBLIC_ORIGIN`. Changing origin
changes browser storage scope: files saved under the old origin do not migrate.

The publisher explicitly uploads every supported provider secret, including empty
values for unused providers, so a provider switch clears stale bindings. Set
`TURN_PROVIDER=direct` and clear all provider settings in the target `.env` to
remove relay availability; then prepare/dry-run/publish. Verify `/ready` and the
operator relay status after switching. API-side secret deletion remains available
for leaked keys; revoke or rotate the provider credential as well.

The free Metered adapter requires `METERED_DOMAIN`, `METERED_SECRET_KEY` and
`METERED_FREE_ONLY=true`, with other providers' fields empty. Migration v2 adds
`RelayPool` and `OperationsMonitor`; its cron warms the pool once per minute.
Follow the [relay lifecycle and quota policy](../infrastructure/turn/README.md#metered-free-relay-pool)
and [operator commands](runbook.md#free-operational-counters-and-webhook-journal).
A cold pool deliberately offers direct connectivity until keys have propagated.
Keep a compatible v2 Worker baseline for rollback before enabling the provider.
Do not deploy an old v1-only version after applying the new actor migration.

## Release checks

Run `pnpm check` and `pnpm audit:release`. On the deployed stable HTTPS URL verify
the shell CSP, `/ready`, exact-origin admission, WSS upgrade, two-device code
comparison, exact downloaded hash, disconnect/fresh comparison/resume, diagnostics
and receipt export. Perform one home-Wi-Fi and one mobile-network run with the
real Oppo/laptop. Test forced TURN and UDP-blocked TCP/TLS fallback once a relay is
configured. Run [the benchmark matrix](../scripts/benchmarks/README.md) against the
deployed origin. Two local browser profiles using a remote server still do not
prove the physical/mobile matrix. Remaining iPhone/Windows/macOS coverage stays
explicit in the [support matrix](support-matrix.md).

The authorized Android smoke uses only a new test tab and exact synthetic files.
Connect the unlocked device, enable USB debugging, forward its Chrome debugging
socket, and keep Chrome open. Use the serial from `adb devices`:

```sh
adb -s DEVICE_SERIAL forward tcp:9223 localabstract:chrome_devtools_remote
MESHDROP_ANDROID_SERIAL=DEVICE_SERIAL MESHDROP_TEST_URL=https://YOUR_STABLE_PROJECT.pages.dev pnpm verify:phone
MESHDROP_ANDROID_SERIAL=DEVICE_SERIAL MESHDROP_TEST_URL=https://YOUR_STABLE_PROJECT.pages.dev MESHDROP_PHONE_NETWORK=mobile pnpm verify:phone
```

The default run transfers 8 MiB and exercises a real Wi-Fi outage/recovery with
32 MiB, temporarily disabling mobile fallback. The optional mobile run requires
already-enabled mobile data, disables Wi-Fi and transfers only 1 MiB. Both restore
network settings afterward; neither buys or activates a plan. Use only with the
device owner's permission and existing data allowance. Reports and synthetic
exports stay in ignored `.meshdrop-artifacts/phase-9/phone-*` directories. The
script verifies the current deployed client module and can bypass a stale shell
in its own target without deleting shared site storage or personal tabs.

## Optional manual CI deployment

The checked-in deployment workflow is manual (`workflow_dispatch`), restricted to
the repository default branch and preceded by the complete CI phase gates. There
is no push-triggered deployment. Create separate GitHub Environments `preview`
and `production` with the matching project/account/origin/TURN URLs as variables
and account token/operator/TURN secrets as environment secrets. Cloudflare TURN
uses its dedicated key ID/API token; coturn uses its shared HMAC secret. Set
`TURN_PROVIDER` to match and leave unused provider fields empty. Configure required
reviewers and branch protections in GitHub; YAML cannot create those protections.
The job writes a temporary 0600 `.env`, builds and publishes, then removes it.
Use a token with the narrow account scope described above. Provision the Pages
projects locally first. No raw browser reports or secret files are uploaded as
workflow artifacts. Physical acceptance remains a separate release decision.

## Capacity and costs

Set usage alerts for both Workers/Pages Functions and Durable Objects. Every
request traversing this gateway invokes a Pages Function, including assets; do
not describe it as unlimited free dynamic traffic. Watch requests, CPU errors,
SQLite reads/writes/storage and daily/monthly plan usage at 50/80/95% of quota.
Sampling means audit logs cannot serve as exact billing counters. Use Cloudflare's
usage dashboard as the quota source of truth. A free-plan quota outage is an
outage, not automatic free extra capacity. A paid upgrade requires an explicit
budget decision. TURN bandwidth and capacity are separate; see
[TURN operations](../infrastructure/turn/README.md).

Official references: [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[service bindings](https://developers.cloudflare.com/pages/functions/bindings/),
[Durable Object environments](https://developers.cloudflare.com/durable-objects/reference/environments/),
[Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Current deployed environments — 25–26 October 2026

- Production: <https://meshdrop-7ce2dc2e-production.pages.dev>
- Preview: <https://meshdrop-8ab9cb08-preview.pages.dev>

Both use the verified Workers Free account and the Metered Free quota hard stop.
They have independent room/rate namespaces and operator proofs; they share the
provider account quotas. File bytes remain on peers or the separately managed
relay. Actual hosted UDP/TCP/TLS, two simultaneous small transfer pairs, HTTPS/WSS
control denial/revocation, failed-join webhook delivery and provider request
monitoring passed. Actual preview/production room and operator crossover is denied.
The preview v2 rollback/restore passes with persisted-room and real transfer
checks at each stage. GitHub deployment workflows still require the owner's
manual push and environment configuration; no repository push was performed.
