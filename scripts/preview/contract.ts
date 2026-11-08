import { deploymentConfig } from '../deploy/config';
import { fingerprint, parseManifest, requireRelease, sameContent } from '../deploy/release-record';
import type { Manifest } from '../deploy/release-record';
import { exact, HASH, ID, SHA } from '../rehearsal/contract';

export const WORKFLOW = '.github/workflows/preview-canary.yml';
export const ENVIRONMENT = 'preview-canary';
export const CAPABILITIES = Object.freeze({
  productionApproved: false,
  acceptanceEnabled: false,
  humanAuthorizationVerified: false,
  independentWitnessVerified: false,
  productionPublicationEnabled: false,
});
const TAG = /^[a-f0-9]{32}$/;
export const OBJECTS = {
  SESSION_ROOMS: 'SessionRoom',
  RELAY_POOLS: 'RelayPool',
  OPERATIONS_MONITOR: 'OperationsMonitor',
} as const;
export type Target = {
  schemaVersion: 1;
  environment: 'preview';
  accountId: string;
  worker: string;
  project: string;
  projectId: string;
  origin: string;
  githubEnvironmentId: string;
  migrationTag: 'v2';
  admissionPaused: true;
  turnProvider: 'direct';
  durableObjects: Record<keyof typeof OBJECTS, { className: string; namespaceId: string }>;
};
export type DenyPins = {
  accountId: string;
  worker: string;
  project: string;
  projectId: string;
  origin: string;
  githubEnvironmentId: string | null;
  durableObjectNamespaces: string[];
};
export type Isolation = { target: Target; deny: DenyPins };
export function isolation(targetValue: unknown, denyValue: unknown): Isolation {
  const t = exact(
    targetValue,
    'schemaVersion,environment,accountId,worker,project,projectId,origin,githubEnvironmentId,migrationTag,admissionPaused,turnProvider,durableObjects',
  );
  const d = exact(
    denyValue,
    'accountId,worker,project,projectId,origin,githubEnvironmentId,durableObjectNamespaces',
  );
  requireRelease(
    t.schemaVersion === 1 &&
      t.environment === 'preview' &&
      t.admissionPaused === true &&
      t.turnProvider === 'direct',
    'PREVIEW_ONLY_PAUSED_DIRECT_REQUIRED',
  );
  requireRelease(
    typeof t.accountId === 'string' &&
      TAG.test(t.accountId) &&
      typeof t.githubEnvironmentId === 'string' &&
      ID.test(t.githubEnvironmentId),
    'EXACT_ISOLATION_PINS_REQUIRED',
  );
  requireRelease(
    typeof d.accountId === 'string' &&
      TAG.test(d.accountId) &&
      (d.githubEnvironmentId === null ||
        (typeof d.githubEnvironmentId === 'string' && ID.test(d.githubEnvironmentId))),
    'EXACT_ISOLATION_PINS_REQUIRED',
  );
  for (const o of [t, d]) {
    requireRelease(
      typeof o.worker === 'string' &&
        /^[a-z][a-z0-9-]{2,60}$/.test(o.worker) &&
        typeof o.project === 'string' &&
        /^[a-z][a-z0-9-]{2,40}$/.test(o.project) &&
        typeof o.projectId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(o.projectId),
      'EXACT_ISOLATION_PINS_REQUIRED',
    );
    requireRelease(
      typeof o.origin === 'string' &&
        /^https:\/\/[a-z0-9.-]+$/.test(o.origin) &&
        new URL(o.origin).origin === o.origin,
      'EXACT_ISOLATION_PINS_REQUIRED',
    );
  }
  // No shared account/resource: an account-scoped edit token must have no production reach.
  for (const k of ['accountId', 'worker', 'project', 'projectId', 'origin'] as const)
    requireRelease(t[k] !== d[k], 'PRODUCTION_RESOURCE_OVERLAP');
  if (d.githubEnvironmentId !== null)
    requireRelease(t.githubEnvironmentId !== d.githubEnvironmentId, 'PRODUCTION_RESOURCE_OVERLAP');
  requireRelease(
    typeof t.project === 'string' &&
      t.project.endsWith('-preview') &&
      t.worker === `${t.project}-signaling` &&
      t.origin === `https://${t.project}.pages.dev` &&
      t.migrationTag === 'v2',
    'PREVIEW_TARGET_IDENTITY_MISMATCH',
  );
  requireRelease(
    Array.isArray(d.durableObjectNamespaces) &&
      d.durableObjectNamespaces.length >= 3 &&
      d.durableObjectNamespaces.every((v) => typeof v === 'string' && TAG.test(v)) &&
      new Set(d.durableObjectNamespaces).size === d.durableObjectNamespaces.length,
    'PRODUCTION_NAMESPACE_DENY_PINS_REQUIRED',
  );
  const objects = exact(t.durableObjects, Object.keys(OBJECTS).join(','));
  const seen = new Set<string>();
  for (const [name, className] of Object.entries(OBJECTS)) {
    const b = exact(objects[name], 'className,namespaceId');
    requireRelease(
      b.className === className &&
        typeof b.namespaceId === 'string' &&
        TAG.test(b.namespaceId) &&
        !seen.has(b.namespaceId) &&
        !d.durableObjectNamespaces.includes(b.namespaceId),
      'PREVIEW_NAMESPACE_ISOLATION_REQUIRED',
    );
    seen.add(b.namespaceId);
  }
  return structuredClone({ target: t, deny: d }) as Isolation;
}
export function verifyProductionEnvironmentPin(deny: DenyPins, value: unknown) {
  requireRelease(
    !!value &&
      typeof value === 'object' &&
      Array.isArray((value as Record<string, unknown>).environments),
    'PRODUCTION_ENVIRONMENT_DENY_STATE_UNVERIFIED',
  );
  const environments = (value as { environments: unknown[] }).environments;
  const production = environments.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).name === 'production',
  );
  requireRelease(production.length <= 1, 'PRODUCTION_ENVIRONMENT_DENY_STATE_UNVERIFIED');
  if (deny.githubEnvironmentId === null) {
    requireRelease(production.length === 0, 'PRODUCTION_ENVIRONMENT_DENY_STATE_CHANGED');
    return;
  }
  requireRelease(
    production.length === 1 && String(production[0]!.id) === deny.githubEnvironmentId,
    'PRODUCTION_ENVIRONMENT_DENY_STATE_CHANGED',
  );
}
export function configured(env: NodeJS.ProcessEnv): Isolation {
  requireRelease(
    env.PREVIEW_CANARY_TARGET_JSON && env.PREVIEW_CANARY_DENY_JSON,
    'PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED',
  );
  // CLI catches parse failures without retaining their potentially sensitive messages.
  return isolation(
    JSON.parse(env.PREVIEW_CANARY_TARGET_JSON),
    JSON.parse(env.PREVIEW_CANARY_DENY_JSON),
  );
}
export function runtime(env: NodeJS.ProcessEnv) {
  requireRelease(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REPOSITORY === 'Shreshtha280407/MeshDrop' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.PREVIEW_CANARY_EXPECTED_REF === env.GITHUB_REF &&
      SHA.test(env.PREVIEW_CANARY_EXPECTED_SHA ?? '') &&
      env.GITHUB_SHA === env.PREVIEW_CANARY_EXPECTED_SHA &&
      env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA &&
      env.GITHUB_WORKFLOW_REF === `Shreshtha280407/MeshDrop/${WORKFLOW}@refs/heads/main` &&
      env.RUNNER_ENVIRONMENT === 'github-hosted',
    'PREVIEW_RUNTIME_SOURCE_MISMATCH',
  );
  for (const [actual, pin] of [
    ['GITHUB_REPOSITORY_ID', 'PREVIEW_CANARY_REPOSITORY_ID'],
    ['GITHUB_REPOSITORY_OWNER_ID', 'PREVIEW_CANARY_OWNER_ID'],
  ] as const)
    requireRelease(
      ID.test(env[pin] ?? '') && env[actual] === env[pin],
      'PREVIEW_REPOSITORY_ID_MISMATCH',
    );
  requireRelease(
    ID.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''),
    'PREVIEW_RUN_ID_REQUIRED',
  );
  // Credentials are explicit and step-local. Never fall back to OAuth, .env or alternate API hosts.
  requireRelease(
    !Object.keys(env).some(
      (k) => /^(?:CLOUDFLARE_|CF_|TURN_|OPS_|METERED_|ADMISSION_)/.test(k) && !!env[k],
    ),
    'UNEXPECTED_PROVIDER_CREDENTIAL_OR_ADMISSION_CONTROL',
  );
  return {
    sourceCommit: env.GITHUB_SHA!,
    sourceRef: env.GITHUB_REF,
    runId: env.GITHUB_RUN_ID!,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
}
export function buildValues(t: Target) {
  return {
    CLOUDFLARE_ACCOUNT_ID: t.accountId,
    PAGES_PROJECT: t.project,
    PUBLIC_ORIGIN: t.origin,
    TURN_PROVIDER: 'direct',
    ADMISSION_PAUSED: 'true',
    // Generator validates operator-key shape. This value is NEVER uploaded as a binding/secret.
    OPS_REVOKE_SECRET: 'p'.repeat(43),
  };
}
export function manifestGate(
  value: unknown,
  pins: Isolation,
  sourceCommit: string,
  expectedDigest: string,
  worker: unknown,
  pages: unknown,
): Manifest {
  const { target: t } = isolation(pins.target, pins.deny),
    m = parseManifest(value);
  requireRelease(
    HASH.test(expectedDigest) &&
      m.id === expectedDigest &&
      m.sourceCommit === sourceCommit &&
      SHA.test(sourceCommit),
    'PREVIEW_MANIFEST_SOURCE_MISMATCH',
  );
  requireRelease(
    m.environment === 'preview' &&
      m.accountId === t.accountId &&
      m.worker === t.worker &&
      m.project === t.project &&
      m.origin === t.origin &&
      m.admissionPaused === true,
    'PREVIEW_MANIFEST_SCOPE_MISMATCH',
  );
  const config = deploymentConfig('preview', buildValues(t), process.cwd());
  requireRelease(
    sameContent(config.worker, worker) &&
      sameContent(config.pages, pages) &&
      m.configurationSha256 === fingerprint({ worker, pages }) &&
      m.migrationsSha256 ===
        fingerprint({
          bindings: config.worker.durable_objects.bindings,
          migrations: config.worker.migrations,
        }),
    'PREVIEW_CONFIGURATION_CHANGED',
  );
  return m;
}
