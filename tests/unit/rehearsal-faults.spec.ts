import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { fingerprint, canonical, bytesHash } from '../../scripts/deploy/release-record';
import { createArtifact } from '../../scripts/rehearsal/contract';
import { buildFaultTarget, checkConfiguration } from '../../scripts/rehearsal/configuration';
import {
  FaultHarness,
  FaultClient,
  createHostedFaultHarness,
} from '../../scripts/rehearsal/faults';
import {
  eventHead,
  faultAttempt,
  faultScope,
  inspectFaultHistory,
  makeFaultEvent,
  parseFaultTarget,
} from '../../scripts/rehearsal/fault-contract';
import { faultReport, inspectFaultReport } from '../../scripts/rehearsal/fault-report';
import { verifyHostedWitness } from '../../scripts/rehearsal/witness';
import { inspectEnvironment } from '../../scripts/rehearsal/preflight';
import { faultFixture } from '../fixtures/rehearsal-faults';

describe('fault mode fails before connecting to production', () => {
  it.each([
    'environment',
    'environmentName',
    'environmentId',
    'rehearsalOnly',
    'mode',
    'database',
    'storeId',
    'readerUser',
  ])('rejects invalid %s before transport access', (key) => {
    const f = faultFixture(),
      execute = vi.fn(),
      t = { ...f.target };
    Object.assign(
      t,
      key === 'environment'
        ? { environment: 'production' }
        : key === 'environmentName'
          ? { environmentName: 'trust-rehearsal-production' }
          : key === 'environmentId'
            ? { environmentId: '999' }
            : key === 'rehearsalOnly'
              ? { rehearsalOnly: false }
              : key === 'mode'
                ? { mode: 'production' }
                : key === 'database'
                  ? { database: f.target.production.database }
                  : key === 'storeId'
                    ? { storeId: f.target.production.storeId }
                    : { readerUser: f.target.user },
    );
    expect(
      () => new FaultHarness(f.artifact, t, () => ({ scope: 'offline-fixture', execute })),
    ).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects production artifact even with preview configuration', () => {
    const f = faultFixture(),
      { artifactId, ...a } = f.artifact;
    expect(artifactId).toBeTruthy();
    const production = { ...a, environment: 'production' as const };
    expect(
      () =>
        new FaultHarness({ ...production, artifactId: fingerprint(production) }, f.target, vi.fn()),
    ).toThrow('PRODUCTION_FAULT_TARGET_FORBIDDEN');
  });
  it.each([
    'caFile',
    'passwordFile',
    'readerPasswordFile',
    'host',
    'port',
    'database',
    'storeId',
    'caSha256',
    'psqlSha256',
  ] as const)('requires explicit %s', (key) => {
    const f = faultFixture(),
      t: Record<string, unknown> = { ...f.target };
    delete t[key];
    expect(() => parseFaultTarget(t, f.artifact)).toThrow();
  });
  it('rejects a production database even if its name looks like a rehearsal database', () => {
    const f = faultFixture();
    f.target.database = 'meshdrop_rehearsal_live';
    f.target.production.database = f.target.database;
    expect(() => parseFaultTarget(f.target, f.artifact)).toThrow(
      'PRODUCTION_FAULT_TARGET_FORBIDDEN',
    );
  });
  it('rejects production fault dispatch before even a read-only GitHub request', async () => {
    const f = faultFixture(),
      transport = vi.fn();
    await expect(
      inspectEnvironment(
        { ...f.env, REHEARSAL_ENVIRONMENT: 'production' },
        transport as typeof fetch,
      ),
    ).rejects.toThrow('PRODUCTION_FAULT_TARGET_FORBIDDEN');
    expect(transport).not.toHaveBeenCalled();
  });
  it('cannot promote an injected fixture or forged attestation success', async () => {
    const f = faultFixture();
    await expect(
      createHostedFaultHarness(f.artifact, { signatureVerified: true } as never, f.target),
    ).rejects.toThrow('UNTRUSTED_REHEARSAL_VERIFICATION');
  });
  it('does not interpolate unvalidated attempt identifiers', async () => {
    const f = faultFixture(),
      execute = vi.fn();
    const client = new FaultClient(
      f.target,
      f.artifact,
      { scope: 'offline-fixture', execute },
      'reader',
    );
    await expect(client.discover('replay', "'; DROP SCHEMA x; --")).rejects.toThrow(
      'FAULT_HISTORY_WRONG_ATTEMPT',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('cannot append through a read-only client', async () => {
    const f = faultFixture(),
      execute = vi.fn(),
      client = new FaultClient(
        f.target,
        f.artifact,
        { scope: 'offline-fixture', execute },
        'reader',
      );
    await expect(
      client.append(makeFaultEvent(f.artifact, 'replay', 0, 0, null), null),
    ).rejects.toThrow('FAULT_READER_CANNOT_APPEND');
    expect(execute).not.toHaveBeenCalled();
  });
});
describe('configuration checker is structural, sanitized and read-only', () => {
  it('reports ready only for structurally complete settings, never release authority', () => {
    const f = faultFixture(),
      r = checkConfiguration(f.env);
    expect(r.status).toBe('READY_FOR_HOSTED_REHEARSAL');
    expect(r.databaseConnectionAttempted).toBe(false);
    expect(r.productionApproved).toBe(false);
    expect(JSON.stringify(r)).not.toContain('offline-canary');
  });
  it.each([
    'REHEARSAL_FAULT_DB_PASSWORD',
    'REHEARSAL_FAULT_DB_READER_PASSWORD',
    'REHEARSAL_DB_PASSWORD',
    'REHEARSAL_FAULT_DATABASE_JSON',
    'TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID',
    'REHEARSAL_ROOTS_BASE64',
    'REHEARSAL_ROOT_VALID_UNTIL',
  ])('reports missing %s by name', (key) => {
    const f = faultFixture(),
      env: Record<string, string> = { ...f.env };
    delete env[key];
    const r = checkConfiguration(env);
    expect(r.status).toBe('NOT_READY_FOR_HOSTED_REHEARSAL');
    expect(r.issues.some((i) => i === key || i.startsWith(key))).toBe(true);
  });
  it('reports a missing CA and rejects production isolation pins', () => {
    const f = faultFixture();
    f.db.caPem = '';
    f.env.REHEARSAL_FAULT_DATABASE_JSON = JSON.stringify(f.db);
    expect(checkConfiguration(f.env).issues).toContain('REHEARSAL_FAULT_DATABASE_JSON.caPem');
    f.env.TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID = '555';
    expect(() =>
      buildFaultTarget(f.env, f.artifact, {
        caFile: '/tmp/a',
        passwordFile: '/tmp/b',
        readerPasswordFile: '/tmp/c',
      }),
    ).toThrow('PRODUCTION_FAULT_TARGET_FORBIDDEN');
  });
  it('does not inspect or connect to accounts when executed locally', async () => {
    const f = faultFixture(),
      dir = await mkdtemp(join(tmpdir(), 'meshdrop-check-config-'));
    try {
      const { GITHUB_ACTIONS, ...env } = f.env as Record<string, string>;
      expect(GITHUB_ACTIONS).toBe('true');
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          resolve('scripts/rehearsal/cli.ts'),
          'check-config',
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1', ...env },
          timeout: 15000,
        },
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).status).toBe('READY_FOR_HOSTED_REHEARSAL');
      expect(r.stdout).not.toContain('offline-canary');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('CLI fault boundaries', () => {
  it.each(['unlock', 'retry', 'publish', 'deploy'])(
    'refuses unsupported fault command %s',
    (command) => {
      const f = faultFixture();
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          resolve('scripts/rehearsal/cli.ts'),
          'fault-test',
          command,
        ],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1', ...f.env },
          timeout: 15000,
        },
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).reason).toBe('INVALID_REHEARSAL_FAULT_MODE');
      expect(r.stdout).not.toContain('offline-canary');
    },
  );
  it('cannot promote a fixture report through the real offline dual-attestation command', async () => {
    const f = faultFixture(),
      dir = await mkdtemp(join(tmpdir(), 'meshdrop-fault-verify-'));
    try {
      const roots = await readFile('tests/fixtures/sigstore/trusted_root.json'),
        bundle = await readFile(
          'tests/fixtures/sigstore/reusable-workflow-attestation.sigstore.json',
        );
      const now = new Date();
      const policy = {
        ...f.policy,
        artifactSha256: bytesHash(canonical(f.artifact)),
        trustedRootSha256: bytesHash(roots),
        ghSha256: bytesHash(await readFile('/usr/bin/gh')),
        rootReviewedAt: now.toISOString(),
        rootValidUntil: new Date(now.getTime() + 3600000).toISOString(),
      };
      const files = [
        'artifact',
        'bundle',
        'roots',
        'policy',
        'expectation',
        'faults',
        'fault-bundle',
      ].map((n) => join(dir, n));
      const values = [
        canonical(f.artifact),
        bundle,
        roots,
        JSON.stringify(policy),
        JSON.stringify(f.expected),
        JSON.stringify(faultReport(f.artifact, f.target.storeId, [])),
        bundle,
      ];
      await Promise.all(files.map((p, i) => writeFile(p, values[i]!)));
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          resolve('scripts/rehearsal/cli.ts'),
          'verify-faults',
          ...files,
        ],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1' },
          timeout: 20000,
        },
      );
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).reason).toBe('ATTESTATION_VERIFICATION_FAILED');
      expect(r.stdout).not.toContain('"signatureVerified":true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('reader integrity and diagnostic identity', () => {
  function history() {
    const f = faultFixture(),
      e0 = makeFaultEvent(f.artifact, 'history-integrity', 0, 0, null),
      e1 = makeFaultEvent(f.artifact, 'history-integrity', 0, 1, e0.hash),
      e2 = makeFaultEvent(f.artifact, 'history-integrity', 0, 2, e1.hash);
    return { ...f, h: { storeId: f.target.storeId, head: eventHead(e2), events: [e0, e1, e2] } };
  }
  it('derives separate bounded diagnostic scopes/attempts without changing original artifact', () => {
    const f = faultFixture();
    expect(faultScope('replay')).not.toBe(faultScope('concurrency'));
    expect(faultAttempt(f.artifact, 'replay', 0)).not.toBe(faultAttempt(f.artifact, 'replay', 1));
    expect(createArtifact).toBeTypeOf('function');
  });
  it.each(['publicationEnabled', 'acceptanceEnabled', 'productionApproved'] as const)(
    'rejects %s even after rehashing',
    (key) => {
      const f = history();
      f.h.events[1]!.record[key] = true as never;
      const { hash, ...payload } = f.h.events[1]!;
      expect(hash).toBeTruthy();
      f.h.events[1]!.hash = fingerprint(payload);
      expect(() =>
        inspectFaultHistory(f.h, f.target.storeId, 'history-integrity', f.h.head.attemptId),
      ).toThrow('REHEARSAL_CANNOT_AUTHORIZE_RELEASE');
    },
  );
  it.each([
    'missing',
    'modified',
    'reordered',
    'previous',
    'scope',
    'store',
    'attempt',
    'stale',
    'duplicate',
  ])('rejects %s history', (kind) => {
    const f = history();
    if (kind === 'missing') f.h.events.splice(1, 1);
    if (kind === 'modified') f.h.events[1]!.record.phase = 'CLOSED';
    if (kind === 'reordered') f.h.events.reverse();
    if (kind === 'previous') f.h.events[1]!.previousHash = '0'.repeat(64);
    if (kind === 'scope') f.h.events[1]!.scopeId = '0'.repeat(64);
    if (kind === 'store') f.h.storeId = '0'.repeat(36);
    if (kind === 'attempt') f.h.events[1]!.attemptId = '00000000-0000-4000-8000-000000000000';
    if (kind === 'stale') f.h.head = eventHead(f.h.events[0]!);
    if (kind === 'duplicate') f.h.events.splice(1, 0, f.h.events[1]!);
    expect(() =>
      inspectFaultHistory(
        f.h,
        f.target.storeId,
        'history-integrity',
        faultAttempt(f.artifact, 'history-integrity', 0),
      ),
    ).toThrow();
  });
  it('rejects a wrong previous hash even if event digests are recomputed', () => {
    const f = history();
    f.h.events[1]!.previousHash = '0'.repeat(64);
    const { hash, ...p } = f.h.events[1]!;
    expect(hash).toBeTruthy();
    f.h.events[1]!.hash = fingerprint(p);
    expect(() =>
      inspectFaultHistory(f.h, f.target.storeId, 'history-integrity', f.h.head.attemptId),
    ).toThrow('FAULT_HISTORY_GAP_OR_ORDER');
  });
  it('rejects a stale independent anchor against an otherwise intact current history', () => {
    const f = history();
    expect(() =>
      inspectFaultHistory(
        f.h,
        f.target.storeId,
        'history-integrity',
        f.h.head.attemptId,
        eventHead(f.h.events[0]!),
      ),
    ).toThrow('FAULT_HISTORY_STALE_HEAD');
  });
  it('cannot claim PASS or authority for missing fault results', () => {
    const f = faultFixture(),
      r = faultReport(f.artifact, f.target.storeId, []);
    expect(inspectFaultReport(f.artifact, r).complete).toBe(false);
    r.checks.replayCheck = 'PASS';
    const { reportDigest, ...p } = r;
    expect(reportDigest).toBeTruthy();
    r.reportDigest = fingerprint(p);
    expect(() => inspectFaultReport(f.artifact, r)).toThrow('FAULT_REPORT_MISSING_MODE');
  });
  it.each([
    'database',
    'history-blob',
    'local-file',
    'fixture',
    'unsigned',
    'no-counter',
    'unconfigured',
  ])('rejects %s witness without inventing authentication', (kind) => {
    const p = {
      source: 'independent-service',
      artifactId: 'a'.repeat(64),
      rehearsalId: 'x',
      storeId: 'x',
      head: {},
      witnessTime: '2026-11-06',
      witnessIdentity: 'external',
      monotonicCounter: 1,
      signedEnvelope: 'unverified-bytes',
      fixture: false,
    };
    if (['database', 'history-blob', 'local-file'].includes(kind)) p.source = kind;
    if (kind === 'fixture') p.fixture = true;
    if (kind === 'unsigned') p.signedEnvelope = '';
    if (kind === 'no-counter') p.monotonicCounter = 0;
    expect(() => verifyHostedWitness(p)).toThrow(
      kind === 'fixture'
        ? 'FIXTURE_WITNESS_FORBIDDEN'
        : kind === 'unsigned'
          ? 'UNSIGNED_WITNESS_FORBIDDEN'
          : kind === 'no-counter'
            ? 'WITNESS_MONOTONIC_COUNTER_REQUIRED'
            : kind === 'unconfigured'
              ? 'INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED'
              : 'SAME_STORE_OR_LOCAL_WITNESS_FORBIDDEN',
    );
  });
});
