# Transfer insights and local reports

Run `pnpm dev`, open two independent regular browser profiles at `http://127.0.0.1:5173`, admit the receiver and independently compare both pairing codes. Offer and accept a test file. The Transfer insights panel begins on each device when a manifest is available.

Pause after some confirmed bytes. After one complete idle sampling interval, the receiver-confirmed speed falls to zero and the timeline marks the pause. Application RTT includes peer processing; ICE RTT describes the selected candidate pair. Unsupported measurements say Unavailable, with an explanation. Receiver storage timing is measured only on the receiver. Use the chart selector and keyboard sample slider to inspect interval timing, units and observations.

Restart ICE on the owner, compare the new code on both devices, prepare the original source and resume on the receiver. Insights retains the interruption, new connection and authenticated resume events. The resumed event shows the exact source-accepted reused bytes. Reused bytes never count as freshly acknowledged throughput. Finish and save the received file to verify the complete workflow.

Export diagnostics JSON or CSV using the panel buttons. They omit filenames, file hashes, candidate addresses and credentials. Decide whether to share them: timings, byte counts and transfer UUIDs can still identify a transfer to someone with other context. No diagnostics upload endpoint exists.

After reload, select a saved report from Measurement report, or use Refresh local reports to reread local storage. A previously recording report is labeled saved snapshot; it is not a live connection. Delete local report removes that report, independently of saved file data. Current reports can be deleted after the transfer stops. Downloads you exported remain outside site cleanup.

History is bounded to 10 reports, 512 KiB per compact JSON report, 4 MiB aggregate logical JSON and seven days from the last sample. Old detail is downsampled and gaps remain blank. Expiry/cap pruning occurs on the next history read or write, not in a background service. Unavailable history can mean quota, permission or browser-mode restrictions; file verification can still continue. Clearing site data or browser eviction removes reports. Closing immediately can interrupt the last asynchronous report write.

## Reproducible Phase 6 gate

```sh
pnpm bench:p6
```

The Playwright harness starts local servers if needed, creates two real Chromium peer contexts, sends a varied 24 MiB fixture, pauses around 8 MiB, waits for a measured zero-throughput interval, restarts ICE, requires fresh code confirmations, authenticates saved blocks and sends only the missing suffix. It checks final downloaded SHA-256, exact reused/new bytes, annotated events, JSON/CSV equality, saved-report reload/export and deletion after another reload. It also exercises missing statistics plus metrics-only storage failure and a timing reply under injected buffer pressure. Generated downloads, screenshots, gate JSON and failure evidence stay in ignored `test-results/`; review before copying evidence elsewhere.

Run the same gate at a mobile viewport and the IndexedDB retention checks with:

```sh
pnpm exec playwright test tests/e2e/network-intelligence.spec.ts tests/storage/metrics-history.spec.ts --project mobile-chromium --retries 0
```

This demonstrates real browser file transport on one laptop with an injected pause/ICE interruption. It does not establish physical phone/OS coverage, an actual ISP network change, TURN behavior, background delivery or production throughput. P5's independent subnet-migration benchmark is documented separately; P7 owns mobile lifecycle hardening.
