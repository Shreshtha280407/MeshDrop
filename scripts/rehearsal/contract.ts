import { randomUUID } from 'node:crypto';
import { canonical, fingerprint, REPOSITORY, requireRelease } from '../deploy/release-record';

export const WORKFLOW = '.github/workflows/release-trust-rehearsal.yml';
export const STATUS = 'HOSTED_TRUST_REHEARSAL_COMPLETE — RELEASE AUTHORIZATION NOT ESTABLISHED';
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const ID = /^[1-9][0-9]{0,19}$/;
export type RehearsalArtifact = {
  schemaVersion: 1;
  purpose: 'trust-rehearsal';
  repository: typeof REPOSITORY;
  repositoryId: string;
  ownerId: string;
  environment: 'preview' | 'production';
  sourceCommit: string;
  sourceRef: string;
  workflow: typeof WORKFLOW;
  runId: string;
  runAttempt: number;
  rehearsalId: string;
  preparedManifestSha256: string | null;
  createdAt: string;
  publicationEnabled: false;
  acceptanceEnabled: false;
  productionApproved: false;
  artifactId: string;
};
export type RehearsalExpectation = Pick<
  RehearsalArtifact,
  | 'repositoryId'
  | 'ownerId'
  | 'environment'
  | 'sourceCommit'
  | 'sourceRef'
  | 'runId'
  | 'runAttempt'
  | 'rehearsalId'
>;
export function exact(value: unknown, keys: string): Record<string, unknown> {
  requireRelease(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_REHEARSAL_OBJECT',
  );
  requireRelease(
    Object.keys(value).sort().join(',') === keys.split(',').sort().join(','),
    'UNEXPECTED_REHEARSAL_FIELDS',
  );
  return value as Record<string, unknown>;
}
export function flags(value: Record<string, unknown>): void {
  requireRelease(
    value.publicationEnabled === false &&
      value.acceptanceEnabled === false &&
      value.productionApproved === false,
    'REHEARSAL_CANNOT_AUTHORIZE_RELEASE',
  );
}
export function parseArtifact(value: unknown): RehearsalArtifact {
  const a = exact(
    value,
    'schemaVersion,purpose,repository,repositoryId,ownerId,environment,sourceCommit,sourceRef,workflow,runId,runAttempt,rehearsalId,preparedManifestSha256,createdAt,publicationEnabled,acceptanceEnabled,productionApproved,artifactId',
  );
  flags(a);
  requireRelease(
    a.schemaVersion === 1 &&
      a.purpose === 'trust-rehearsal' &&
      a.repository === REPOSITORY &&
      a.workflow === WORKFLOW &&
      ['repositoryId', 'ownerId', 'runId'].every(
        (k) => typeof a[k] === 'string' && ID.test(a[k]),
      ) &&
      (a.environment === 'preview' || a.environment === 'production') &&
      typeof a.sourceCommit === 'string' &&
      SHA.test(a.sourceCommit) &&
      typeof a.sourceRef === 'string' &&
      /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(a.sourceRef) &&
      Number.isSafeInteger(a.runAttempt) &&
      Number(a.runAttempt) > 0 &&
      typeof a.rehearsalId === 'string' &&
      UUID.test(a.rehearsalId) &&
      (a.preparedManifestSha256 === null ||
        (typeof a.preparedManifestSha256 === 'string' && HASH.test(a.preparedManifestSha256))) &&
      typeof a.createdAt === 'string' &&
      Number.isFinite(Date.parse(a.createdAt)) &&
      new Date(a.createdAt).toISOString() === a.createdAt,
    'INVALID_REHEARSAL_IDENTITY',
  );
  const { artifactId, ...payload } = a;
  requireRelease(
    typeof artifactId === 'string' &&
      HASH.test(artifactId) &&
      fingerprint(payload) === artifactId &&
      Buffer.byteLength(canonical(a)) <= 8192,
    'REHEARSAL_ARTIFACT_INTEGRITY_MISMATCH',
  );
  return structuredClone(a) as RehearsalArtifact;
}
export function createArtifact(
  identity: Omit<
    RehearsalArtifact,
    | 'schemaVersion'
    | 'purpose'
    | 'repository'
    | 'workflow'
    | 'publicationEnabled'
    | 'acceptanceEnabled'
    | 'productionApproved'
    | 'artifactId'
    | 'createdAt'
    | 'rehearsalId'
  >,
  createdAt = new Date().toISOString(),
  rehearsalId: string = randomUUID(),
): RehearsalArtifact {
  exact(
    identity,
    'repositoryId,ownerId,environment,sourceCommit,sourceRef,runId,runAttempt,preparedManifestSha256',
  );
  const payload = {
    ...identity,
    schemaVersion: 1 as const,
    purpose: 'trust-rehearsal' as const,
    repository: REPOSITORY,
    workflow: WORKFLOW,
    createdAt,
    rehearsalId,
    publicationEnabled: false as const,
    acceptanceEnabled: false as const,
    productionApproved: false as const,
  };
  return parseArtifact({ ...payload, artifactId: fingerprint(payload) });
}
export function matchArtifact(artifact: RehearsalArtifact, expected: RehearsalExpectation) {
  exact(
    expected,
    'repositoryId,ownerId,environment,sourceCommit,sourceRef,runId,runAttempt,rehearsalId',
  );
  parseArtifact(artifact);
  for (const key of [
    'repositoryId',
    'ownerId',
    'environment',
    'sourceCommit',
    'sourceRef',
    'runId',
    'runAttempt',
    'rehearsalId',
  ] as const)
    requireRelease(artifact[key] === expected[key], 'REHEARSAL_EXPECTATION_MISMATCH');
}
export function rehearsalScope(artifact: RehearsalArtifact): string {
  parseArtifact(artifact);
  return fingerprint({
    repository: REPOSITORY,
    environment: artifact.environment,
    purpose: 'trust-rehearsal',
  });
}
export function assertNoDeployCredentials(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key === 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV' && value === 'false') continue;
    if (key === 'WRANGLER_SEND_METRICS' && value === 'false') continue;
    requireRelease(
      !/^(?:CLOUDFLARE_|CF_|WRANGLER_|ADMISSION_|TURN_|OPS_|METERED_)/.test(key) &&
        !/^(?:GH_TOKEN|DATABASE_URL|PGPASSWORD|PUBLICATION_ENABLED|ACCEPTANCE_ENABLED|PRODUCTION_APPROVED)$/.test(
          key,
        ),
      'UNEXPECTED_DEPLOY_CREDENTIAL_OR_CONTROL',
    );
  }
}
