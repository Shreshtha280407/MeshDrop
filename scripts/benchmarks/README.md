# Benchmark contracts

P3's correctness/memory gate runs with `pnpm bench:p3` while the local development server is running. It verifies exact 100 MiB and 1 GiB downloads, intermediate committed progress, bounded owned queues and page/worker JavaScript memory. See the [streaming runbook](../../docs/runbooks/streaming-verification.md) for artifact paths, reproduction and measurement limits, and the [P3 report](../../docs/reports/phase-3.md) for recorded results.

P9's broader benchmarks will record browser/device, direct/relay path, committed throughput, retransmission and network conditions. The P3 local run does not certify that broader matrix or public-network performance. P0 claims no benchmark results.

P4 adds `pnpm bench:p4`: receive >=300 MiB, close the transfer browser process, and restore a rehashed checkpoint in a fresh process without any more transfer. See the [storage runbook](../../docs/runbooks/storage-recovery.md).

P5 adds `pnpm bench:p5`: interrupt 1 GiB at the first committed block boundary at/above 70%, change isolated Linux candidate subnets, authenticate a fresh epoch, and assert reused bytes, missing-only payload and full-file SHA-256. See the [resume runbook](../../docs/runbooks/resume.md).
