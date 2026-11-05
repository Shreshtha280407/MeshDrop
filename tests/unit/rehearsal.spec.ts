import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertNoDeployCredentials } from '../../scripts/rehearsal/contract';
import {
  createArtifact,
  matchArtifact,
  parseArtifact,
  rehearsalScope,
} from '../../scripts/rehearsal/contract';
import { enforceAttestationIdentity } from '../../scripts/deploy/github-attestation';
import { bytesHash, canonical, fingerprint } from '../../scripts/deploy/release-record';
import { runtimeExpectation, inspectEnvironment } from '../../scripts/rehearsal/preflight';
import {
  createHostedJournal,
  inspectHistory,
  parseDatabase,
} from '../../scripts/rehearsal/recovery';
import {
  requireRehearsalVerification,
  verifyRehearsal,
} from '../../scripts/rehearsal/verification';
import { hostedRecoveryWitness } from '../../scripts/rehearsal/witness';
import { rehearsalFixture, signerShape } from '../fixtures/rehearsal';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live account calls.'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
describe('bounded non-authorizing rehearsal identity', () => {
  it('serializes deterministically and preserves absent prepared provenance explicitly', () => {
    const f = rehearsalFixture();
    expect(
      createArtifact(
        {
          repositoryId: '111',
          ownerId: '222',
          environment: 'preview',
          sourceCommit: 'a'.repeat(40),
          sourceRef: 'refs/heads/main',
          runId: '444',
          runAttempt: 1,
          preparedManifestSha256: null,
        },
        f.now,
        f.artifact.rehearsalId,
      ),
    ).toEqual(f.artifact);
    expect(Buffer.byteLength(canonical(f.artifact))).toBeLessThan(8192);
    expect(parseArtifact(JSON.parse(canonical(f.artifact))).preparedManifestSha256).toBeNull();
    expect(rehearsalScope(f.artifact)).not.toBe(
      fingerprint({ repository: f.artifact.repository, environment: f.artifact.environment }),
    );
  });
  it.each(['publicationEnabled', 'acceptanceEnabled', 'productionApproved'] as const)(
    'rejects an attempted %s flag even with a recomputed digest',
    (key) => {
      const f = rehearsalFixture(),
        { artifactId: ignored, ...payload } = f.artifact;
      expect(ignored).toBeTruthy();
      const changed = { ...payload, [key]: true };
      expect(() => parseArtifact({ ...changed, artifactId: fingerprint(changed) })).toThrow(
        'REHEARSAL_CANNOT_AUTHORIZE_RELEASE',
      );
    },
  );
  it('rejects unknown fields, fake manifest digests and modified content', () => {
    const f = rehearsalFixture();
    expect(() => parseArtifact({ ...f.artifact, providerVersion: 'invented' })).toThrow();
    expect(() => parseArtifact({ ...f.artifact, preparedManifestSha256: 'not-a-hash' })).toThrow();
    expect(() => parseArtifact({ ...f.artifact, runAttempt: 2 })).toThrow(
      'REHEARSAL_ARTIFACT_INTEGRITY_MISMATCH',
    );
    expect(() =>
      createArtifact({
        ...f.expected,
        preparedManifestSha256: null,
        publicationEnabled: true,
      } as never),
    ).toThrow('UNEXPECTED_REHEARSAL_FIELDS');
  });
  it.each([
    'repositoryId',
    'ownerId',
    'environment',
    'sourceCommit',
    'sourceRef',
    'runId',
    'runAttempt',
    'rehearsalId',
  ] as const)('rejects a different expected %s', (key) => {
    const f = rehearsalFixture();
    const wrong = { ...f.expected, [key]: key === 'runAttempt' ? 2 : 'other' };
    expect(() => matchArtifact(f.artifact, wrong as never)).toThrow(
      'REHEARSAL_EXPECTATION_MISMATCH',
    );
  });
  it.each([
    'CLOUDFLARE_API_TOKEN',
    'CF_TOKEN',
    'WRANGLER_API_TOKEN',
    'ADMISSION_PAUSED',
    'TURN_SHARED_SECRET',
    'OPS_REVOKE_SECRET',
    'GH_TOKEN',
    'DATABASE_URL',
    'PUBLICATION_ENABLED',
  ])('rejects unexpected credential/control %s without printing its value', (key) => {
    expect(() => assertNoDeployCredentials({ [key]: 'private-canary' })).toThrow(
      /^UNEXPECTED_DEPLOY_CREDENTIAL_OR_CONTROL$/,
    );
  });
  it('cannot select a hosted journal or witness with a success flag', async () => {
    const f = rehearsalFixture(),
      forged = {
        ...f.expected,
        signatureVerified: true,
        artifactId: f.artifact.artifactId,
        publicationEnabled: false,
        acceptanceEnabled: false,
        productionApproved: false,
      };
    expect(() => requireRehearsalVerification(forged as never, f.artifact)).toThrow(
      'UNTRUSTED_REHEARSAL_VERIFICATION',
    );
    await expect(createHostedJournal(f.artifact, forged as never, f.config)).rejects.toThrow(
      'UNTRUSTED_REHEARSAL_VERIFICATION',
    );
    expect(hostedRecoveryWitness).toThrow('INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED');
  });
  it.each([
    'host',
    'port',
    'database',
    'user',
    'caFile',
    'passwordFile',
    'storeId',
    'environment',
    'attemptId',
    'caSha256',
    'psqlSha256',
  ] as const)('requires explicit database %s', (key) => {
    const f = rehearsalFixture(),
      config: Record<string, unknown> = { ...f.config };
    delete config[key];
    expect(() => parseDatabase(config, f.artifact)).toThrow();
  });
  it('rejects another environment or missing history without creating a reservation', () => {
    const f = rehearsalFixture();
    expect(() => parseDatabase({ ...f.config, environment: 'production' }, f.artifact)).toThrow();
    expect(() => inspectHistory(f.artifact, [], {} as never)).toThrow(
      'REHEARSAL_HISTORY_MISSING_OR_REPLAYED',
    );
  });
});
describe('exact attestation boundary without simulated authenticated success', () => {
  it.each([
    'sourceRepositoryIdentifier',
    'sourceRepositoryOwnerIdentifier',
    'sourceRepositoryDigest',
    'sourceRepositoryRef',
    'buildSignerURI',
    'buildSignerDigest',
    'buildConfigURI',
    'runInvocationURI',
    'issuer',
    'runnerEnvironment',
  ] as const)('structurally rejects wrong certificate %s after signature verification', (key) => {
    const f = rehearsalFixture(),
      shape = signerShape(f.policy);
    shape[0]!.verificationResult.signature.certificate[key] = 'untrusted';
    expect(() => enforceAttestationIdentity(shape, f.policy)).toThrow(
      'ATTESTATION_IDENTITY_MISMATCH',
    );
  });
  it('checks the signed subject digest and predicate instead of a success boolean', () => {
    const f = rehearsalFixture(),
      shape = signerShape(f.policy);
    shape[0]!.verificationResult.statement.subject[0]!.digest.sha256 = '0'.repeat(64);
    expect(() => enforceAttestationIdentity(shape, f.policy)).toThrow(
      'UNVERIFIED_ATTESTATION_STATEMENT',
    );
  });
  it('rejects noncanonical bytes and untrusted roots before obtaining any hosted capability', async () => {
    const f = rehearsalFixture();
    await expect(
      verifyRehearsal(
        Buffer.from(JSON.stringify(f.artifact)),
        new Uint8Array([1]),
        new Uint8Array([2]),
        f.policy,
        f.expected,
      ),
    ).rejects.toThrow('NONCANONICAL_REHEARSAL_ARTIFACT');
    await expect(
      verifyRehearsal(
        Buffer.from(canonical(f.artifact)),
        new Uint8Array([1]),
        new Uint8Array([2]),
        f.policy,
        f.expected,
        new Date(f.now),
      ),
    ).rejects.toThrow('UNTRUSTED_SIGSTORE_ROOT');
  });
  it('cannot promote the genuinely signed upstream fixture to a MeshDrop rehearsal', async () => {
    const f = rehearsalFixture();
    const roots = await readFile('tests/fixtures/sigstore/trusted_root.json'),
      bundle = await readFile(
        'tests/fixtures/sigstore/reusable-workflow-attestation.sigstore.json',
      );
    const policy = {
      ...f.policy,
      trustedRootSha256: bytesHash(roots),
      ghSha256: bytesHash(await readFile('/usr/bin/gh')),
    };
    await expect(
      verifyRehearsal(
        Buffer.from(canonical(f.artifact)),
        bundle,
        roots,
        policy,
        f.expected,
        new Date(f.now),
      ),
    ).rejects.toThrow('ATTESTATION_VERIFICATION_FAILED');
  });
});
describe('runtime and environment inspection', () => {
  it('uses explicit source/run identity and a read-only preconfigured environment', async () => {
    const f = rehearsalFixture();
    expect(runtimeExpectation(f.env, f.artifact.rehearsalId)).toEqual(f.expected);
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      return new Response(
        JSON.stringify({
          id: 555,
          name: 'trust-rehearsal-preview',
          protection_rules: [
            {
              type: 'required_reviewers',
              prevent_self_review: true,
              reviewers: [{ type: 'User', reviewer: { id: 333 } }],
            },
          ],
          deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
        }),
      );
    });
    expect(await inspectEnvironment(f.env, transport as typeof fetch)).toMatchObject({
      environmentName: 'trust-rehearsal-preview',
      authorizationVerified: false,
    });
  });
  it.each([
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER_ID',
    'GITHUB_SHA',
    'GITHUB_REF',
    'GITHUB_WORKFLOW_REF',
    'REHEARSAL_WORKFLOW_SHA',
    'GITHUB_EVENT_NAME',
    'REHEARSAL_RUNNER_KIND',
  ])('rejects wrong runtime %s', (key) => {
    const f = rehearsalFixture();
    expect(() => runtimeExpectation({ ...f.env, [key]: 'wrong' }, f.artifact.rehearsalId)).toThrow(
      'INVALID_REHEARSAL_RUNTIME_IDENTITY',
    );
  });
  it.each(['missing', 'conflicting', 'self-review', 'wrong-id'] as const)(
    'rejects %s environment evidence',
    async (failure) => {
      const f = rehearsalFixture();
      const rule = {
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{ type: 'User', reviewer: { id: 333 } }],
      };
      const data = {
        id: 555,
        name: 'trust-rehearsal-preview',
        protection_rules: [rule],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      };
      if (failure === 'missing') data.protection_rules = [];
      if (failure === 'conflicting') data.protection_rules.push(rule);
      if (failure === 'self-review') rule.prevent_self_review = false;
      if (failure === 'wrong-id') data.id = 999;
      await expect(
        inspectEnvironment(f.env, (async () => new Response(JSON.stringify(data))) as typeof fetch),
      ).rejects.toThrow('REHEARSAL_ENVIRONMENT_PROTECTION_UNVERIFIED');
    },
  );
});
describe('local CLI cannot invoke deployment', () => {
  it('creates only bounded metadata under an explicitly stubbed runtime, without claiming a hosted run', async () => {
    const f = rehearsalFixture(),
      directory = await mkdtemp(join(tmpdir(), 'meshdrop-rehearsal-cli-'));
    try {
      const output = join(directory, 'outputs');
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve('scripts/rehearsal/cli.ts'), 'prepare'],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { PATH: process.env.PATH!, ...f.env, GITHUB_OUTPUT: output },
          timeout: 15000,
        },
      );
      expect(result.status).toBe(0);
      const artifact = parseArtifact(
        JSON.parse(await readFile(join(directory, 'rehearsal-evidence/rehearsal.json'), 'utf8')),
      );
      expect(artifact.productionApproved).toBe(false);
      expect(await readFile(output, 'utf8')).toContain('artifact-sha256=');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['deploy', 'publish', 'accept', 'migrate', 'rollback'])(
    'rejects forbidden command %s',
    (command) => {
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve('scripts/rehearsal/cli.ts'), command],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1' },
          timeout: 15000,
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        reason: 'REHEARSAL_COMMAND_NOT_ALLOWED',
        publicationEnabled: false,
        acceptanceEnabled: false,
        productionApproved: false,
      });
    },
  );
});
