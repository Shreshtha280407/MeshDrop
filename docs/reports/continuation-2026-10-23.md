# MeshDrop continuation — 23 October 2026

Baseline: `2cfc05c`. This checkpoint continues the audit of both supplied plans;
the plans end at P9. All changes remain local. No GitHub push, paid service,
payment details, production publish or billing activation was performed.
Verification continued after the server restart: the complete 365-case unit suite
and root type check pass. Repeated unit runs are counted once in the aggregate.

## Delivered and verified

The coordinated public preview rollback now switches both Pages and the signaling
Worker, verifies a preserved approved room and the expected client asset digest,
and restores both original deployment IDs. Real 1 MiB transfers, independently
hashed saved files, receipts and diagnostics passed before the switch, on the
older compatible pair and after restoration. The synthetic room was closed.
See [reviewed evidence](evidence/phase-9-product-rollback.json) and the
[rollback runbook](../runbook.md#rollback).

The candidate component IDs were recorded separately. This drill establishes
their compatibility together; it does not assert that they were historically
published as one source-matched release. Recovery tests cover lost responses,
partial restoration failures, failed public gates, detected concurrent releases,
unsafe targets and provider-response sanitization. Fourteen new unit cases pass.
Together with the prior baseline/focused runs this is **589 distinct local cases**,
not a newly completed single full-suite command. Root types and focused ESLint
pass. The secret check passed after rerunning outside the sandbox's blocked Git
child-process environment.

Production bundles and the Worker dry run are prepared for the separate origin.
No production resources were published. See
[preparation evidence](evidence/phase-9-production-preparation.json).

## Free services and remaining gates

The Metered account and relay app were created on its $0 monthly 500 MB plan.
The dashboard confirms service stops at the free limit and the plan has no
overages. No card or automatic payments were added. Five-minute temporary
credentials were created privately. One isolated provider probe passed UDP,
TCP and TLS with two real relay peer connections and exact 256 KiB payload hashes.
A separate attempt failed UDP and full TCP completion while TLS passed. These
are provider probes, not MeshDrop transfer acceptance or an OS firewall test.
The provider documents up to two minutes of credential propagation; integration
and reliable cold-start behavior remain unresolved. Counters still returned zero
after the small probes, so metering reconciliation is not verified. Public preview
remains direct-only. See [relay evidence](evidence/phase-9-free-relay-preflight.json).

A Notifications-only API token was created for the exact MeshDrop account through
the owner's connected Chrome browser and saved privately. Token verification,
alert-type listing, policy listing and email eligibility return success. Email
delivery is supported by the account. This closes the earlier permission blocker;
it does not establish configured quota/failed-join alerts or delivery. Cloudflare's
native usage-based billing notification documentation requires Professional or
higher. Free monitor options are still being assessed. See
[permission evidence](evidence/phase-9-notifications-permissions.json).

Earlier real iPhone 1 MiB receive/export and 2 MiB reload/recovery/export passes
remain valid. An additional native Safari 8 MiB attempt completed committed storage
and its final digest, but the provider did not return exported bytes. A separate
native OS lock command failed at a paused 1 MiB checkpoint. Both overall attempts
remain failures; OS lock recovery and larger exported-file coverage are not
certified. See [native iOS evidence](evidence/phase-7-native-ios-continuation.json).

P9 acceptance still requires reliable MeshDrop managed relay, UDP-blocked TCP/TLS,
capacity/metering, actual quota/failed-join alert delivery and production acceptance.
Required physical OS cases retain their explicit measured limits. The OPPO is
next needed for a transport/mobile regression or an actual cross-device relay
test; account, documentation and local tooling work do not require it.
