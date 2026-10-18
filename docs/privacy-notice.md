# MeshDrop privacy notice

MeshDrop has no compulsory account, password or centralized file library. Files,
file manifests, incremental/final hashes, receipts, receiver checkpoints and
diagnostics are handled on the participating devices. WebRTC encrypts transport;
verify the comparison code independently before sharing. A sender/receiver may
save or redistribute delivered data, which MeshDrop cannot recall.

The signaling service processes short-lived room and peer identifiers, approval
state, capability verifiers, message/ticket replay protection and expiry. It
relays connection signaling in memory; file bodies and file manifests have no
server upload API. Capabilities are held in browser memory, not localStorage,
analytics or server plaintext databases. Invitations use a URL fragment: sharing
the full link grants its temporary admission capability. Treat it as private.

Cloudflare and any STUN/TURN provider necessarily handle network metadata,
including IP addresses and timing. Peers can learn network addressing through ICE.
A TURN relay transports encrypted WebRTC traffic, consumes bandwidth and can see
connection metadata. Cloudflare's platform policy and the chosen relay provider's
retention/billing policy apply to their infrastructure. Do not claim network-level
anonymity or that disabling application logs prevents all provider metadata.

Application control logs contain only fixed operation/environment classifications
and status codes. Invocation URL logs are disabled in the generated signaling
configuration; operator tail tools/platform metadata still require private access
and short retention. No third-party analytics, remote QR scanner, or automatic
diagnostics upload is included. Camera access for local QR decoding is optional.

Closed cloud rooms retain a short tombstone before alarm cleanup. Browser
checkpoint retention is 24 hours or 7 days according to the selected policy,
enforced on next access. Browser clearing/eviction can delete data earlier. Local
diagnostics history is bounded to ten reports, 4 MiB and seven days. Public UI assets
can be cached by the PWA; private API responses and transfer data are not placed
in the service-worker cache. Saved exports/downloads belong to the user and are
not removed by clearing a temporary transfer.

Use Cancel/Clear transfer/Delete saved to remove scoped browser transfer data.
Close/revoke the room to end signaling access. Remove browser/site data only when
you intend to delete all data for that origin. Before sharing diagnostics, review
it: omission of filenames/addresses does not make timing and identifiers anonymous.
Operator/provider keys remain in private environment configuration and are never
sent to the frontend; short-lived authorized TURN credentials are runtime values.

Technical detail: [privacy model](privacy-model.md), [threat model](threat-model.md),
[diagnostics contract](protocol/diagnostics-p6.md), [operations](runbook.md).
