import { bytesHash, canonical } from '../../scripts/deploy/release-record';
import { createArtifact, WORKFLOW } from '../../scripts/rehearsal/contract';
import type { RehearsalDatabase } from '../../scripts/rehearsal/recovery';
import type { AttestationPolicy } from '../../scripts/deploy/github-attestation';

export function rehearsalFixture() {
  const now = '2026-11-06T00:00:00.000Z';
  const artifact = createArtifact(
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
    now,
    '50000000-0000-4000-8000-000000000001',
  );
  const expected = {
    repositoryId: artifact.repositoryId,
    ownerId: artifact.ownerId,
    environment: artifact.environment,
    sourceCommit: artifact.sourceCommit,
    sourceRef: artifact.sourceRef,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    rehearsalId: artifact.rehearsalId,
  };
  const policy: AttestationPolicy = {
    schemaVersion: 2,
    signerRef: artifact.sourceRef,
    repository: 'Shreshtha280407/MeshDrop',
    repositoryId: artifact.repositoryId,
    ownerId: artifact.ownerId,
    signerWorkflow: `Shreshtha280407/MeshDrop/${WORKFLOW}`,
    signerCommit: artifact.sourceCommit,
    sourceCommit: artifact.sourceCommit,
    sourceRef: artifact.sourceRef,
    sourceWorkflow: WORKFLOW,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    artifactSha256: bytesHash(canonical(artifact)),
    trustedRootSha256: 'b'.repeat(64),
    rootReviewedAt: now,
    rootValidUntil: '2026-11-07T00:00:00.000Z',
    ghPath: '/usr/bin/gh',
    ghSha256: 'c'.repeat(64),
  };
  const config: RehearsalDatabase = {
    executable: '/usr/local/bin/psql',
    host: 'localhost',
    port: 5432,
    database: 'meshdrop_release_fixture',
    user: 'fixture_writer',
    caFile: '/tmp/ca.pem',
    passwordFile: '/tmp/pgpass',
    storeId: '60000000-0000-4000-8000-000000000001',
    environment: artifact.environment,
    attemptId: artifact.rehearsalId,
    caSha256: 'd'.repeat(64),
    psqlSha256: 'e'.repeat(64),
  };
  const env: Record<string, string> = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'Shreshtha280407/MeshDrop',
    GITHUB_REPOSITORY_ID: artifact.repositoryId,
    GITHUB_REPOSITORY_OWNER_ID: artifact.ownerId,
    GITHUB_SHA: artifact.sourceCommit,
    GITHUB_REF: artifact.sourceRef,
    GITHUB_WORKFLOW_REF: `Shreshtha280407/MeshDrop/${WORKFLOW}@${artifact.sourceRef}`,
    REHEARSAL_WORKFLOW_SHA: artifact.sourceCommit,
    GITHUB_RUN_ID: artifact.runId,
    GITHUB_RUN_ATTEMPT: '1',
    REHEARSAL_RUNNER_KIND: 'github-hosted',
    REHEARSAL_EXPECTED_SOURCE: artifact.sourceCommit,
    REHEARSAL_EXPECTED_REF: artifact.sourceRef,
    REHEARSAL_ENVIRONMENT: artifact.environment,
    TRUST_REHEARSAL_REPOSITORY_ID: artifact.repositoryId,
    TRUST_REHEARSAL_OWNER_ID: artifact.ownerId,
    TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID: '555',
    TRUST_REHEARSAL_REVIEWER_IDS: '["333"]',
    GITHUB_TOKEN: 'offline-rehearsal-token-canary',
  };
  return { artifact, expected, policy, config, env, now };
}
/** Shape-only data for the pure post-cryptographic policy guard; never a receipt. */
export function signerShape(p: AttestationPolicy) {
  const san = `https://github.com/${p.signerWorkflow}@${p.schemaVersion === 2 ? p.signerRef : p.signerCommit}`;
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            issuer: 'https://token.actions.githubusercontent.com',
            subjectAlternativeName: san,
            buildSignerURI: san,
            buildSignerDigest: p.signerCommit,
            sourceRepositoryURI: `https://github.com/${p.repository}`,
            sourceRepositoryIdentifier: p.repositoryId,
            sourceRepositoryOwnerIdentifier: p.ownerId,
            sourceRepositoryDigest: p.sourceCommit,
            sourceRepositoryRef: p.sourceRef,
            runnerEnvironment: 'github-hosted',
            buildConfigURI: `https://github.com/${p.repository}/${p.sourceWorkflow}@${p.sourceRef}`,
            buildConfigDigest: p.sourceCommit,
            runInvocationURI: `https://github.com/${p.repository}/actions/runs/${p.runId}/attempts/${p.runAttempt}`,
          },
        },
        statement: {
          predicateType: 'https://slsa.dev/provenance/v1',
          subject: [{ digest: { sha256: p.artifactSha256 } }],
        },
        verifiedTimestamps: [{ timestamp: '2026-11-06T00:00:00Z' }],
      },
    },
  ];
}
