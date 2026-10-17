# P6 measured diagnostics contract

`packages/network-intelligence` owns report schemas, sampling, byte-rate math, evidence rules, local storage, typed subscriptions and JSON/CSV export. `PeerSession` supplies sanitized transport observations; `TransferMachine` supplies verified counters and successful storage-commit timing. `RoomClient` binds their lifetimes. React renders snapshots and never decides transfer integrity.

## Measurements and clocks

Each sample carries `timestampMonotonic`, `metricName`, `value`, `unit`, `provenance` and `availabilityReason`. A null value requires a reason; a measured zero remains zero. Strict schemas reject unknown properties, mismatched labels and nonfinite values. Frames share a report-relative monotonic timestamp, interval duration, admitted epoch and transfer state. UTC start/update/expiry timestamps support history ordering and retention; they never enter throughput/RTT subtraction. Reload creates a separate local report, without stitching independent monotonic clocks together.

| Measurement                                               | Unit / evidence                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Interval, rolling 10-second and report-average throughput | `B/s`; new receiver-confirmed bytes divided by the measured interval, window or report duration |
| Application round trip                                    | `ms`; authenticated signed PING/PONG, including channel queuing and peer/signature processing   |
| ICE round trip                                            | `ms`; selected candidate pair's `currentRoundTripTime` seconds multiplied by 1000               |
| Local send buffer                                         | `bytes`; RTCDataChannel bufferedAmount                                                          |
| Receiver commit latency                                   | `ms`; successful worker commit RPC, including write/readback hash/flush/ledger work             |
| Confirmed, reused and attempt payload                     | `bytes`; transfer engine counters, not wire-byte estimates                                      |
| Recovery duration                                         | `ms`; observed interruption through accepted authenticated resume proofs                        |
| Path / pair state                                         | Categories from the selected candidate pair; unknown fields remain unavailable                  |

Display uses decimal **MB/s = B/s / 1,000,000**, **Mbps = B/s × 8 / 1,000,000**. Payload size labels elsewhere can use MiB. Attempt payload excludes transport headers/retransmissions. Source ACK throughput measures received confirmations; receiver throughput measures locally committed confirmations. Neither measures physical network capacity. Pauses, preparation, verification and interruptions remain in the report-average denominator.

Resume baseline changes never become fresh throughput: revalidated reused bytes are shown separately, and only subsequent positive committed-byte deltas enter the aggregator. A report that observed the initial prefix plus the resumed suffix can therefore confirm the complete file once while reporting the exact authenticated reuse. A newly opened page observes only its own new confirmations.

## Sampling, fallbacks and bounds

Sample every second during an unfinished transfer, including pauses/reconnects to show dips. Capture critical state transitions too. Stop on terminal status or room/page disposal; terminal duration freezes. At most one underlying diagnostics probe may be pending. A probe has a 200 ms sampling wait budget; observations older than three seconds become unavailable. A hung API does not produce accumulating requests. Connection/epoch changes invalidate cached transport observations immediately, and a late old probe cannot refill that cache. The older path-card probe is independently bounded. No timing API failure decides connection trust or file completion.

Use a transport's selected candidate-pair ID when unambiguous, otherwise exactly one succeeded/nominated pair. Multiple candidates or a gathered relay alone do not prove relay use. Inspect referenced candidate categories and pair state, then discard raw stats. Missing fields, exceptions, stale values and insufficient samples carry explicit reasons. App RTT and send-buffer observations can remain available even when getStats rejects. Timing probes avoid a busy send buffer; timing replies tolerate the normal file-buffer range and a failed reply cannot abort file delivery. Up to four automatic probes may be outstanding; absent replies become unavailable rather than invented latency.

Keep 120 seconds of recent detail (maximum 180 live frames), durable snapshots about every five seconds, and progressively decimate older frames. Final reports contain at most 240 frames and 128 events. Bound each compact UTF-8 JSON report to 512 KiB by further decimation. Track removed frame/event counts. The rolling ACK queue holds at most 4096 events over ten seconds; overflow marks the rolling value unavailable until a full trustworthy window exists. Exact cumulative interval and average counters remain independent of that queue. Historical snapshots have coarser resolution; the chart leaves gaps over three seconds instead of implying continuous measurements.

## Evidence rules

Events include UUIDs, transfer scope, severity, report-relative observed time, allowlisted numeric `measuredEvidence`, and a fixed code-derived user message. No raw exception text is persisted.

| Event                                        | Evidence threshold                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ACK stalled                                  | Active, unpaused, no new confirmation for at least five seconds                                                 |
| Buffer pressure                              | At least 384 KiB across three successive sampled observations spanning at least two seconds                     |
| Relay selected                               | A succeeded selected pair references a relay candidate                                                          |
| Slow storage                                 | At least three observed commit observations at or above 250 ms                                                  |
| Interruption / connection restored / resumed | Actual peer/transfer state changes; resume includes source-accepted reused bytes and measured recovery duration |

Rules deduplicate an ongoing condition and rearm after recovery. A slow sampled observation does not identify an ISP, Wi-Fi bottleneck or remote hardware fault. Intermediate commit latencies can occur between samples; this is a sampled indicator, not an exhaustive storage audit.

## Persistence, privacy and export

IndexedDB `meshdrop-diagnostics-v1` / `reports` is separate from the file checkpoint database. Keep at most 10 reports and **4 MiB aggregate compact JSON**, expiring seven days after their last captured update. Prune expired, malformed, excess-count and excess-byte records transactionally on write and history read. These caps describe logical data, excluding browser database overhead. Persistence coalesces one in-flight write plus the latest waiting snapshot; transfer ACKs never await it. Quota/permission failures show unavailable history while live export and file verification remain independent. Storage eviction, clearing site data and a final write interrupted by page closure can lose local history.

Explicit deletion waits for the page's pending report writes, including retired sessions, before deleting that report. Deleted current-session IDs are suppressed until another transfer starts. Another page uses its own new report UUID, so it cannot resurrect this page's report by writing its own session. History is not uploaded, synchronized or included in central logs.

Persist only category/timing/byte evidence and local report/transfer UUIDs. Exclude filenames/paths, file digests, manifests, raw candidate dictionaries, IPs/ports/SDP, room capabilities, socket tickets, TURN credentials and private keys. UUIDs and transfer timings can still link a report with a transfer if voluntarily shared. This is origin-private storage, with no encryption guarantee against local profile/origin compromise.

Exports require an explicit button click. JSON is schema version 1. CSV uses a fixed header, report metadata row, chronologically ordered sample/event rows, explicit units/provenance/reasons and quoted escaped fields. Strict local parsers verify round trips; the UI does not import external reports. Exports are downloads outside application retention/deletion.

Definitions follow the [WebRTC statistics specification](https://www.w3.org/TR/webrtc-stats/), [WebRTC data-channel API](https://www.w3.org/TR/webrtc/) and [monotonic high-resolution time model](https://w3c.github.io/hr-time/).
