# ADR-004: Receiver checkpoints are revalidated before reuse

Status: accepted for P0; recovery implementation in P5, 2026-10-16.

The receiver's verified committed-block ledger defines reusable progress. Resume binds stable transfer/file identity to manifest digest, file size, block size and revision. Re-read and re-hash persisted blocks on reopening. Corrupt, missing, evicted or uncertain blocks are uncommitted.

A fresh channel uses a new monotonically increasing epoch and refreshed admission. Message IDs and per-peer sequence numbers support replay defense, but schemas do not authenticate, deduplicate or reject stale epochs; P1/P2/P5 engines must enforce those checks. Renew authorization after room expiry. Sender reselection must match content identity.

Data-channel encryption does not independently verify the human peer. A key-derived short authentication string compared through an independent channel is required before claiming verified identity. Cancellation is terminal; integrity or finalization failure cannot become completion.
