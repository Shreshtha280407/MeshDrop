import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { verifyAttestation } from '../../scripts/deploy/github-attestation';
import type { AttestationPolicy } from '../../scripts/deploy/github-attestation';
import { bytesHash } from '../../scripts/deploy/release-record';

async function fixture() {
  const [artifact, bundle, roots, binary] = await Promise.all([
    readFile('tests/fixtures/sigstore/workflow-artifact'),
    readFile('tests/fixtures/sigstore/workflow-attestation.sigstore.json'),
    readFile('tests/fixtures/sigstore/workflow-roots.jsonl'),
    readFile('/usr/bin/gh'),
  ]);
  const now = new Date();
  const policy: AttestationPolicy = {
    schemaVersion: 2,
    signerRef: 'refs/heads/main',
    repository: 'actions/attest-demo',
    repositoryId: '763287532',
    ownerId: '44036562',
    signerWorkflow: 'actions/attest-demo/.github/workflows/build-python.yml',
    signerCommit: 'a6c23b9806c593664f68637c8f9d45dfcf98b2db',
    sourceCommit: 'a6c23b9806c593664f68637c8f9d45dfcf98b2db',
    sourceRef: 'refs/heads/main',
    sourceWorkflow: '.github/workflows/build-python.yml',
    runId: '8788389601',
    runAttempt: 1,
    artifactSha256: bytesHash(artifact),
    trustedRootSha256: bytesHash(roots),
    rootReviewedAt: now.toISOString(),
    rootValidUntil: new Date(now.getTime() + 3600000).toISOString(),
    ghPath: '/usr/bin/gh',
    ghSha256: bytesHash(binary),
  };
  return { artifact, bundle, roots, policy, now };
}
describe('real offline ref-based workflow certificate verification', () => {
  it('verifies the public upstream signature with exact signer ref AND signer commit, without authorization', async () => {
    const f = await fixture();
    expect(await verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now)).toMatchObject({
      signatureVerified: true,
      repository: 'actions/attest-demo',
      authorizationVerified: false,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    });
  });
  it.each(['signerRef', 'signerCommit', 'sourceCommit', 'repositoryId', 'ownerId'] as const)(
    'rejects a substituted %s even with a real signed upstream bundle',
    async (key) => {
      const f = await fixture();
      f.policy[key] =
        key === 'signerRef' ? 'refs/heads/other' : key.endsWith('Id') ? '999' : 'b'.repeat(40);
      await expect(
        verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now),
      ).rejects.toThrow();
    },
  );
});
