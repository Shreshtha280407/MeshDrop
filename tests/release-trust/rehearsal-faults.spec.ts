import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FaultHarness, FaultClient } from '../../scripts/rehearsal/faults';
import {
  FAULT_MODES,
  faultScope,
  faultAttempt,
  makeFaultEvent,
  eventHead,
  inspectFaultHistory,
} from '../../scripts/rehearsal/fault-contract';
import { faultReport, inspectFaultReport } from '../../scripts/rehearsal/fault-report';
import { fingerprint } from '../../scripts/deploy/release-record';
import type { RecoverySql } from '../../scripts/deploy/postgres-connection';
import { faultFixture } from '../fixtures/rehearsal-faults';
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
      'meshdrop_rehearsal_fixture',
      '-f',
      '-',
    ],
    text,
  );
}
function connections(role: 'writer' | 'reader'): RecoverySql {
  return {
    scope: 'offline-fixture',
    execute: (text) => sql(text, role === 'writer' ? 'fault_writer' : 'fault_reader'),
  };
}
function fixture() {
  return faultFixture();
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
      'meshdrop.task10b-fault-fixture=true',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=meshdrop_rehearsal_fixture',
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
  await sql(await readFile('scripts/rehearsal/fault-store.sql', 'utf8'));
  const f = fixture();
  await sql(`INSERT INTO meshdrop_recovery.identity VALUES(true,'${f.target.storeId}');
    INSERT INTO meshdrop_rehearsal.identity VALUES(true,'${f.target.storeId}','fault-test-only','preview','meshdrop_rehearsal_fixture','555','111','222');
    CREATE ROLE fault_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE fault_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT USAGE ON SCHEMA meshdrop_rehearsal TO fault_writer,fault_reader;
    GRANT EXECUTE ON FUNCTION meshdrop_rehearsal.check_store(uuid,text,text,text),meshdrop_rehearsal.read_attempt(uuid,text,text,text,text,uuid) TO fault_writer,fault_reader;
    GRANT EXECUTE ON FUNCTION meshdrop_rehearsal.append_probe(uuid,text,text,text,text,text,jsonb) TO fault_writer;`);
  for (const mode of FAULT_MODES)
    await sql(`INSERT INTO meshdrop_rehearsal.scopes VALUES('${mode}','${faultScope(mode)}');
    INSERT INTO meshdrop_recovery.access VALUES('${faultScope(mode)}','fault_writer',true),('${faultScope(mode)}','fault_reader',false);`);
});
beforeEach(async () => {
  // Reset only this owned, disposable local test database. Runtime has no reset API.
  await sql(
    'TRUNCATE meshdrop_recovery.owners,meshdrop_recovery.attempts,meshdrop_recovery.events,meshdrop_recovery.approvals;',
  );
});
afterAll(async () => {
  try {
    if (container && /^[a-f0-9]{64}$/.test(container))
      await docker(['stop', '--time', '2', container]);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
describe('actual isolated TLS database fault harness', () => {
  it('rejects a forged repository before reserving any ownership', async () => {
    const f = fixture(),
      event = makeFaultEvent(f.artifact, 'replay', 0, 0, null);
    event.record.artifact.repository = 'https://github.com/other/project' as never;
    const { hash, ...body } = event;
    expect(hash).toBeTruthy();
    event.hash = fingerprint(body);
    const reply = await new FaultClient(
      f.target,
      f.artifact,
      connections('writer'),
      'writer',
    ).append(event, null);
    expect(reply).toMatchObject({ outcome: 'REJECTED', code: 'FAULT_INVALID_RECORD' });
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.owners;')).trim()).toBe('0');
  });
  it.each(FAULT_MODES)('executes %s against real independent database processes', async (mode) => {
    const f = fixture(),
      h = new FaultHarness(f.artifact, f.target, connections);
    const r = await h.run(mode);
    expect(r.status).toBe('PASS');
    expect(r.scope).toBe('offline-fixture');
    expect(r.productionApproved).toBe(false);
    expect(r.independentWitnessVerified).toBe(false);
    expect(r.eventCount).toBe(['lost-ack', 'reconnect'].includes(mode) ? 2 : 3);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.owners;')).trim()).toBe('1');
    if (mode === 'concurrency')
      expect(r.checks).toMatchObject({ winnerCount: 1, loserCount: 1, splitBrain: false });
    if (mode === 'lost-ack')
      expect(r.checks).toMatchObject({
        reconciliationRequired: true,
        blindRetryPerformed: false,
        proposedEventCommitted: true,
      });
    if (mode === 'reconnect')
      expect(r.checks).toMatchObject({
        writerProcessExited: true,
        readerUsedCachedState: false,
        automaticResumePerformed: false,
      });
    await expect(h.run(mode)).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe(
      String(r.eventCount),
    );
  });
  it('runs all five namespaces without deleting ownership or weakening evidence binding', async () => {
    const f = fixture(),
      h = new FaultHarness(f.artifact, f.target, connections),
      results = [];
    for (const mode of FAULT_MODES) results.push(await h.run(mode));
    const report = faultReport(f.artifact, f.target.storeId, results);
    expect(inspectFaultReport(f.artifact, report).complete).toBe(true);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.owners;')).trim()).toBe('5');
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('13');
    const bad = structuredClone(report);
    bad.runAttempt++;
    const { reportDigest, ...rest } = bad;
    expect(reportDigest).toBeTruthy();
    bad.reportDigest = fingerprint(rest);
    expect(() => inspectFaultReport(f.artifact, bad)).toThrow('FAULT_REPORT_ARTIFACT_MISMATCH');
  }, 30000);
  it('rejects wrong store marker, wrong environment marker and non-TLS sessions before mutation', async () => {
    const f = fixture();
    await sql("UPDATE meshdrop_rehearsal.identity SET environment_id='999';");
    await expect(
      new FaultHarness(f.artifact, f.target, connections).run('replay'),
    ).rejects.toThrow();
    await sql("UPDATE meshdrop_rehearsal.identity SET environment_id='555';");
    await expect(
      new FaultHarness(
        f.artifact,
        { ...f.target, storeId: '90000000-0000-4000-8000-000000000001' },
        connections,
      ).run('replay'),
    ).rejects.toThrow();
    await expect(
      new FaultHarness(f.artifact, f.target, (role) => ({
        scope: 'offline-fixture',
        execute: (text) => sql(text, role === 'writer' ? 'fault_writer' : 'fault_reader', false),
      })).run('replay'),
    ).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
  });
  it('does not treat a lost connection as a confirmed concurrency loser', async () => {
    const f = fixture();
    let appends = 0;
    const h = new FaultHarness(f.artifact, f.target, (role) => ({
      scope: 'offline-fixture',
      execute: async (text) => {
        if (text.includes('append_probe') && ++appends === 2)
          throw new Error('network unavailable');
        return connections(role).execute(text);
      },
    }));
    await expect(h.run('concurrency')).rejects.toThrow('FAULT_DATABASE_UNAVAILABLE_RECONCILE');
    // First independent client may have committed. Reconcile rather than retry/reset.
  });
  it('never automatically retries an append whose acknowledgement failed after commit', async () => {
    const f = fixture();
    let writes = 0;
    const h = new FaultHarness(f.artifact, f.target, (role) => ({
      scope: 'offline-fixture',
      execute: async (text) => {
        const reply = await connections(role).execute(text);
        if (text.includes('append_probe')) {
          writes++;
          throw new Error('acknowledgement lost');
        }
        return reply;
      },
    }));
    await expect(h.run('replay')).rejects.toThrow('FAULT_DATABASE_UNAVAILABLE_RECONCILE');
    expect(writes).toBe(1);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('1');
  });
  it('does not claim lost-ack success when the proposed SQL never reached the database', async () => {
    const f = fixture();
    let writes = 0;
    const h = new FaultHarness(f.artifact, f.target, (role) => ({
      scope: 'offline-fixture',
      execute: async (text) => {
        if (text.includes('append_probe') && ++writes === 2) throw new Error('failed before SQL');
        return connections(role).execute(text);
      },
    }));
    await expect(h.run('lost-ack')).rejects.toThrow();
    expect(writes).toBe(2);
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('1');
  });
  it('server rejects release flags and duplicate evidence even if the client guard is bypassed', async () => {
    const f = fixture(),
      client = new FaultClient(f.target, f.artifact, connections('writer'), 'writer');
    const first = makeFaultEvent(f.artifact, 'replay', 0, 0, null);
    expect((await client.append(first, null)).outcome).toBe('APPENDED');
    const bad = makeFaultEvent(f.artifact, 'replay', 0, 1, first.hash);
    bad.record.productionApproved = true as never;
    const { hash, ...p } = bad;
    expect(hash).toBeTruthy();
    bad.hash = fingerprint(p);
    expect(await client.append(bad, eventHead(first))).toMatchObject({
      outcome: 'REJECTED',
      code: 'FAULT_INVALID_RECORD',
    });
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('1');
  });
  it('rejects UUID reuse across a second scope and rolls back the rejected reservation', async () => {
    const f = fixture(),
      client = new FaultClient(f.target, f.artifact, connections('writer'), 'writer');
    const first = makeFaultEvent(f.artifact, 'replay', 0, 0, null);
    expect((await client.append(first, null)).outcome).toBe('APPENDED');
    const second = makeFaultEvent(f.artifact, 'history-integrity', 0, 0, null);
    second.attemptId = first.attemptId;
    const { hash, ...p } = second;
    expect(hash).toBeTruthy();
    second.hash = fingerprint(p);
    expect(await client.append(second, null)).toMatchObject({
      outcome: 'REJECTED',
      code: 'DUPLICATE_RECOVERY_IDENTIFIER',
    });
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.owners;')).trim()).toBe('1');
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('1');
  });
  it('refuses a privileged administrator as a runtime identity before writes', async () => {
    const f = fixture(),
      t = { ...f.target, user: 'fixture_admin' };
    const h = new FaultHarness(f.artifact, t, (role) => ({
      scope: 'offline-fixture',
      execute: (text) => sql(text, role === 'writer' ? 'fixture_admin' : 'fault_reader'),
    }));
    await expect(h.run('replay')).rejects.toThrow();
    expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
  });
  it('rejects an accidental schema CREATE grant before writes', async () => {
    const f = fixture();
    await sql('GRANT CREATE ON SCHEMA meshdrop_rehearsal TO fault_writer;');
    try {
      await expect(
        new FaultHarness(f.artifact, f.target, connections).run('replay'),
      ).rejects.toThrow();
      expect((await sql('SELECT count(*) FROM meshdrop_recovery.events;')).trim()).toBe('0');
    } finally {
      await sql('REVOKE CREATE ON SCHEMA meshdrop_rehearsal FROM fault_writer;');
    }
  });
  it('cannot automatically unlock ownership or mutate through the reader role', async () => {
    const f = fixture(),
      r = await new FaultHarness(f.artifact, f.target, connections).run('reconnect');
    await expect(
      sql(
        `DELETE FROM meshdrop_recovery.owners WHERE scope_id='${faultScope('reconnect')}';`,
        'fault_writer',
      ),
    ).rejects.toThrow();
    await expect(sql('TRUNCATE meshdrop_recovery.events;', 'fault_reader')).rejects.toThrow();
    const reader = new FaultClient(f.target, f.artifact, connections('reader'), 'reader');
    const durable = await reader.discover('reconnect', faultAttempt(f.artifact, 'reconnect', 0));
    expect(
      inspectFaultHistory(durable.raw, f.target.storeId, 'reconnect', r.recoveryAttemptId, r.head)
        .events,
    ).toHaveLength(2);
  });
});
