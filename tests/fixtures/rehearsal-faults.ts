import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { bytesHash } from '../../scripts/deploy/release-record';
import { rehearsalFixture } from './rehearsal';
import type { FaultTarget } from '../../scripts/rehearsal/fault-contract';

export function faultFixture() {
  const f = rehearsalFixture();
  const target: FaultTarget = {
    mode: 'rehearsal-only',
    rehearsalOnly: true,
    environment: 'preview',
    environmentName: 'trust-rehearsal-preview',
    environmentId: '555',
    expectedEnvironmentId: '555',
    production: {
      environmentId: '999',
      database: 'meshdrop_production',
      storeId: '70000000-0000-4000-8000-000000000001',
    },
    executable: '/usr/bin/psql',
    host: 'localhost',
    port: 5432,
    database: 'meshdrop_rehearsal_fixture',
    user: 'fault_writer',
    readerUser: 'fault_reader',
    caFile: '/tmp/server.crt',
    passwordFile: '/tmp/writer',
    readerPasswordFile: '/tmp/reader',
    storeId: f.config.storeId,
    caSha256: 'd'.repeat(64),
    psqlSha256: 'e'.repeat(64),
  };
  const roots = readFileSync('tests/fixtures/sigstore/trusted_root.json');
  const authority = JSON.parse(roots.toString()).certificateAuthorities[0].certChain
    .certificates[0];
  const ca = new X509Certificate(Buffer.from(authority.rawBytes, 'base64')).toString();
  const normal = {
    environment: 'preview',
    host: 'localhost',
    port: 5432,
    database: 'normal_rehearsal',
    user: 'normal_writer',
    caPem: ca,
    caSha256: bytesHash(ca),
    storeId: '80000000-0000-4000-8000-000000000001',
    psqlPath: '/usr/bin/psql',
    psqlSha256: 'e'.repeat(64),
  };
  const db = {
    environment: 'preview',
    environmentName: target.environmentName,
    environmentId: '555',
    rehearsalOnly: true,
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    readerUser: target.readerUser,
    caPem: ca,
    caSha256: bytesHash(ca),
    storeId: target.storeId,
    psqlPath: target.executable,
    psqlSha256: target.psqlSha256,
  };
  const now = new Date();
  const env = {
    ...f.env,
    REHEARSAL_GITHUB_ENVIRONMENT_NAME: 'trust-rehearsal-preview',
    REHEARSAL_FAULT_TESTS: 'true',
    REHEARSAL_FAULT_MODE: 'rehearsal-only',
    REHEARSAL_ROOTS_BASE64: roots.toString('base64'),
    REHEARSAL_ROOT_SHA256: bytesHash(roots),
    REHEARSAL_ROOT_REVIEWED_AT: now.toISOString(),
    REHEARSAL_ROOT_VALID_UNTIL: new Date(now.getTime() + 3600000).toISOString(),
    REHEARSAL_GH_PATH: '/usr/bin/gh',
    REHEARSAL_GH_SHA256: 'e'.repeat(64),
    REHEARSAL_DATABASES_JSON: JSON.stringify({
      preview: normal,
      production: { database: target.production.database, storeId: target.production.storeId },
    }),
    REHEARSAL_FAULT_DATABASE_JSON: JSON.stringify(db),
    REHEARSAL_DB_PASSWORD: 'synthetic-normal-offline-canary',
    REHEARSAL_FAULT_DB_PASSWORD: 'synthetic-writer-offline-canary',
    REHEARSAL_FAULT_DB_READER_PASSWORD: 'synthetic-reader-offline-canary',
    TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID: '999',
  };
  return { ...f, target, env, normal, db };
}
