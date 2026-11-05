import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAttestation, parseAttestationPolicy } from '../../scripts/deploy/github-attestation';
import type { AttestationPolicy } from '../../scripts/deploy/github-attestation';
import { bytesHash, fingerprint, initialRecord } from '../../scripts/deploy/release-record';
import { recoveryScope } from '../../scripts/deploy/recovery-evidence';
import { manifestFixture } from '../fixtures/release-record';

const base = 'tests/fixtures/sigstore/';
async function fixture() {
  const [artifact, bundle, roots, binary] = await Promise.all([
    readFile(base + 'reusable-workflow-artifact'),
    readFile(base + 'reusable-workflow-attestation.sigstore.json'),
    readFile(base + 'trusted_root.json'),
    readFile('/usr/bin/gh'),
  ]);
  const now = new Date();
  const policy: AttestationPolicy = {
    schemaVersion: 1,
    repository: 'malancas/attest-demo',
    repositoryId: '804070735',
    ownerId: '16248153',
    signerWorkflow: 'github/artifact-attestations-workflows/.github/workflows/attest.yml',
    signerCommit: '09b495c3f12c7881b3cc17209a327792065c1a1d',
    sourceCommit: '95baf27389e83e6a5c48f42e190d48d7abcea19e',
    sourceRef: 'refs/heads/main',
    sourceWorkflow: '.github/workflows/shared.yml',
    runId: '9228858953',
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
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External calls forbidden.'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('real offline GitHub CLI / Sigstore verification', () => {
  it('prints sanitized UNVERIFIED diagnostics and exits nonzero even for a verified signature', async () => {
    const f = await fixture(),
      directory = await mkdtemp(join(tmpdir(), 'meshdrop-trust-cli-'));
    try {
      const policy = join(directory, 'policy.json');
      await writeFile(policy, JSON.stringify(f.policy));
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/deploy/inspect-release-trust.ts',
          'attestation',
          base + 'reusable-workflow-artifact',
          base + 'reusable-workflow-attestation.sigstore.json',
          base + 'trusted_root.json',
          policy,
        ],
        {
          encoding: 'utf8',
          timeout: 20000,
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1' },
        },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'UNVERIFIED',
        signatureVerified: true,
        authorizationVerified: false,
        publicationEnabled: false,
        acceptanceEnabled: false,
      });
      expect(result.stdout).not.toMatch(/rawBytes|dsseEnvelope|Authorization|PRIVATE KEY/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('inspects history integrity without trusting its checkpoint or enabling acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meshdrop-history-cli-'));
    try {
      const manifest = manifestFixture(),
        attemptId = crypto.randomUUID();
      const payload = {
        schemaVersion: 1,
        scopeId: recoveryScope(manifest),
        attemptId,
        manifestId: manifest.id,
        environment: manifest.environment,
        sourceCommit: manifest.sourceCommit,
        sequence: 0,
        previousHash: null,
        kind: 'START',
        record: initialRecord(manifest),
        approval: null,
      };
      const hash = fingerprint(payload),
        head = { scopeId: payload.scopeId, attemptId, sequence: 0, hash };
      const files = ['manifest', 'events', 'head'].map((name) => join(directory, name + '.json'));
      await Promise.all([
        writeFile(files[0]!, JSON.stringify(manifest)),
        writeFile(files[1]!, JSON.stringify([{ ...payload, hash }])),
        writeFile(files[2]!, JSON.stringify(head)),
      ]);
      const args = [
        '--import',
        'tsx',
        'scripts/deploy/inspect-release-trust.ts',
        'history',
        ...files,
        attemptId,
      ];
      const run = () =>
        spawnSync(process.execPath, args, {
          encoding: 'utf8',
          timeout: 20000,
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1' },
        });
      const result = run();
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: 'UNVERIFIED',
        integrityVerified: true,
        authenticated: false,
        offRunDurable: false,
        publicationEnabled: false,
        acceptanceEnabled: false,
      });
      await writeFile(files[2]!, JSON.stringify({ ...head, hash: '0'.repeat(64) }));
      const tampered = run();
      expect(tampered.status).toBe(1);
      expect(JSON.parse(tampered.stdout).reason).toBe('RECOVERY_HEAD_MISMATCH');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('verifies an actual upstream signed artifact without approving a MeshDrop release', async () => {
    const f = await fixture();
    expect(await verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now)).toMatchObject({
      signatureVerified: true,
      repositoryId: '804070735',
      authorizationVerified: false,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    });
  });
  it('rejects an invalid DSSE signature using the actual verifier', async () => {
    const f = await fixture(),
      bundle = JSON.parse(f.bundle.toString());
    const sig = Buffer.from(bundle.dsseEnvelope.signatures[0].sig, 'base64');
    sig[10] = sig[10]! ^ 1;
    bundle.dsseEnvelope.signatures[0].sig = sig.toString('base64');
    await expect(
      verifyAttestation(f.artifact, Buffer.from(JSON.stringify(bundle)), f.roots, f.policy, f.now),
    ).rejects.toThrow('ATTESTATION_VERIFICATION_FAILED');
  });
  it('rejects a modified artifact even when its new digest is supplied by the caller', async () => {
    const f = await fixture(),
      changed = Buffer.from('modified release manifest');
    f.policy.artifactSha256 = bytesHash(changed);
    await expect(verifyAttestation(changed, f.bundle, f.roots, f.policy, f.now)).rejects.toThrow(
      'ATTESTATION_VERIFICATION_FAILED',
    );
  });
  it.each([
    { repository: 'attacker/other' },
    { repositoryId: '999' },
    { ownerId: '999' },
    { signerWorkflow: 'attacker/other/.github/workflows/attest.yml' },
    { signerCommit: 'a'.repeat(40) },
    { sourceCommit: 'a'.repeat(40) },
    { sourceRef: 'refs/heads/other' },
    { sourceWorkflow: '.github/workflows/other.yml' },
    { runId: '999' },
    { runAttempt: 2 },
  ])('rejects wrong pinned identity %j', async (patch) => {
    const f = await fixture();
    Object.assign(f.policy, patch);
    await expect(
      verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now),
    ).rejects.toThrow();
  });
  it('rejects substituted trust roots and verifier binaries', async () => {
    const f = await fixture();
    await expect(
      verifyAttestation(f.artifact, f.bundle, Buffer.from('{}'), f.policy, f.now),
    ).rejects.toThrow('UNTRUSTED_SIGSTORE_ROOT');
    f.policy.ghSha256 = '0'.repeat(64);
    await expect(verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now)).rejects.toThrow(
      'UNTRUSTED_VERIFIER_EXECUTABLE',
    );
  });
  it('rejects unverifiable certificate material and unknown issuers', async () => {
    const f = await fixture(),
      bundle = JSON.parse(f.bundle.toString());
    bundle.verificationMaterial.certificate.rawBytes =
      Buffer.from('untrusted issuer').toString('base64');
    await expect(
      verifyAttestation(f.artifact, Buffer.from(JSON.stringify(bundle)), f.roots, f.policy, f.now),
    ).rejects.toThrow('ATTESTATION_VERIFICATION_FAILED');
  });
  it('rejects unsigned JSON presented as an attestation', async () => {
    const f = await fixture();
    await expect(
      verifyAttestation(
        f.artifact,
        Buffer.from('{"signatureVerified":true}'),
        f.roots,
        f.policy,
        f.now,
      ),
    ).rejects.toThrow('ATTESTATION_VERIFICATION_FAILED');
  });
  it('rejects expired roots, excessive root-review intervals and unknown policy fields', async () => {
    const f = await fixture();
    await expect(
      verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, new Date(f.policy.rootValidUntil)),
    ).rejects.toThrow('TRUST_ROOT_REVIEW_EXPIRED');
    expect(() =>
      parseAttestationPolicy({
        ...f.policy,
        rootValidUntil: new Date(f.now.getTime() + 8 * 86400000).toISOString(),
      }),
    ).toThrow('INVALID_ATTESTATION_POLICY');
    expect(() => parseAttestationPolicy({ ...f.policy, approve: true })).toThrow(
      'INVALID_ATTESTATION_POLICY',
    );
  });
  it('fails closed if the trusted verifier cannot be contacted', async () => {
    const f = await fixture();
    f.policy.ghPath = '/nonexistent/gh';
    await expect(verifyAttestation(f.artifact, f.bundle, f.roots, f.policy, f.now)).rejects.toThrow(
      'ATTESTATION_VERIFIER_UNAVAILABLE_OR_INVALID',
    );
  });
});
