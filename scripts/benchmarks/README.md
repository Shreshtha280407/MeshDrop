# Benchmark contracts

Task 14 adds isolated capacity and abuse checks. These commands start only local
test infrastructure; they accept neither a public URL nor an arbitrary command:

```sh
pnpm test:load
pnpm test:load:browser
```

The first runs the 1/10/25/50/100-room control-plane matrix, abuse/rate-limit
checks, 1,000 seeded admission schedules and concurrent file-backed transfer
simulations. Its largest socket case keeps 100 paired rooms and 200 real local
TCP WebSockets open. The second runs four simultaneous real WebRTC/OPFS transfers
in each of desktop Chromium and mobile-emulated Chromium, with independent saved
file hashes and zero retries. Mobile emulation is not physical-device evidence.
Per-case measurements append to ignored
`.meshdrop-artifacts/task14-load/metrics.jsonl`; only reviewed numeric summaries
belong in public evidence. No room credentials, SDP, IPs or filenames are exported.

The wrapper strips ambient provider variables, forces loopback development
origins, disables Wrangler telemetry and dotenv loading, refuses signaling
`.dev.vars*` files, and prevents reuse of an existing development server. Preserve
any such private file and use an isolated checkout rather than deleting it. Local
browser tests use empty ICE-server lists; relay cases use injected responses and
consume no provider quota. Allow local socket binding, installed browser binaries
and enough temporary disk for the synthetic files. Close any unrelated service
using the test ports first.

These are separate evidence scopes: real local Worker/SQLite/signaling, injected
transfer transport/storage, representative local browsers, and synthetic relay
responses. They establish no hosted user capacity, real relay concurrency, native
mobile background behavior or provider-wide memory limit. See the
[Task 14 report](../../docs/reports/task-14-concurrency-load.md) for exact limits,
observations and pending hosted CI.

P3's correctness/memory gate runs with `pnpm bench:p3` while the local development server is running. It verifies exact 100 MiB and 1 GiB downloads, intermediate committed progress, bounded owned queues and page/worker JavaScript memory. See the [streaming runbook](../../docs/runbooks/streaming-verification.md) for artifact paths, reproduction and measurement limits, and the [P3 report](../../docs/reports/phase-3.md) for recorded results.

P9's release matrix runs with `pnpm bench:p9` while MeshDrop is available. It uses
fresh independent Chromium profiles and a fresh room per case, testing normal and
controlled-disconnect 100 MiB, 1 GiB and 2 GiB synthetic files. Source generation
and downloaded-file hashing stream through bounded buffers. It verifies exact
SHA-256, receipt, progress, queue ceilings, page/dedicated-worker JS/backing-storage
memory, and diagnostics export. Controlled disconnect pauses at a verified block
boundary at/above 70%, denies browser network access and dispatches the offline
lifecycle (closing RTC), reconnects with a fresh code comparison, then verifies
exact retained bytes and missing-only payload. It is not a random packet-loss or
physical Wi-Fi/mobile handover test.

```sh
pnpm bench:p9
MESHDROP_TEST_URL=https://YOUR_STABLE_PROJECT.pages.dev pnpm bench:p9
MESHDROP_BENCH_BYTES=8388608 pnpm bench:p9  # smoke only, not the release size gate
```

Reports, synthetic receipts and diagnostic exports stay in ignored
`.meshdrop-artifacts/phase-9-benchmarks/`; `matrix.json` records the full-size flag
and physical-device-coverage flag. Local pairing uses the explicitly recorded mDNS
test flag; public targets use ordinary Chromium defaults. P9 failure summaries
contain allowlisted stages/states and numeric metrics, not raw network/browser
state. Two profiles on the same machine do not
prove a physical two-device or mobile-network test, even against a remote backend.
Read the memory scope in each report: unforced-GC CDP page/worker measurements
include JS-owned backing storage, not total browser RSS, native WebRTC or OS cache.
The 256 MiB combined JS ceiling and fixed queue ceilings are file-size-independent
acceptance gates; elapsed time includes offer hashing/recovery, not a pure network
throughput claim. Real device/network conditions require a separate recorded run.
Successful cases clear their scoped OPFS data and remove synthetic source/download
files and profiles. Failed run artifacts remain private for inspection; remove
only that generated run directory when no longer needed. Allow at least 10 GiB
of disk for a 2 GiB case and its browser checkpoint/export copies.

The final P9 six-case local matrix passed against the frozen production client,
with a largest combined JS/backing-storage peak of 241,117,261 bytes. The run used
a temporary sleep/idle inhibitor; no permanent power settings were changed. See
the [reviewed evidence](../../docs/reports/evidence/phase-9-benchmarks.json) and
[P9 report](../../docs/reports/phase-9.md). Public physical Oppo Wi-Fi recovery
and the separate 1 MiB mobile-data check are recorded independently.

P4 adds `pnpm bench:p4`: receive >=300 MiB, close the transfer browser process, and restore a rehashed checkpoint in a fresh process without any more transfer. See the [storage runbook](../../docs/runbooks/storage-recovery.md).

P5 adds `pnpm bench:p5`: interrupt 1 GiB at the first committed block boundary at/above 70%, change isolated Linux candidate subnets, authenticate a fresh epoch, and assert reused bytes, missing-only payload and full-file SHA-256. See the [resume runbook](../../docs/runbooks/resume.md).
