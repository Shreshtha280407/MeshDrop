# ADR-004: Receiver checkpoints are revalidated before reuse

Status: implemented in P5, 2026-10-17.

The receiver's verified committed-block ledger defines reusable progress. Resume binds stable transfer/file identity to manifest digest, file size, block size and revision. Re-read and re-hash persisted blocks on reopening. Corrupt, missing, evicted or uncertain blocks are uncommitted.

A fresh channel uses a new monotonically increasing epoch and refreshed admission. Message IDs and per-peer sequence numbers support replay defense, but schemas do not authenticate, deduplicate or reject stale epochs; P1/P2/P5 engines must enforce those checks. Renew authorization after room expiry. Sender reselection must match content identity.

Data-channel encryption does not independently verify the human peer. A key-derived short authentication string compared through an independent channel is required before claiming verified identity. Cancellation is terminal; integrity or finalization failure cannot become completion.

P5 uses a fresh independently compared pairing transcript and a five-step, page-bounded proof exchange. Receiver blocks are rehashed locally and compared against reread source block hashes before reuse. Resume bindings/checkpoint digests persist without credentials; same-room epochs increase, while a freshly authorized room has a separate epoch namespace. See the [P5 contract](../protocol/resume-p5.md) and [runbook](../runbooks/resume.md).
