import { isAbsolute } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { bytesHash, requireRelease } from '../deploy/release-record';
import { assertNoDeployCredentials, exact, HASH, ID, SHA, UUID } from './contract';
import type { RehearsalArtifact } from './contract';
import { parseFaultTarget, FAULT_MODES, faultScope } from './fault-contract';
import type { FaultTarget } from './fault-contract';
import { runtimeExpectation } from './preflight';

type Env = Record<string, string | undefined>;
export const NORMAL_DB_KEYS =
  'environment,host,port,database,user,caPem,caSha256,storeId,psqlPath,psqlSha256';
export const FAULT_DB_KEYS =
  'environment,environmentName,environmentId,rehearsalOnly,host,port,database,user,readerUser,caPem,caSha256,storeId,psqlPath,psqlSha256';
export function normalDatabase(env: Env) {
  const all = JSON.parse(env.REHEARSAL_DATABASES_JSON || '{}');
  return exact(
    env.REHEARSAL_DB_CONFIGURATION
      ? JSON.parse(env.REHEARSAL_DB_CONFIGURATION)
      : all[env.REHEARSAL_ENVIRONMENT!],
    NORMAL_DB_KEYS,
  );
}
export function faultDatabase(env: Env) {
  return exact(JSON.parse(env.REHEARSAL_FAULT_DATABASE_JSON || 'null'), FAULT_DB_KEYS);
}
export function buildFaultTarget(
  env: Env,
  artifact: Pick<RehearsalArtifact, 'environment'>,
  paths: { caFile: string; passwordFile: string; readerPasswordFile: string },
): FaultTarget {
  const db = faultDatabase(env);
  const all = JSON.parse(env.REHEARSAL_DATABASES_JSON || '{}');
  const production = all.production;
  return parseFaultTarget(
    {
      mode: env.REHEARSAL_FAULT_MODE,
      rehearsalOnly: db.rehearsalOnly,
      environment: env.REHEARSAL_ENVIRONMENT,
      environmentName: env.REHEARSAL_GITHUB_ENVIRONMENT_NAME,
      environmentId: db.environmentId,
      expectedEnvironmentId: env.TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID,
      production: {
        environmentId: env.TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID || null,
        database: production?.database || null,
        storeId: production?.storeId || null,
      },
      executable: db.psqlPath,
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      readerUser: db.readerUser,
      storeId: db.storeId,
      caSha256: db.caSha256,
      psqlSha256: db.psqlSha256,
      ...paths,
    },
    artifact,
  );
}
/** Pure/read-only structural pre-dispatch check. No provider, DB or filesystem write. */
export function checkConfiguration(
  env: Env,
  requirements: 'normal' | 'faults' | 'all' = 'all',
  now = new Date(),
) {
  const issues = new Set<string>();
  const secrets: Record<string, { present: boolean }> = {};
  const demand = (name: string, valid: boolean) => {
    if (!valid) issues.add(name);
  };
  const required = (name: string) => {
    const value = env[name];
    demand(name, typeof value === 'string' && value.length > 0);
    return value || '';
  };
  try {
    assertNoDeployCredentials(env);
  } catch {
    issues.add('UNEXPECTED_DEPLOY_CREDENTIAL_OR_CONTROL');
  }
  demand(
    'REHEARSAL_ENVIRONMENT',
    ['preview', 'production'].includes(required('REHEARSAL_ENVIRONMENT')),
  );
  demand(
    'REHEARSAL_GITHUB_ENVIRONMENT_NAME',
    required('REHEARSAL_GITHUB_ENVIRONMENT_NAME') ===
      `trust-rehearsal-${env.REHEARSAL_ENVIRONMENT}`,
  );
  for (const key of [
    'TRUST_REHEARSAL_REPOSITORY_ID',
    'TRUST_REHEARSAL_OWNER_ID',
    env.REHEARSAL_ENVIRONMENT === 'production'
      ? 'TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID'
      : 'TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID',
  ])
    demand(key, ID.test(required(key)));
  demand('REHEARSAL_EXPECTED_SOURCE', SHA.test(required('REHEARSAL_EXPECTED_SOURCE')));
  demand(
    'REHEARSAL_EXPECTED_REF',
    /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(required('REHEARSAL_EXPECTED_REF')),
  );
  try {
    const reviewers = JSON.parse(required('TRUST_REHEARSAL_REVIEWER_IDS'));
    demand(
      'TRUST_REHEARSAL_REVIEWER_IDS',
      Array.isArray(reviewers) &&
        reviewers.length > 0 &&
        reviewers.length <= 6 &&
        reviewers.every((v) => typeof v === 'string' && ID.test(v)) &&
        new Set(reviewers).size === reviewers.length,
    );
  } catch {
    issues.add('TRUST_REHEARSAL_REVIEWER_IDS');
  }
  demand('REHEARSAL_GH_PATH', isAbsolute(required('REHEARSAL_GH_PATH')));
  demand('REHEARSAL_GH_SHA256', HASH.test(required('REHEARSAL_GH_SHA256')));
  const roots = required('REHEARSAL_ROOTS_BASE64'),
    digest = required('REHEARSAL_ROOT_SHA256');
  demand(
    'REHEARSAL_ROOTS_BASE64',
    roots.length > 0 && roots.length <= 1400000 && /^[A-Za-z0-9+/=]+$/.test(roots),
  );
  demand(
    'REHEARSAL_ROOT_SHA256',
    HASH.test(digest) && bytesHash(Buffer.from(roots, 'base64')) === digest,
  );
  try {
    const entries = Buffer.from(roots, 'base64').toString('utf8').trim().split('\n');
    demand('REHEARSAL_ROOTS_BASE64', entries.length > 0 && entries.length <= 8);
    for (const line of entries) {
      const root = JSON.parse(line);
      demand(
        'REHEARSAL_ROOTS_BASE64',
        root.mediaType === 'application/vnd.dev.sigstore.trustedroot+json;version=0.1' &&
          Array.isArray(root.certificateAuthorities) &&
          root.certificateAuthorities.length > 0,
      );
      for (const authority of root.certificateAuthorities) {
        demand(
          'REHEARSAL_ROOTS_BASE64',
          Array.isArray(authority.certChain?.certificates) &&
            authority.certChain.certificates.length > 0,
        );
        for (const cert of authority.certChain.certificates)
          new X509Certificate(Buffer.from(cert.rawBytes, 'base64'));
      }
    }
  } catch {
    issues.add('REHEARSAL_ROOTS_BASE64');
  }
  const reviewed = Date.parse(required('REHEARSAL_ROOT_REVIEWED_AT')),
    expires = Date.parse(required('REHEARSAL_ROOT_VALID_UNTIL'));
  demand('REHEARSAL_ROOT_REVIEWED_AT', Number.isFinite(reviewed) && reviewed <= now.getTime());
  demand(
    'REHEARSAL_ROOT_VALID_UNTIL',
    Number.isFinite(expires) &&
      expires > now.getTime() &&
      expires > reviewed &&
      expires - reviewed <= 7 * 86400000,
  );
  const credential = (key: string) => {
    const present = !!env[key];
    secrets[key] = { present };
    demand(key, present);
  };
  const shape = (value: unknown, keys: string, prefix: string) => {
    const db =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    for (const key of keys.split(',')) demand(prefix + '.' + key, Object.hasOwn(db, key));
    demand(
      prefix + '.UNEXPECTED_FIELDS',
      Object.keys(db).every((k) => keys.split(',').includes(k)),
    );
    return db;
  };
  const validateDb = (db: Record<string, unknown>, prefix: string) => {
    demand(prefix + '.environment', db.environment === env.REHEARSAL_ENVIRONMENT);
    demand(prefix + '.host', typeof db.host === 'string' && /^[A-Za-z0-9.-]+$/.test(db.host));
    demand(
      prefix + '.port',
      Number.isInteger(db.port) && Number(db.port) > 0 && Number(db.port) <= 65535,
    );
    for (const k of ['database', 'user'])
      demand(
        prefix + '.' + k,
        typeof db[k] === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(db[k]),
      );
    demand(prefix + '.storeId', typeof db.storeId === 'string' && UUID.test(db.storeId));
    demand(prefix + '.psqlPath', typeof db.psqlPath === 'string' && isAbsolute(db.psqlPath));
    demand(prefix + '.psqlSha256', typeof db.psqlSha256 === 'string' && HASH.test(db.psqlSha256));
    demand(
      prefix + '.caPem',
      typeof db.caPem === 'string' &&
        db.caPem.includes('-----BEGIN CERTIFICATE-----') &&
        db.caPem.length <= 65536 &&
        !db.caPem.includes('PRIVATE KEY'),
    );
    demand(
      prefix + '.caSha256',
      typeof db.caPem === 'string' &&
        typeof db.caSha256 === 'string' &&
        HASH.test(db.caSha256) &&
        bytesHash(db.caPem) === db.caSha256,
    );
    try {
      new X509Certificate(db.caPem as string);
    } catch {
      issues.add(prefix + '.caPem');
    }
  };
  const wantNormal = requirements !== 'faults',
    wantFaults =
      requirements === 'faults' || (requirements === 'all' && env.REHEARSAL_FAULT_TESTS === 'true');
  demand(
    'REHEARSAL_FAULT_TESTS',
    env.REHEARSAL_FAULT_TESTS === undefined ||
      ['true', 'false'].includes(env.REHEARSAL_FAULT_TESTS),
  );
  if (wantNormal) {
    try {
      const all = JSON.parse(env.REHEARSAL_DATABASES_JSON || '{}');
      const raw = env.REHEARSAL_DB_CONFIGURATION
        ? JSON.parse(env.REHEARSAL_DB_CONFIGURATION)
        : all[env.REHEARSAL_ENVIRONMENT!];
      const prefix = 'REHEARSAL_DATABASES_JSON.' + env.REHEARSAL_ENVIRONMENT;
      validateDb(shape(raw, NORMAL_DB_KEYS, prefix), prefix);
    } catch {
      issues.add('REHEARSAL_DATABASES_JSON.' + env.REHEARSAL_ENVIRONMENT);
    }
    credential('REHEARSAL_DB_PASSWORD');
  }
  if (wantFaults) {
    demand('REHEARSAL_FAULT_TESTS', env.REHEARSAL_FAULT_TESTS === 'true');
    demand('REHEARSAL_FAULT_MODE', env.REHEARSAL_FAULT_MODE === 'rehearsal-only');
    demand('REHEARSAL_ENVIRONMENT', env.REHEARSAL_ENVIRONMENT === 'preview');
    try {
      const db = shape(
        JSON.parse(env.REHEARSAL_FAULT_DATABASE_JSON || 'null'),
        FAULT_DB_KEYS,
        'REHEARSAL_FAULT_DATABASE_JSON',
      );
      validateDb(db, 'REHEARSAL_FAULT_DATABASE_JSON');
      demand(
        'REHEARSAL_FAULT_DATABASE_JSON.environmentName',
        db.environmentName === 'trust-rehearsal-preview' &&
          db.environmentName === env.REHEARSAL_GITHUB_ENVIRONMENT_NAME,
      );
      // Paths are structural placeholders only; no credential file is created/read here.
      buildFaultTarget(
        env,
        { environment: env.REHEARSAL_ENVIRONMENT as 'preview' },
        {
          caFile: '/uncreated/ca.pem',
          passwordFile: '/uncreated/writer',
          readerPasswordFile: '/uncreated/reader',
        },
      );
    } catch {
      issues.add('REHEARSAL_FAULT_DATABASE_JSON');
    }
    credential('REHEARSAL_FAULT_DB_PASSWORD');
    credential('REHEARSAL_FAULT_DB_READER_PASSWORD');
  }
  if (env.GITHUB_ACTIONS === 'true')
    try {
      runtimeExpectation(env, '00000000-0000-4000-8000-000000000000');
    } catch {
      issues.add('GITHUB_RUNTIME_IDENTITY');
    }
  return {
    status: issues.size
      ? ('NOT_READY_FOR_HOSTED_REHEARSAL' as const)
      : ('READY_FOR_HOSTED_REHEARSAL' as const),
    configurationScope: 'supplied-structural-settings-only',
    faultScopes: wantFaults
      ? Object.fromEntries(FAULT_MODES.map((mode) => [mode, faultScope(mode)]))
      : {},
    issues: [...issues].sort(),
    secrets,
    githubProtectionVerified: false,
    databaseConnectionAttempted: false,
    authorizationVerified: false,
    independentWitnessVerified: false,
    publicationEnabled: false,
    acceptanceEnabled: false,
    productionApproved: false,
  };
}
export function requireConfiguration(env: Env, requirements: 'normal' | 'faults') {
  const report = checkConfiguration(env, requirements);
  requireRelease(
    report.status === 'READY_FOR_HOSTED_REHEARSAL',
    'REHEARSAL_CONFIGURATION_INCOMPLETE',
  );
  return report;
}
