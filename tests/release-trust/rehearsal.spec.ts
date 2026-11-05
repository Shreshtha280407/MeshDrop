import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, fingerprint } from '../../scripts/deploy/release-record';
import { createArtifact, rehearsalScope } from '../../scripts/rehearsal/contract';
import { inspectHistory, RehearsalJournal } from '../../scripts/rehearsal/recovery';
import type { RehearsalHead } from '../../scripts/rehearsal/recovery';
import type { RecoverySql } from '../../scripts/deploy/postgres-connection';
import { rehearsalFixture } from '../fixtures/rehearsal';

const IMAGE = 'postgres@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab';
let directory: string | undefined, container: string | undefined;
function exec(binary: string, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: 20000, maxBuffer: 1048576, env: { PATH: process.env.PATH! } },
      (error, out, stderr) =>
        error
          ? reject(new Error('Isolated TLS fixture operation failed: ' + stderr.slice(-700)))
          : resolve(out),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
function docker(args: string[], input?: string) {
  if (!directory) throw new Error('No owned configuration.');
  return exec(
    'docker',
    ['--config', directory, '--host', 'unix:///var/run/docker.sock', ...args],
    input,
  );
}
function sql(
  text: string,
  role = 'fixture_admin',
  tls = true,
  host = 'localhost',
  ca = '/tmp/server.crt',
) {
  if (!container) throw new Error('No owned PostgreSQL fixture.');
  return docker(
    [
      'exec',
      '-i',
      '--env',
      `PGSSLMODE=${tls ? 'verify-full' : 'disable'}`,
      '--env',
      `PGSSLROOTCERT=${ca}`,
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      host,
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
function connection(tls = true): RecoverySql {
  return { scope: 'offline-fixture', execute: (text) => sql(text, 'fixture_rehearsal', tls) };
}
function fixture() {
  const f = rehearsalFixture();
  f.config.user = 'fixture_rehearsal';
  f.config.caFile = '/tmp/server.crt';
  return f;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meshdrop-rehearsal-tls-'));
  const crt = join(directory, 'server.crt'),
    key = join(directory, 'server.key');
  // Standard TLS test key only. Never a GitHub signer or production credential.
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-keyout',
    key,
    '-out',
    crt,
  ]);
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
      'meshdrop.task09-fixture=true',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=meshdrop_release_fixture',
      '-e',
      'POSTGRES_USER=fixture_admin',
      IMAGE,
    ])
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('Invalid container ownership.');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      await sql('SELECT 1;', 'fixture_admin', false);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('Test database unavailable.');
  await docker(['exec', '-i', container, 'tee', '/tmp/server.crt'], await readFile(crt, 'utf8'));
  await docker(['exec', '-i', container, 'tee', '/tmp/server.key'], await readFile(key, 'utf8'));
  await docker([
    'exec',
    '--user',
    '0',
    container,
    'chown',
    'postgres:postgres',
    '/tmp/server.crt',
    '/tmp/server.key',
  ]);
  await docker(['exec', '--user', '0', container, 'chmod', '600', '/tmp/server.key']);
  await sql(
    "ALTER SYSTEM SET ssl='on'; ALTER SYSTEM SET ssl_cert_file='/tmp/server.crt'; ALTER SYSTEM SET ssl_key_file='/tmp/server.key'; SELECT pg_reload_conf();",
    'fixture_admin',
    false,
  );
  ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await sql('SELECT 1;');
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!ready) throw new Error('TLS test database unavailable.');
  await sql(await readFile('scripts/deploy/recovery-postgres.sql', 'utf8'));
  await sql(`INSERT INTO meshdrop_recovery.identity VALUES(true,'${fixture().config.storeId}');
    CREATE ROLE fixture_rehearsal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA meshdrop_recovery TO fixture_rehearsal;
    GRANT EXECUTE ON FUNCTION meshdrop_recovery.append_event(uuid,text,text,jsonb),meshdrop_recovery.read_history(uuid,text,uuid) TO fixture_rehearsal;`);
});
beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No hosted service calls.'));
  await sql(`TRUNCATE meshdrop_recovery.owners,meshdrop_recovery.attempts,meshdrop_recovery.events,meshdrop_recovery.approvals,meshdrop_recovery.access;
 INSERT INTO meshdrop_recovery.access VALUES('${rehearsalScope(fixture().artifact)}','fixture_rehearsal',true);`);
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
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
describe('actual TLS PostgreSQL rehearsal only', () => {
  it('reserves, appends, closes and rereads a real encrypted local session without hosted promotion', async () => {
    const f = fixture(),
      journal = new RehearsalJournal(f.artifact, f.config, connection());
    const result = await journal.run();
    expect(result).toMatchObject({
      scope: 'offline-fixture',
      eventCount: 3,
      tlsValidated: true,
      authorizationVerified: false,
      independentWitnessVerified: false,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
      replayCheck: 'NOT_RUN',
      concurrencyCheck: 'NOT_RUN',
    });
    expect(result.events.every((e) => e.approval === null && e.record.state === 'PREPARED')).toBe(
      true,
    );
    expect(canonical(result)).not.toMatch(/password|Bearer|fixture_rehearsal|server.key/);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.owners;')).trim()).toBe('1');
    expect(
      (await new RehearsalJournal(f.artifact, f.config, connection()).read(result.head)).complete,
    ).toBe(true);
  });
  it('cannot reserve or unlock a release scope', async () => {
    const f = fixture(),
      releaseScope = fingerprint({
        repository: f.artifact.repository,
        environment: f.artifact.environment,
      });
    await sql(
      `INSERT INTO meshdrop_recovery.owners VALUES('${releaseScope}','90000000-0000-4000-8000-000000000001');`,
    );
    await new RehearsalJournal(f.artifact, f.config, connection()).run();
    expect(
      (
        await sql(
          `SELECT attempt_id FROM meshdrop_recovery.owners WHERE scope_id='${releaseScope}';`,
        )
      ).trim(),
    ).toBe('90000000-0000-4000-8000-000000000001');
    await expect(
      sql('DELETE FROM meshdrop_recovery.owners;', 'fixture_rehearsal'),
    ).rejects.toThrow();
  });
  it('rejects plaintext TLS downgrade before any reservation', async () => {
    const f = fixture();
    await expect(
      new RehearsalJournal(f.artifact, f.config, connection(false)).run(),
    ).rejects.toThrow('REHEARSAL_DATABASE_FAILED_RECONCILE');
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
  });
  it('rejects a certificate hostname mismatch before any event', async () => {
    const f = fixture();
    const transport: RecoverySql = {
      scope: 'offline-fixture',
      execute: (text) => sql(text, 'fixture_rehearsal', true, '127.0.0.1'),
    };
    await expect(new RehearsalJournal(f.artifact, f.config, transport).run()).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
  });
  it('rejects unavailable TLS CA material', async () => {
    const f = fixture();
    const transport: RecoverySql = {
      scope: 'offline-fixture',
      execute: (text) => sql(text, 'fixture_rehearsal', true, 'localhost', '/tmp/no-ca.pem'),
    };
    await expect(new RehearsalJournal(f.artifact, f.config, transport).run()).rejects.toThrow();
  });
  it('rejects the wrong database identity and store UUID', async () => {
    const f = fixture();
    await expect(
      new RehearsalJournal(
        f.artifact,
        { ...f.config, database: 'another_database' },
        connection(),
      ).run(),
    ).rejects.toThrow();
    await expect(
      new RehearsalJournal(
        f.artifact,
        { ...f.config, storeId: '70000000-0000-4000-8000-000000000001' },
        connection(),
      ).run(),
    ).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
  });
  it('allows only one concurrent attempt and rejects a duplicate UUID without removing ownership', async () => {
    const f = fixture();
    const { artifactId, createdAt, rehearsalId, ...rest } = f.artifact;
    expect(artifactId).toBeTruthy();
    expect(rehearsalId).toBeTruthy();
    const other = createArtifact(
      {
        repositoryId: rest.repositoryId,
        ownerId: rest.ownerId,
        environment: rest.environment,
        sourceCommit: rest.sourceCommit,
        sourceRef: rest.sourceRef,
        runId: rest.runId,
        runAttempt: 2,
        preparedManifestSha256: null,
      },
      createdAt,
      '50000000-0000-4000-8000-000000000002',
    );
    const results = await Promise.allSettled([
      new RehearsalJournal(f.artifact, f.config, connection()).run(),
      new RehearsalJournal(
        other,
        { ...f.config, attemptId: other.rehearsalId },
        connection(),
      ).run(),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const success = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<RehearsalJournal['run']>>
    >;
    const a = success.value.rehearsalId === f.artifact.rehearsalId ? f.artifact : other;
    await expect(
      new RehearsalJournal(a, { ...f.config, attemptId: a.rehearsalId }, connection()).run(),
    ).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('3');
  });
  it('retains an interrupted writer and lost acknowledgement without automatic retry', async () => {
    const f = fixture(),
      real = connection();
    let anchor: RehearsalHead | undefined;
    const transport: RecoverySql = {
      scope: 'offline-fixture',
      execute: async (text) => {
        const reply = await real.execute(text);
        const data = JSON.parse(reply);
        if (data.head.sequence === 1) {
          anchor = data.head;
          throw new Error('Lost acknowledgement.');
        }
        return reply;
      },
    };
    await expect(new RehearsalJournal(f.artifact, f.config, transport).run()).rejects.toThrow(
      'REHEARSAL_DATABASE_FAILED_RECONCILE',
    );
    expect(anchor).toBeDefined();
    const recovered = await new RehearsalJournal(f.artifact, f.config, connection()).read(anchor!);
    expect(recovered).toMatchObject({
      complete: false,
      independentWitnessVerified: false,
      publicationEnabled: false,
    });
    expect(recovered.events).toHaveLength(2);
  });
  it.each(['missing', 'modified', 'stale', 'replayed'] as const)(
    'rejects %s history/evidence against the saved head',
    async (kind) => {
      const f = fixture(),
        journal = new RehearsalJournal(f.artifact, f.config, connection()),
        result = await journal.run();
      if (kind === 'missing') await sql('DELETE FROM meshdrop_recovery.events WHERE sequence=1;');
      if (kind === 'modified')
        await sql(
          "UPDATE meshdrop_recovery.events SET payload=jsonb_set(payload::jsonb,'{record,publicationEnabled}','true')::text WHERE sequence=1;",
        );
      if (kind === 'stale') {
        await sql('DELETE FROM meshdrop_recovery.events WHERE sequence=2;');
        await sql(
          `UPDATE meshdrop_recovery.attempts SET sequence=1,hash='${result.events[1]!.hash}';`,
        );
      }
      if (kind === 'replayed') {
        const changed = structuredClone(result.events);
        changed[2]!.record.phase = 'EVIDENCE';
        changed[2]!.record.evidenceId = f.artifact.rehearsalId;
        const { hash, ...payload } = changed[2]!;
        expect(hash).toBeTruthy();
        changed[2]!.hash = fingerprint(payload);
        expect(() =>
          inspectHistory(f.artifact, changed, { ...result.head, hash: changed[2]!.hash }),
        ).toThrow('INVALID_REHEARSAL_RECORD_OR_REPLAY');
        return;
      }
      await expect(journal.read(result.head)).rejects.toThrow();
    },
  );
});
