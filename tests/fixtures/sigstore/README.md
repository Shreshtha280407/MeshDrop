# Public Sigstore verification fixtures

Copied byte-for-byte from the MIT-licensed GitHub CLI source at
[fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd](https://github.com/cli/cli/tree/fc4b137cdef0a6bd28fd461b7cf9c84a5812a8cd/pkg/cmd/attestation/test/data)
(v2.102.0). See LICENSE.txt. Files: `reusable-workflow-artifact`,
`reusable-workflow-attestation.sigstore.json`, and `trusted_root.json`.

The artifact is a public historical Python wheel, consumed as bytes only and
never executed. Its real Sigstore signature and signed certificate extensions
are verified by `gh attestation verify` using the upstream test root.
It identifies `malancas/attest-demo`, **not MeshDrop**. It cannot authenticate a
MeshDrop release or reviewer. The historical test root is not a production root
and says nothing about present revocation. No private keys are included.

Production requires an independently acquired and reviewed root, trusted CLI
binary, immutable identity pins and a root-refresh/revocation policy. Tests do
not download roots, attestations or binaries and do not authenticate to GitHub.
