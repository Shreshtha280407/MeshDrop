# P9 release candidate

21 October continuation: added a preview-only Pages rollback/restoration tool,
11 recovery/provider-boundary tests, a real public Pages drill with matching
restored asset SHA-256, and a [phase-by-phase audit](reports/implementation-audit-2026-10-21.md)
of both supplied plans. Current component checks total 575 distinct passing cases.
The Worker and production environment were unchanged. The earlier results below
remain historical evidence. Real iPhone 1 MiB receive/export and 2 MiB
reload/recovery/export now pass, as do iPhone → laptop, both OPPO ↔ iPhone
directions, and real iPad 1 MiB receive/export. A Windows same-host 1 MiB control
passes. Native Windows Chrome 155 and Mac Safari 26.4 also passed public 1 MiB
receive/export. Earlier bundled-engine failures remain separately recorded. Larger
iPhone exports and the remaining P9 release gates stay open. Provider plan checks
reported Free; no billing/plan upgrade was activated.

**Status:** public preview deployed; the public laptop/Oppo Wi-Fi and mobile-data
checks, Worker rollback/restore, all six local full-size benchmark cases and
564 automated tests passed. Production rollout, free-only relay verification,
account alerts and remaining physical-platform release gates are open.

Public laptop-to-Oppo direct delivery passed at 8 MiB on Wi-Fi and 1 MiB over the
phone's existing mobile data. Real Wi-Fi outage/recovery passed at 32 MiB, reusing
23 MiB and comparing codes again at a fresh epoch. Native downloads, independent
digests, receipts and diagnostics passed. A queued retry is now cancelled when a newer connection epoch is admitted,
and full-file hashing reuses a BYOB buffer where supported, with a standard
stream-reader fallback. New tests cover delayed signaling, hashing and provider
credential failures. The unchanged 256 MiB combined JS/backing-storage ceiling
passed in every final 100 MiB/1 GiB/2 GiB normal and recovered desktop case; the
largest observed peak was about 230 MiB. These are local loopback measurements,
separate from the smaller public physical-device checks.

Added same-origin Cloudflare Pages/Worker deployment artifacts, isolated preview
and production configurations, private `.env` initialization, frozen bundle hash
validation, a manual gated deployment workflow, liveness/readiness, admission drain,
independently authorized operator revocation, and fixed-field sampled signaling
logs. Existing protocol v1 and SQLite migration v1 remain unchanged.

Added reproducible normal/controlled-disconnect benchmarks at 100 MiB/1 GiB/2 GiB,
independent downloaded SHA-256 and receipt checks, missing-only recovery checks,
bounded queue/JS memory measurements and diagnostics exports. Local results do
not certify public/mobile throughput. Added deployment, operations, TURN, user,
privacy, troubleshooting and measured-support documentation.

Added a disabled-by-default Cloudflare TURN adapter. It keeps provider keys in
Worker secrets and emits only validated short-lived credentials. The account's
existing deployment OAuth token cannot manage TURN keys. The owner's free-only
constraint keeps relay disabled pending a verified no-charge setup.

The public Worker rollback restored the latest recorded version and verified the
same persisted approved room. Pages assets were unchanged. See the
[full P9 report and reviewed evidence](reports/phase-9.md).

No Git commit/push, billing activation, paid TURN service, domain purchase or submission was performed. The user-authorized free preview Pages project, private signaling Worker and first-time account Workers subdomain have been provisioned.
