# ADR-003: Files and diagnostics stay on devices

Status: accepted for P0; storage implementation in P4, 2026-10-16.

Use OPFS for partial blocks and IndexedDB for metadata/checkpoints. Add direct-save adapters only after feature detection and device validation. API presence does not guarantee permission, persistence, quota or large-file export. Memory fallback cannot claim restart-safe recovery.

A receiver ACK follows block hashing, successful write/flush as supported by the adapter, and durable checkpoint commit. Final success additionally requires a matching full-file SHA-256 and finalized output. Quota failure, eviction, permission denial and interrupted export must remain visible.

No account, cloud history, file database or telemetry upload is required. Retention and user-directed cleanup need explicit policy in P4/P7; do not assume universal iPhone file sizes or generic save-picker support.
