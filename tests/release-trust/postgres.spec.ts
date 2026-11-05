import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostgresRecoveryStore,
  PsqlRecoveryConnection,
} from '../../scripts/deploy/postgres-recovery';
import type { RecoverySql } from '../../scripts/deploy/postgres-recovery';
import { RecoveryLog, recoveryScope } from '../../scripts/deploy/recovery-evidence';
import type { RecoveryEvent, RecoveryHead } from '../../scripts/deploy/recovery-evidence';
import { canonical, fingerprint, initialRecord } from '../../scripts/deploy/release-record';
import type { ReleaseRecord } from '../../scripts/deploy/release-record';
import { checkApproval } from '../../scripts/deploy/release-approval';
import { controlsFixture } from '../fixtures/release-controls';
import { manifestFixture } from '../fixtures/release-record';

const IMAGE = 'postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab';
const STORE = '60000000-0000-4000-8000-000000000001';
let container: string | undefined;
let dockerConfig: string | undefined;
function docker(args: string[], input?: string) {
  const isolatedConfig = dockerConfig;
  if (!isolatedConfig) throw new Error('No isolated Docker configuration.');
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'docker',
      ['--config', isolatedConfig, '--host', 'unix:///var/run/docker.sock', ...args],
      { timeout: 20000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '' } },
      (error, out) =>
        error ? reject(new Error('Isolated PostgreSQL fixture operation failed.')) : resolve(out),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
async function sql(text: string, role = 'fixture_admin') {
  if (!container) throw new Error('No owned test container.');
  return docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      role,
      '-d',
      'meshdrop_release_fixture',
      '-f',
      '-',
    ],
    text,
  );
}
function connection(role = 'fixture_writer'): RecoverySql {
  return { scope: 'offline-fixture', execute: (text) => sql(text, role) };
}
function event(
  f: Awaited<ReturnType<typeof controlsFixture>>,
  previous: RecoveryHead,
  record: ReleaseRecord,
  approval: RecoveryEvent['approval'] = null,
): RecoveryEvent {
  const payload = {
    schemaVersion: 1 as const,
    scopeId: previous.scopeId,
    attemptId: previous.attemptId,
    manifestId: f.manifest.id,
    environment: f.manifest.environment,
    sourceCommit: f.manifest.sourceCommit,
    sequence: previous.sequence + 1,
    previousHash: previous.hash,
    kind: approval ? ('APPROVAL_CHECKED' as const) : ('CHECKPOINT' as const),
    record,
    approval,
  };
  return { ...payload, hash: fingerprint(payload) };
}
async function setup() {
  const f = await controlsFixture();
  const database = new PostgresRecoveryStore(f.manifest, STORE, connection());
  const log = new RecoveryLog(database, f.manifest, f.context.attemptId);
  await log.checkpoint(f.record);
  return { ...f, database, log };
}
beforeAll(async () => {
  dockerConfig = await mkdtemp(join(tmpdir(), 'meshdrop-postgres-client-'));
  // Never pull an image, use a Docker context, mount user files or publish ports.
  await docker(['image', 'inspect', IMAGE]);
  container = (
    await docker([
      'run',
      '--pull',
      'never',
      '--rm',
      '-d',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/var/lib/postgresql/data:rw',
      '--tmpfs',
      '/var/run/postgresql:rw',
      '--tmpfs',
      '/tmp:rw',
      '--label',
      'meshdrop.task08-fixture=true',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=meshdrop_release_fixture',
      '-e',
      'POSTGRES_USER=fixture_admin',
      IMAGE,
    ])
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid fixture ownership.');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await sql('SELECT 1;');
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not initialize.');
  await sql(await readFile('scripts/deploy/recovery-postgres.sql', 'utf8'));
  await sql(`INSERT INTO meshdrop_recovery.identity VALUES(true,'${STORE}');
    CREATE ROLE fixture_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE fixture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA meshdrop_recovery TO fixture_writer,fixture_reader;
    GRANT EXECUTE ON FUNCTION meshdrop_recovery.append_event(uuid,text,text,jsonb) TO fixture_writer;
    GRANT EXECUTE ON FUNCTION meshdrop_recovery.read_history(uuid,text,uuid) TO fixture_writer,fixture_reader;`);
});
beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external service access.'));
  await sql(`TRUNCATE meshdrop_recovery.owners,meshdrop_recovery.attempts,meshdrop_recovery.events,meshdrop_recovery.approvals,meshdrop_recovery.access;
    INSERT INTO meshdrop_recovery.access VALUES('${recoveryScope(manifestFixture())}','fixture_writer',true),('${recoveryScope(manifestFixture())}','fixture_reader',false);`);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => {
  try {
    if (container && /^[a-f0-9]{64}$/.test(container))
      await docker(['stop', '--time', '2', container]);
  } finally {
    if (dockerConfig) await rm(dockerConfig, { recursive: true, force: true });
  }
});

describe('actual isolated PostgreSQL transactions and privileges', () => {
  it('persists complete history across independent client processes without claiming hosted durability', async () => {
    const f = await setup();
    const check = await checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context);
    await f.log.consume(check);
    const reopened = new PostgresRecoveryStore(f.manifest, STORE, connection());
    const snapshot = await reopened.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[1]!.approval?.digest).toBe(fingerprint(f.claim));
    expect(
      await RecoveryLog.recover(reopened, f.manifest, f.context.attemptId, snapshot.head),
    ).toMatchObject({
      authenticated: false,
      offRunDurable: false,
      productionApproved: false,
      publicationEnabled: false,
    });
    expect(reopened.scope).toBe('offline-fixture');
  });
  it('permits only one genuinely concurrent environment reservation', async () => {
    const f = await controlsFixture();
    const a = new RecoveryLog(
      new PostgresRecoveryStore(f.manifest, STORE, connection()),
      f.manifest,
      randomUUID(),
    );
    const b = new RecoveryLog(
      new PostgresRecoveryStore(f.manifest, STORE, connection()),
      f.manifest,
      randomUUID(),
    );
    const results = await Promise.allSettled([a.checkpoint(f.record), b.checkpoint(f.record)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('1');
  });
  it('atomically rejects conflicting concurrent heads without partial inserts', async () => {
    const f = await setup(),
      head = (await f.database.read(recoveryScope(f.manifest), f.context.attemptId)).head;
    const next = event(f, head, {
      ...f.record,
      state: 'INCOMPLETE',
      phase: 'preflight',
      sequence: 1,
    });
    const b = new PostgresRecoveryStore(f.manifest, STORE, connection());
    const results = await Promise.allSettled([f.database.append(next, head), b.append(next, head)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await b.read(head.scopeId, head.attemptId)).events).toHaveLength(2);
  });
  it('keeps approval consumption unique across new clients and workflow attempts', async () => {
    const f = await setup();
    await f.log.consume(
      await checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context),
    );
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    const duplicate = event(f, snapshot.head, f.record, snapshot.events[1]!.approval);
    const reopened = new PostgresRecoveryStore(f.manifest, STORE, connection());
    await expect(reopened.append(duplicate, snapshot.head)).rejects.toThrow();
    await expect(
      new RecoveryLog(reopened, f.manifest, randomUUID()).checkpoint(f.record),
    ).rejects.toThrow();
    expect((await reopened.read(snapshot.head.scopeId, snapshot.head.attemptId)).head).toEqual(
      snapshot.head,
    );
  });
  it('rejects competing manifests and unauthorized environment scopes', async () => {
    const f = await setup(),
      other = manifestFixture({ preparedAt: '2026-11-05T00:00:01.000Z' });
    await expect(
      new RecoveryLog(
        new PostgresRecoveryStore(other, STORE, connection()),
        other,
        randomUUID(),
      ).checkpoint(initialRecord(other)),
    ).rejects.toThrow();
    const production = manifestFixture({
      environment: 'production',
      worker: 'meshdrop-fixture-production-signaling',
      project: 'meshdrop-fixture-production',
    });
    await expect(
      new RecoveryLog(
        new PostgresRecoveryStore(production, STORE, connection()),
        production,
        randomUUID(),
      ).checkpoint(initialRecord(production)),
    ).rejects.toThrow();
    await expect(f.database.read(recoveryScope(production), f.context.attemptId)).rejects.toThrow(
      'RECOVERY_SCOPE_MISMATCH',
    );
  });
  it('retains previous attempts and the replay ledger after a separately authorized ownership handoff', async () => {
    const f = await setup();
    await f.log.consume(
      await checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context),
    );
    const prior = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    // Test administrator only. No production unlock/handoff command is shipped.
    await sql('DELETE FROM meshdrop_recovery.owners;');
    const next = await controlsFixture();
    next.context.manifest = manifestFixture({ preparedAt: '2026-11-05T00:00:01.000Z' });
    next.context.record = initialRecord(next.context.manifest);
    next.context.runAttempt = 2;
    Object.assign(next.claim, {
      approvalId: f.claim.approvalId,
      manifestId: next.context.manifest.id,
      recordSha256: fingerprint(next.context.record),
      runAttempt: 2,
    });
    const database = new PostgresRecoveryStore(next.context.manifest, STORE, connection());
    const log = new RecoveryLog(database, next.context.manifest, next.context.attemptId);
    await log.checkpoint(next.context.record);
    await expect(
      log.consume(
        await checkApproval(
          next.claim,
          next.authority.bundle(next.claim),
          next.authority,
          next.context,
        ),
      ),
    ).rejects.toThrow('RECOVERY_APPEND_FAILED_RECONCILE');
    expect(await f.database.read(recoveryScope(f.manifest), f.context.attemptId)).toEqual(prior);
    await expect(
      f.database.append(
        event(f, prior.head, { ...f.record, state: 'INCOMPLETE', phase: 'preflight', sequence: 1 }),
        prior.head,
      ),
    ).rejects.toThrow();
  });
  it('rejects a wrong or unavailable pinned store', async () => {
    const f = await setup();
    await expect(
      new PostgresRecoveryStore(
        f.manifest,
        '70000000-0000-4000-8000-000000000001',
        connection(),
      ).read(recoveryScope(f.manifest), f.context.attemptId),
    ).rejects.toThrow();
    const broken: RecoverySql = {
      scope: 'external-authenticated',
      execute: async () => {
        throw new Error('private-database-canary');
      },
    };
    await expect(
      new PostgresRecoveryStore(f.manifest, STORE, broken).read(
        recoveryScope(f.manifest),
        f.context.attemptId,
      ),
    ).rejects.toThrow(/^RECOVERY_DATABASE_UNAVAILABLE_OR_CONFLICT$/);
  });
  it('retains committed intent after a lost acknowledgement without retrying it', async () => {
    const f = await controlsFixture(),
      live = connection();
    const uncertain: RecoverySql = {
      scope: 'offline-fixture',
      execute: async (text) => {
        const reply = await live.execute(text);
        if (JSON.parse(reply).head.sequence === 3) throw new Error('Lost acknowledgement.');
        return reply;
      },
    };
    const database = new PostgresRecoveryStore(f.manifest, STORE, uncertain),
      log = new RecoveryLog(database, f.manifest, f.context.attemptId);
    await log.checkpoint(f.record);
    await log.consume(
      await checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context),
    );
    const preflight: ReleaseRecord = {
      ...f.record,
      phase: 'preflight',
      state: 'INCOMPLETE',
      sequence: 1,
    };
    await log.checkpoint(preflight);
    await expect(
      log.checkpoint({ ...preflight, phase: 'worker-intent', sequence: 2 }),
    ).rejects.toThrow('RECOVERY_APPEND_FAILED_RECONCILE');
    const reopened = new PostgresRecoveryStore(f.manifest, STORE, connection());
    const snapshot = await reopened.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(snapshot.events.at(-1)!.record.phase).toBe('worker-intent');
    expect(
      (await RecoveryLog.recover(reopened, f.manifest, f.context.attemptId, snapshot.head))
        .publicationEnabled,
    ).toBe(false);
  });
  it('rejects missing recovery history and denied reader access', async () => {
    const f = await setup();
    await expect(f.database.read(recoveryScope(f.manifest), randomUUID())).rejects.toThrow();
    const readOnly = new PostgresRecoveryStore(f.manifest, STORE, connection('fixture_reader'));
    expect(
      (await readOnly.read(recoveryScope(f.manifest), f.context.attemptId)).events,
    ).toHaveLength(1);
    await expect(
      new RecoveryLog(readOnly, f.manifest, randomUUID()).checkpoint(f.record),
    ).rejects.toThrow();
  });
  it.each([
    "UPDATE meshdrop_recovery.events SET payload='{}';",
    'DELETE FROM meshdrop_recovery.events;',
    'TRUNCATE meshdrop_recovery.events;',
    'DROP TABLE meshdrop_recovery.events;',
    'UPDATE meshdrop_recovery.identity SET store_id=gen_random_uuid();',
  ])('denies writer mutation outside the append function: %s', async (statement) => {
    await setup();
    await expect(sql(statement, 'fixture_writer')).rejects.toThrow();
  });
  it('detects administrator-tampered history instead of trusting database labels', async () => {
    const f = await setup();
    await sql(
      `UPDATE meshdrop_recovery.events SET payload=jsonb_set(payload::jsonb,'{record,sequence}','99')::text;`,
    );
    await expect(f.database.read(recoveryScope(f.manifest), f.context.attemptId)).rejects.toThrow();
  });
  it('detects missing events and stale/deleted checkpoints against an independent expected head', async () => {
    const f = await setup();
    await f.log.consume(
      await checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context),
    );
    const latest = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    await sql(`DELETE FROM meshdrop_recovery.events WHERE sequence=1;`);
    await expect(f.database.read(recoveryScope(f.manifest), f.context.attemptId)).rejects.toThrow();
    const initial = latest.events[0]!;
    await sql(`UPDATE meshdrop_recovery.attempts SET sequence=0,hash='${initial.hash}';`);
    await expect(
      RecoveryLog.recover(f.database, f.manifest, f.context.attemptId, latest.head),
    ).rejects.toThrow('RECOVERY_HEAD_MISMATCH');
  });
  it('requires explicit TLS/configuration and never falls back to local credentials', () => {
    expect(() => new PsqlRecoveryConnection({} as never)).toThrow(
      'EXPLICIT_POSTGRES_CONFIGURATION_REQUIRED',
    );
  });
  it('emits only metadata in a canonical, inspectable event', async () => {
    const f = await setup(),
      snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(canonical(snapshot.events)).not.toMatch(
      /private-database-canary|Bearer|password|apiToken/,
    );
  });
});
