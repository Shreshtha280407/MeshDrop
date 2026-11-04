import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import type { Miniflare, V4WorkerOptions } from 'miniflare';
import { sessionStatusSchema } from '@meshdrop/protocol';
import type { SessionCreated, SessionStatus } from '@meshdrop/protocol';
import {
  API,
  approve,
  capability,
  create,
  join as admit,
  request,
  runtime,
  storage,
} from '../../tests/integration/harness';

export const DEFAULT_ROLLBACK_BASELINE = 'e108e7a1f59bc37f41ba703240e08f176d47b33c';
export const HISTORICAL_ROOM_OBJECTS = {
  SESSION_ROOMS: { className: 'SessionRoom', useSQLite: true },
} satisfies NonNullable<V4WorkerOptions['durableObjects']>;

const TABLES = ['room_meta', 'invites', 'peers', 'ticket_nonces', 'security_windows'] as const;
type RuntimeOptions = NonNullable<Parameters<typeof runtime>[0]>;
type Guest = Awaited<ReturnType<typeof admit>>['guest'];
type Approved = { owner: SessionStatus; receiver: SessionStatus };
type Snapshot = { schema: unknown; rows: unknown[] };
export type LocalRollbackReport = {
  phase: 'P9';
  scope: string;
  baseline: string;
  pass: boolean;
  stages: string[];
  failedStage?: string;
  runtimesStarted: number;
  runtimesDisposed: number;
  cleanup: { runtimesDisposed: boolean; privateFilesRemoved: boolean };
};

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateBaseline(baseline: string): void {
  requireCondition(/^[a-f0-9]{40}$/.test(baseline), 'Use an exact baseline commit SHA.');
  try {
    execFileSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { stdio: 'ignore' });
  } catch {
    throw new Error('Rollback baseline commit is unavailable locally.');
  }
  // Do not silently build historical signaling against changed shared contracts.
  const sharedChanges = execFileSync(
    'git',
    ['diff', baseline, '--', 'packages/protocol', 'packages/shared-types'],
    { encoding: 'utf8' },
  );
  requireCondition(
    !sharedChanges,
    'Historical shared packages differ; a standalone historical dependency build is required.',
  );
}

export function requireHistoricalExports(exports: readonly string[]): void {
  requireCondition(exports.includes('SessionRoom'), 'Historical Worker must export SessionRoom.');
}

export async function disposeLocalRuntime(
  worker: Pick<Miniflare, 'dispose'>,
  initialization?: { error: unknown },
): Promise<void> {
  try {
    await worker.dispose();
  } catch (error) {
    // Pinned Miniflare completes cleanup, prioritizes independent cleanup errors,
    // then rethrows the original ready rejection. Accept only that exact object;
    // the verifier still reports the initialization failure as a failed test.
    if (!initialization || error !== initialization.error) throw error;
  }
}

async function historicalBundle(directory: string, baseline: string): Promise<string> {
  const paths = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', baseline, 'apps/signaling/src'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  requireCondition(
    paths.includes('apps/signaling/src/index.ts'),
    'Historical Worker entry is missing.',
  );
  for (const path of paths) {
    requireCondition(
      /^apps\/signaling\/src\/[A-Za-z0-9_./-]+\.ts$/.test(path) && !path.includes('..'),
      'Unexpected historical source path.',
    );
    const output = join(directory, 'baseline', path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, execFileSync('git', ['show', `${baseline}:${path}`]));
  }
  const result = await build({
    entryPoints: [join(directory, 'baseline/apps/signaling/src/index.ts')],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    nodePaths: [resolve('node_modules')],
    external: ['cloudflare:workers'],
  });
  requireHistoricalExports(
    Object.values(result.metafile.outputs).flatMap((output) => output.exports),
  );
  const script = result.outputFiles[0]?.text;
  requireCondition(script, 'Historical Worker bundle is empty.');
  return script;
}

async function snapshot(worker: Miniflare, roomId: string): Promise<Snapshot> {
  const sql = await storage(worker, roomId);
  const schema = await sql.exec(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(',')}) ORDER BY name`,
    ...TABLES,
  );
  requireCondition(schema.length === TABLES.length, 'Persisted session schema is incomplete.');
  const rows = [];
  for (const table of TABLES) {
    const records = await sql.exec(`SELECT * FROM ${table}`);
    rows.push(records.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return { schema, rows };
}

async function approvedSession(
  worker: Miniflare,
  room: SessionCreated,
  guest: Guest,
  expected?: Approved,
): Promise<Approved> {
  const path = `/v1/sessions/${room.roomId}`;
  async function status(token: string): Promise<SessionStatus> {
    const response = await request(worker, `${path}/status`, { token });
    requireCondition(response.status === 200, 'Authorized persisted session is not readable.');
    const parsed = sessionStatusSchema.safeParse(await response.json());
    requireCondition(parsed.success, 'Persisted session response violates the protocol.');
    return parsed.data;
  }
  const result = {
    owner: await status(room.ownerCapability),
    receiver: await status(guest.peerCapability),
  };
  for (const [role, value, peerId] of [
    ['owner', result.owner, room.peerId],
    ['receiver', result.receiver, guest.peerId],
  ] as const) {
    requireCondition(
      value.roomId === room.roomId &&
        value.peerId === peerId &&
        value.role === role &&
        value.approval === 'approved' &&
        value.state === 'approved' &&
        value.expiresAt === room.expiresAt &&
        value.epoch === room.epoch,
      'Persisted session identity, approval, expiry or epoch changed.',
    );
  }
  requireCondition(
    result.owner.candidatePeerId === guest.peerId,
    'Approved peer membership changed.',
  );
  if (expected)
    requireCondition(isDeepStrictEqual(result, expected), 'Persisted session status changed.');

  requireCondition(
    (await request(worker, `${path}/status`)).status === 401,
    'Missing proof was accepted.',
  );
  for (const token of [capability(), room.inviteCapability]) {
    requireCondition(
      (await request(worker, `${path}/status`, { token })).status === 403,
      'Invalid status authority was accepted.',
    );
    requireCondition(
      (await request(worker, path, { method: 'DELETE', token })).status === 403,
      'Invalid close authority was accepted.',
    );
  }
  requireCondition(
    (await request(worker, path, { method: 'DELETE', token: guest.peerCapability })).status === 403,
    'Receiver closed an owner-controlled room.',
  );
  requireCondition(
    (
      await request(worker, `${path}/decisions`, {
        method: 'POST',
        token: guest.peerCapability,
        body: { candidatePeerId: guest.peerId, decision: 'approve' },
      })
    ).status === 403,
    'Receiver exercised owner-only approval.',
  );
  requireCondition(
    isDeepStrictEqual(await status(room.ownerCapability), result.owner),
    'Unauthorized operations changed the room.',
  );
  return result;
}

export async function verifyLocalRollback(
  options: {
    baseline?: string;
    artifactRoot?: string;
    runtimeFactory?: typeof runtime;
  } = {},
): Promise<LocalRollbackReport> {
  const baseline = options.baseline ?? DEFAULT_ROLLBACK_BASELINE;
  validateBaseline(baseline);
  const root = resolve(options.artifactRoot ?? '.meshdrop-artifacts/phase-9-rollback');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'run-'));
  const persist = join(directory, 'state');
  const factory = options.runtimeFactory ?? runtime;
  const report: LocalRollbackReport = {
    phase: 'P9',
    scope:
      'Local workerd SQLite SessionRoom rollback only; not hosted v2 actor/deployment rollback',
    baseline,
    pass: false,
    stages: [],
    runtimesStarted: 0,
    runtimesDisposed: 0,
    cleanup: { runtimesDisposed: false, privateFilesRemoved: false },
  };
  let active: Miniflare | undefined;
  let initialization: { error: unknown } | undefined;
  let stage = 'historical-build';
  const failures: unknown[] = [];
  async function start(configuration: RuntimeOptions = {}): Promise<Miniflare> {
    if (active) {
      await disposeLocalRuntime(active, initialization);
      report.runtimesDisposed++;
      active = undefined;
    }
    initialization = undefined;
    active = await factory({
      persist,
      // The local proof cannot call a hosted provider, even if source behavior changes.
      outboundService: () =>
        new Response('Outbound network disabled for local rollback.', { status: 503 }),
      ...configuration,
    });
    report.runtimesStarted++;
    try {
      await active.ready;
    } catch (error) {
      initialization = { error };
      throw error;
    }
    const health = await active.dispatchFetch(`${API}/health`);
    requireCondition(health.status === 200, 'Worker liveness failed.');
    return active;
  }
  try {
    const script = await historicalBundle(directory, baseline);
    stage = 'current-start';
    let worker = await start();
    report.stages.push(stage);
    stage = 'session-approved';
    const room = await create(worker);
    const { guest } = await admit(worker, room);
    requireCondition(
      (await approve(worker, room, guest.peerId)).status === 200,
      'Initial approval failed.',
    );
    const expected = await approvedSession(worker, room, guest);
    let previous = await snapshot(worker, room.roomId);
    report.stages.push(stage);

    for (const [name, configuration] of [
      ['historical', { script, durableObjects: HISTORICAL_ROOM_OBJECTS }],
      ['roll-forward', {}],
      ['drain', { bindings: { ADMISSION_PAUSED: 'true' } }],
    ] satisfies [string, RuntimeOptions][]) {
      stage = name;
      worker = await start(configuration);
      requireCondition(
        isDeepStrictEqual(await snapshot(worker, room.roomId), previous),
        'Persisted SQLite rows or schema changed across restart.',
      );
      await approvedSession(worker, room, guest, expected);
      previous = await snapshot(worker, room.roomId);
      if (name === 'drain') {
        requireCondition(
          (await request(worker, '/v1/sessions', { method: 'POST', body: {} })).status === 503,
          'Admission drain accepted a new room.',
        );
        const closed = await request(worker, `/v1/sessions/${room.roomId}`, {
          method: 'DELETE',
          token: room.ownerCapability,
        });
        requireCondition(
          closed.status === 200 && ((await closed.json()) as { state?: string }).state === 'closed',
          'Authorized room closure failed during drain.',
        );
        for (const token of [room.ownerCapability, guest.peerCapability])
          requireCondition(
            (await request(worker, `/v1/sessions/${room.roomId}/status`, { token })).status === 410,
            'Closed room remains active.',
          );
      }
      report.stages.push(stage);
    }
  } catch (error) {
    report.failedStage = stage;
    failures.push(error);
  } finally {
    try {
      if (active) {
        await disposeLocalRuntime(active, initialization);
        report.runtimesDisposed++;
      }
      report.cleanup.runtimesDisposed = report.runtimesStarted === report.runtimesDisposed;
    } catch (error) {
      report.failedStage ??= 'cleanup';
      failures.push(error);
    }
    if (report.cleanup.runtimesDisposed) {
      try {
        // Remove only private resources from this invocation's unique directory.
        await rm(join(directory, 'baseline'), { recursive: true, force: true });
        await rm(persist, { recursive: true, force: true });
        report.cleanup.privateFilesRemoved = true;
        report.stages.push('cleanup');
      } catch (error) {
        report.failedStage ??= 'cleanup';
        failures.push(error);
      }
    }
    report.pass = failures.length === 0 && report.cleanup.privateFilesRemoved;
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failures.length)
    throw new Error(`Local rollback verification failed during ${report.failedStage}.`, {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
    });
  return report;
}
