# Cloudflare deployment

P9 targets Cloudflare Pages plus a separate Worker with SQLite Durable Objects.
Once published, the laptop is not the host and can be switched off, unless it is
one of the devices transferring a file. No tunnel or always-on local server is
required. The public preview is [available here](https://meshdrop-8ab9cb08-preview.pages.dev).
Its physical Oppo Wi-Fi recovery/mobile-data checks, public Worker rollback and
the separate six-case local full-size benchmark matrix pass. Production release
is pending relay, account alerts and remaining physical-platform acceptance;
see the [P9 report](reports/phase-9.md) for measured scope.

The owner requires free services only. No billing activation or paid plan is
authorized. The current preview uses direct connections and free STUN; a relay
allowance must not be described as a guaranteed spending cap. The Cloudflare
TURN adapter is implemented but remains disabled pending account access and a
verified no-charge setup. See [TURN operations](../infrastructure/turn/README.md).

## Environments and request path

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
   pnpm deploy:cloud dry-run preview
   ```

   `.meshdrop-artifacts/deploy/preview/` contains a frozen Worker bundle, static
   assets, the Pages gateway, two Wrangler configurations and a SHA-256 manifest.
   There are no static secrets in those bundles/configurations. `publish` verifies
   the prepared configuration and file hashes before uploading. The deployment
   directory is ignored and can contain a private `.env` during publishing.

## Provision and publish

A brand-new account needs a free Workers subdomain even with `workers_dev: false`.
Run `pnpm deploy:cloud bootstrap preview` once to initialize one only when absent;
existing subdomains are preserved. You can alternatively open Workers & Pages in
the dashboard to finish first-time setup. This does not buy a domain or expose
the signaling Worker. The account-level subdomain is shared infrastructure;
preview and production room namespaces and URLs remain separate.

After reviewing account, target project and origin:

```sh
pnpm deploy:cloud provision preview   # once; creates only the named Pages project
pnpm deploy:cloud publish preview     # Worker + secrets, then Pages, then /ready
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

Repeat prepare/dry-run/provision/publish for `production` only after preview
acceptance. An already existing Pages project does not need `provision` again.
Each `.env` must use a project name ending in its own environment. Public origin
defaults to `https://PAGES_PROJECT.pages.dev`; a custom origin requires its domain
binding and TLS to be configured before changing `PUBLIC_ORIGIN`. Changing origin
changes browser storage scope: files saved under the old origin do not migrate.

The runtime secret upload is additive. When deliberately disabling an existing
relay, remove its `TURN_SHARED_SECRET` or `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN` secrets with `wrangler secret delete` against that
environment's generated `worker.json`, set `TURN_PROVIDER=direct`, clear all
provider fields in its `.env`, then
prepare/dry-run/publish. Do not assume omitted secrets are automatically deleted.
Never copy production TURN/operator secrets to preview.

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
