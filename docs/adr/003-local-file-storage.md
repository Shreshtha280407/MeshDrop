# ADR-003: Files and diagnostics stay on devices

Status: accepted in P0; implemented in P4, 2026-10-17. See the [storage contract](../protocol/storage-p4.md).

Use OPFS for partial blocks and IndexedDB for metadata/checkpoints. Add direct-save adapters only after feature detection and device validation. API presence does not guarantee permission, persistence, quota or large-file export. Memory fallback cannot claim restart-safe recovery.

A receiver ACK follows block hashing, successful write/flush as supported by the adapter, and durable checkpoint commit. Current verified completion additionally requires every declared byte, a matching full-file SHA-256, finalized browser output and the scoped receipt handshake. Requesting a subsequent external save/share is a separate result. Quota failure, eviction, permission denial and interrupted export must remain visible.

No account, cloud history, file database or telemetry upload is required. The later P4/P7/Task 16 retention, locks, tombstones and conservative cleanup policies are documented in the storage contract and [current status](../CURRENT_STATUS.md); do not assume universal iPhone file sizes or generic save-picker support.
