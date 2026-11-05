import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const REPOSITORY = 'https://github.com/Shreshtha280407/MeshDrop';
export type Environment = 'preview' | 'production';
export type Inventory = Record<string, string>;
export type Manifest = {
  schemaVersion: 2;
  repository: typeof REPOSITORY;
  sourceCommit: string;
  sourceTreeSha256: string;
  environment: Environment;
  accountId: string;
  origin: string;
  worker: string;
  project: string;
  protocolVersion: number;
  admissionPaused: boolean;
  preparedAt: string;
  files: Inventory;
  workerFiles: Inventory;
  gatewaySha256: string;
  configurationSha256: string;
  migrationsSha256: string;
  toolchain: { node: string; pnpm: string; esbuild: string; vite: string; lockSha256: string };
  id: string;
};
export const ACCEPTANCE_CHECKS = [
  'artifact-identity',
  'admission',
  'authorization',
  'persisted-state',
  'transfer-receipt',
  'operations',
  'recovery-plan',
] as const;
export type ProviderIdentity = {
  accountId: string;
  environment: Environment;
  worker: string;
  project: string;
  origin: string;
  manifestId: string;
  sourceCommit: string;
  configurationSha256: string;
  workerVersion: string;
  pagesDeployment: string;
  admissionPaused: boolean;
  observedAt: string;
};
export type ReleaseRecord = {
  recordVersion: 1;
  manifestId: string;
  scope: 'unverified' | 'offline-fixture' | 'hosted-observation';
  state: 'PREPARED' | 'PUBLISHED' | 'ACCEPTED' | 'REJECTED' | 'INCOMPLETE';
  phase:
    | 'prepared'
    | 'preflight'
    | 'worker-intent'
    | 'worker-confirmed'
    | 'pages-intent'
    | 'pages-confirmed'
    | 'readiness'
    | 'published'
    | 'acceptance'
    | 'cleanup';
  sequence: number;
  admission: {
    action: 'preserve' | 'pause' | 'reopen';
    observedPaused: boolean;
    desiredPaused: boolean;
    previousWorkerVersion: string;
  } | null;
  provider: {
    workerVersion: string | null;
    pagesDeployment: string | null;
    confirmed: boolean;
    observation: ProviderIdentity | null;
  };
  acceptance: {
    operator: string;
    decidedAt: string;
    decision: 'ACCEPT' | 'REJECT';
    evidence: Record<(typeof ACCEPTANCE_CHECKS)[number], string>;
  } | null;
  failure: string | null;
};
export class ReleaseError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireRelease(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ReleaseError(code);
}
export function canonical(value: unknown): string {
  function sort(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      requireRelease(Number.isFinite(item), 'NON_CANONICAL_VALUE');
      return item;
    }
    if (Array.isArray(item)) return item.map(sort);
    requireRelease(
      item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype,
      'NON_CANONICAL_VALUE',
    );
    return Object.fromEntries(
      Object.entries(item)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    );
  }
  return JSON.stringify(sort(value)) + '\n';
}
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function fields(value: unknown, keys: string): Record<string, unknown> {
  requireRelease(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_RELEASE_RECORD',
  );
  const object = value as Record<string, unknown>;
  requireRelease(
    Object.keys(object).sort().join(',') === keys.split(',').sort().join(','),
    'UNEXPECTED_RECORD_FIELDS',
  );
  return object;
}
function inventory(value: unknown): value is Inventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([name, digest]) =>
        /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(name) &&
        !name.split('/').some((part) => !part || part === '..' || part === '.') &&
        hash(digest),
    )
  );
}
export function sealManifest(value: Omit<Manifest, 'id'>): Manifest {
  return parseManifest({ ...value, id: fingerprint(value) });
}
export function parseManifest(value: unknown): Manifest {
  const record = fields(
    value,
    'schemaVersion,repository,sourceCommit,sourceTreeSha256,environment,accountId,origin,worker,project,protocolVersion,admissionPaused,preparedAt,files,workerFiles,gatewaySha256,configurationSha256,migrationsSha256,toolchain,id',
  );
  requireRelease(
    record.schemaVersion === 2 &&
      record.repository === REPOSITORY &&
      sha(record.sourceCommit) &&
      hash(record.sourceTreeSha256),
    'INVALID_SOURCE_IDENTITY',
  );
  requireRelease(
    ['preview', 'production'].includes(String(record.environment)) &&
      typeof record.accountId === 'string' &&
      /^[a-f0-9]{32}$/.test(record.accountId),
    'INVALID_RELEASE_SCOPE',
  );
  requireRelease(
    typeof record.project === 'string' &&
      /^[a-z][a-z0-9-]{2,40}$/.test(record.project) &&
      record.project.endsWith(`-${record.environment}`) &&
      record.worker === `${record.project}-signaling`,
    'INVALID_RELEASE_SCOPE',
  );
  requireRelease(
    typeof record.origin === 'string' &&
      /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(record.origin) &&
      new URL(record.origin).origin === record.origin,
    'INVALID_RELEASE_ORIGIN',
  );
  requireRelease(
    Number.isSafeInteger(record.protocolVersion) &&
      Number(record.protocolVersion) > 0 &&
      typeof record.admissionPaused === 'boolean' &&
      time(record.preparedAt),
    'INVALID_RELEASE_METADATA',
  );
  requireRelease(
    inventory(record.files) &&
      inventory(record.workerFiles) &&
      hash(record.gatewaySha256) &&
      hash(record.configurationSha256) &&
      hash(record.migrationsSha256),
    'INVALID_ARTIFACT_IDENTITY',
  );
  requireRelease(
    record.files['_worker.js'] === record.gatewaySha256 && hash(record.workerFiles['index.js']),
    'INVALID_ARTIFACT_IDENTITY',
  );
  const tools = fields(record.toolchain, 'node,pnpm,esbuild,vite,lockSha256');
  requireRelease(
    typeof tools.node === 'string' &&
      /^v\d+\.\d+\.\d+$/.test(tools.node) &&
      ['pnpm', 'esbuild', 'vite'].every(
        (name) => typeof tools[name] === 'string' && /^\d+\.\d+\.\d+$/.test(String(tools[name])),
      ) &&
      hash(tools.lockSha256),
    'INVALID_TOOLCHAIN',
  );
  const { id, ...payload } = record;
  requireRelease(hash(id) && id === fingerprint(payload), 'MANIFEST_INTEGRITY_MISMATCH');
  return record as unknown as Manifest;
}
export function initialRecord(manifest: Manifest): ReleaseRecord {
  parseManifest(manifest);
  return {
    recordVersion: 1,
    manifestId: manifest.id,
    scope: 'unverified',
    state: 'PREPARED',
    phase: 'prepared',
    sequence: 0,
    admission: null,
    provider: { workerVersion: null, pagesDeployment: null, confirmed: false, observation: null },
    acceptance: null,
    failure: null,
  };
}
export function validateIdentity(value: unknown, manifest: Manifest): ProviderIdentity {
  const item = fields(
    value,
    'accountId,environment,worker,project,origin,manifestId,sourceCommit,configurationSha256,workerVersion,pagesDeployment,admissionPaused,observedAt',
  );
  for (const key of [
    'accountId',
    'environment',
    'worker',
    'project',
    'origin',
    'manifestId',
    'sourceCommit',
    'configurationSha256',
    'admissionPaused',
  ] as const)
    requireRelease(
      item[key] === manifest[key === 'manifestId' ? 'id' : key],
      'PROVIDER_IDENTITY_MISMATCH',
    );
  requireRelease(
    uuid(item.workerVersion) && uuid(item.pagesDeployment) && time(item.observedAt),
    'INVALID_PROVIDER_IDENTITY',
  );
  return item as unknown as ProviderIdentity;
}
export function parseRecord(value: unknown, manifest: Manifest): ReleaseRecord {
  const item = fields(
    value,
    'recordVersion,manifestId,scope,state,phase,sequence,admission,provider,acceptance,failure',
  );
  requireRelease(
    item.recordVersion === 1 &&
      item.manifestId === manifest.id &&
      ['unverified', 'offline-fixture', 'hosted-observation'].includes(String(item.scope)) &&
      ['PREPARED', 'PUBLISHED', 'ACCEPTED', 'REJECTED', 'INCOMPLETE'].includes(
        String(item.state),
      ) &&
      [
        'prepared',
        'preflight',
        'worker-intent',
        'worker-confirmed',
        'pages-intent',
        'pages-confirmed',
        'readiness',
        'published',
        'acceptance',
        'cleanup',
      ].includes(String(item.phase)) &&
      Number.isSafeInteger(item.sequence) &&
      Number(item.sequence) >= 0,
    'INVALID_RELEASE_RECORD',
  );
  const provider = fields(item.provider, 'workerVersion,pagesDeployment,confirmed,observation');
  if (item.admission !== null) {
    const admission = fields(
      item.admission,
      'action,observedPaused,desiredPaused,previousWorkerVersion',
    );
    requireRelease(
      ['preserve', 'pause', 'reopen'].includes(String(admission.action)) &&
        typeof admission.observedPaused === 'boolean' &&
        admission.desiredPaused === manifest.admissionPaused &&
        uuid(admission.previousWorkerVersion),
      'INVALID_ADMISSION_RECORD',
    );
    requireRelease(
      admission.action !== 'preserve' || admission.observedPaused === admission.desiredPaused,
      'INVALID_ADMISSION_RECORD',
    );
    requireRelease(
      admission.action !== 'pause' || admission.desiredPaused === true,
      'INVALID_ADMISSION_RECORD',
    );
    requireRelease(
      admission.action !== 'reopen' || admission.desiredPaused === false,
      'INVALID_ADMISSION_RECORD',
    );
    requireRelease(
      !(admission.observedPaused && !admission.desiredPaused) || admission.action === 'reopen',
      'UNAUTHORIZED_REOPENING',
    );
  }
  if (item.state === 'PREPARED')
    requireRelease(
      item.scope === 'unverified' &&
        item.phase === 'prepared' &&
        item.sequence === 0 &&
        item.admission === null &&
        item.acceptance === null &&
        item.failure === null &&
        provider.workerVersion === null &&
        provider.pagesDeployment === null &&
        provider.observation === null &&
        provider.confirmed === false,
      'PREPARED_RELEASE_CANNOT_CLAIM_PUBLICATION',
    );
  if (item.state === 'PUBLISHED')
    requireRelease(
      item.phase === 'published' && item.acceptance === null && item.failure === null,
      'PUBLISHED_RELEASE_NOT_ACCEPTED',
    );
  requireRelease(
    (provider.workerVersion === null || uuid(provider.workerVersion)) &&
      (provider.pagesDeployment === null || uuid(provider.pagesDeployment)) &&
      typeof provider.confirmed === 'boolean',
    'INVALID_PROVIDER_IDENTITY',
  );
  if (provider.observation !== null) {
    const observation = validateIdentity(provider.observation, manifest);
    requireRelease(
      observation.workerVersion === provider.workerVersion &&
        observation.pagesDeployment === provider.pagesDeployment,
      'PROVIDER_IDENTITY_MISMATCH',
    );
  }
  if (['PUBLISHED', 'ACCEPTED'].includes(String(item.state)))
    requireRelease(
      item.admission !== null &&
        provider.observation !== null &&
        provider.workerVersion &&
        provider.pagesDeployment &&
        item.scope !== 'unverified',
      'INCOMPLETE_PROVIDER_IDENTITY',
    );
  requireRelease(
    provider.confirmed === (item.scope === 'hosted-observation' && provider.observation !== null),
    'INVALID_PROVENANCE_CLAIM',
  );
  requireRelease(
    item.failure === null ||
      (typeof item.failure === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(item.failure)),
    'UNSAFE_FAILURE_DIAGNOSTIC',
  );
  if (item.acceptance !== null) {
    requireRelease(
      item.state === 'ACCEPTED' || item.state === 'REJECTED',
      'PARTIAL_ACCEPTANCE_REJECTED',
    );
    const acceptance = fields(item.acceptance, 'operator,decidedAt,decision,evidence');
    requireRelease(
      typeof acceptance.operator === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(acceptance.operator) &&
        time(acceptance.decidedAt) &&
        ['ACCEPT', 'REJECT'].includes(String(acceptance.decision)),
      'INVALID_ACCEPTANCE',
    );
    const evidence = fields(acceptance.evidence, ACCEPTANCE_CHECKS.join(','));
    requireRelease(
      ACCEPTANCE_CHECKS.every((check) => hash(evidence[check])),
      'INCOMPLETE_ACCEPTANCE_EVIDENCE',
    );
  }
  requireRelease(
    item.state !== 'ACCEPTED' ||
      (item.acceptance !== null &&
        (item.acceptance as { decision: unknown }).decision === 'ACCEPT' &&
        item.failure === null &&
        item.phase === 'acceptance'),
    'INVALID_ACCEPTANCE',
  );
  if (item.state === 'REJECTED')
    requireRelease(
      item.acceptance !== null &&
        (item.acceptance as { decision: unknown }).decision === 'REJECT' &&
        item.phase === 'acceptance',
      'INVALID_REJECTION',
    );
  return item as unknown as ReleaseRecord;
}
export function acceptRelease(
  manifest: Manifest,
  record: ReleaseRecord,
  decision: NonNullable<ReleaseRecord['acceptance']>,
  expected: { manifestId: string; workerVersion: string; pagesDeployment: string },
): ReleaseRecord {
  parseRecord(record, manifest);
  requireRelease(
    record.state === 'PUBLISHED' && record.acceptance === null && record.failure === null,
    'RELEASE_NOT_ACCEPTABLE',
  );
  requireRelease(
    expected.manifestId === manifest.id &&
      expected.workerVersion === record.provider.workerVersion &&
      expected.pagesDeployment === record.provider.pagesDeployment,
    'ACCEPTANCE_IDENTITY_MISMATCH',
  );
  return parseRecord(
    {
      ...record,
      state: decision.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
      phase: 'acceptance',
      sequence: record.sequence + 1,
      acceptance: decision,
    },
    manifest,
  );
}
/** Structural evidence is not authentication. The caller must independently attest it. */
export function requireAccepted(manifest: Manifest, record: ReleaseRecord): void {
  parseRecord(record, manifest);
  requireRelease(
    record.state === 'ACCEPTED' &&
      record.scope === 'hosted-observation' &&
      record.provider.confirmed &&
      record.failure === null,
    'UNVERIFIED_RELEASE_PROVENANCE',
  );
}
export function sameContent(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
