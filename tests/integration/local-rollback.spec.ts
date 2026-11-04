import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import {
  DEFAULT_ROLLBACK_BASELINE,
  disposeLocalRuntime,
  verifyLocalRollback,
} from '../../scripts/deploy/local-rollback';
import type { LocalRollbackReport } from '../../scripts/deploy/local-rollback';
import { runtime, storage } from './harness';

type RuntimeOptions = NonNullable<Parameters<typeof runtime>[0]>;
describe('real local historical SQLite rollback', () => {
  let directory: string;
  let workers: Miniflare[];
  let addresses: Map<Miniflare, Promise<URL | undefined>>;
  let initializations: Map<Miniflare, Promise<{ error: unknown } | undefined>>;
  let disposals: Map<Miniflare, () => Promise<void>>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'meshdrop-rollback-test-'));
    workers = [];
    addresses = new Map();
    initializations = new Map();
    disposals = new Map();
  });
  afterEach(async () => {
    // Also contain failures in the test itself; verifier disposal is asserted first.
    try {
      await Promise.all(
        workers.map(async (worker) =>
          disposeLocalRuntime(worker, await initializations.get(worker)),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  function factory(
    change: (options: RuntimeOptions, index: number) => RuntimeOptions = (options) => options,
  ) {
    return async (options: RuntimeOptions = {}) => {
      const worker = await runtime(change(options, workers.length));
      workers.push(worker);
      disposals.set(worker, worker.dispose.bind(worker));
      addresses.set(
        worker,
        worker.ready.catch(() => undefined),
      );
      initializations.set(
        worker,
        worker.ready.then(
          () => undefined,
          (error: unknown) => ({ error }),
        ),
      );
      vi.spyOn(worker, 'dispose');
      return worker;
    };
  }
  async function report(privateFilesRemoved = true): Promise<LocalRollbackReport> {
    const runs = (await readdir(directory)).filter((name) => name.startsWith('run-'));
    expect(runs).toHaveLength(1);
    const run = join(directory, runs[0]!);
    expect((await readdir(run)).sort()).toEqual(
      privateFilesRemoved ? ['report.json'] : ['baseline', 'report.json', 'state'],
    );
    return JSON.parse(await readFile(join(run, 'report.json'), 'utf8')) as LocalRollbackReport;
  }
  async function disposed() {
    for (const worker of workers) {
      expect(worker.dispose).toHaveBeenCalledTimes(1);
      const url = await addresses.get(worker);
      if (url)
        await expect(
          fetch(new URL('/health', url), { signal: AbortSignal.timeout(1000) }),
        ).rejects.toThrow();
    }
  }
  it('preserves actual rows, schema, approval and authority through P8 and back, then drains and closes', async () => {
    await writeFile(join(directory, 'unrelated.txt'), 'preserve this artifact');
    const result = await verifyLocalRollback({
      artifactRoot: directory,
      runtimeFactory: factory(),
    });
    expect(result).toMatchObject({
      baseline: DEFAULT_ROLLBACK_BASELINE,
      pass: true,
      stages: [
        'current-start',
        'session-approved',
        'historical',
        'roll-forward',
        'drain',
        'cleanup',
      ],
      runtimesStarted: 4,
      runtimesDisposed: 4,
      cleanup: { runtimesDisposed: true, privateFilesRemoved: true },
    });
    expect(await report()).toEqual(result);
    expect(await readFile(join(directory, 'unrelated.txt'), 'utf8')).toBe('preserve this artifact');
    await disposed();
  });
  it('fails and disposes the historical runtime when latest-only actor bindings are supplied', async () => {
    const runtimeFactory = factory((options) => {
      if (!options.script) return options;
      const incompatible = { ...options };
      delete incompatible.durableObjects;
      return incompatible;
    });
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during historical',
    );
    expect(await report()).toMatchObject({
      pass: false,
      failedStage: 'historical',
      runtimesStarted: 2,
      runtimesDisposed: 2,
    });
    await disposed();
  });
  it('detects a fresh or mismatched persistence directory instead of claiming rollback success', async () => {
    const runtimeFactory = factory((options) =>
      options.script ? { ...options, persist: join(options.persist!, 'wrong-namespace') } : options,
    );
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during historical',
    );
    expect(await report()).toMatchObject({
      pass: false,
      failedStage: 'historical',
      cleanup: { runtimesDisposed: true, privateFilesRemoved: true },
    });
    await disposed();
  });
  it('detects changed persisted approval on roll-forward and cleans up after the failed assertion', async () => {
    const createRuntime = factory();
    let roomId: string | undefined;
    const runtimeFactory: typeof runtime = async (options = {}) => {
      const index = workers.length;
      const worker = await createRuntime(options);
      if (index === 0) {
        const dispatch = worker.dispatchFetch.bind(worker);
        vi.spyOn(worker, 'dispatchFetch').mockImplementation(async (...args) => {
          const response = await dispatch(...args);
          if (response.status === 201)
            roomId = ((await response.clone().json()) as { roomId: string }).roomId;
          return response;
        });
      }
      if (index === 2) {
        try {
          expect(roomId).toBeDefined();
          const sql = await storage(worker, roomId!);
          await sql.exec("UPDATE room_meta SET state = 'pending'");
        } catch (error) {
          await worker.dispose();
          throw error;
        }
      }
      return worker;
    };
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during roll-forward',
    );
    expect(await report()).toMatchObject({ pass: false, failedStage: 'roll-forward' });
    await disposed();
  });
  it('fails if the paused current runtime admits a new room', async () => {
    const runtimeFactory = factory((options) =>
      options.bindings?.ADMISSION_PAUSED === 'true'
        ? { ...options, bindings: { ...options.bindings, ADMISSION_PAUSED: 'false' } }
        : options,
    );
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during drain',
    );
    expect(await report()).toMatchObject({
      pass: false,
      failedStage: 'drain',
      runtimesStarted: 4,
      runtimesDisposed: 4,
    });
    await disposed();
  });
  it('disposes a runtime whose initialization fails and does not emit a successful report', async () => {
    const runtimeFactory = factory((options) => ({
      ...options,
      script: 'export default { fetch() { return new Response("invalid fixture"); } };',
    }));
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during current-start',
    );
    expect(await report()).toMatchObject({
      pass: false,
      failedStage: 'current-start',
      runtimesStarted: 1,
      runtimesDisposed: 1,
    });
    await disposed();
  });
  it('reports independent disposal failure and preserves state instead of declaring cleanup successful', async () => {
    const createRuntime = factory();
    const runtimeFactory: typeof runtime = async (options = {}) => {
      const index = workers.length;
      const worker = await createRuntime(options);
      if (index === 3) {
        const dispose = disposals.get(worker)!;
        vi.mocked(worker.dispose).mockImplementationOnce(async () => {
          await dispose();
          throw new Error('sensitive-cleanup-canary');
        });
      }
      return worker;
    };
    await expect(verifyLocalRollback({ artifactRoot: directory, runtimeFactory })).rejects.toThrow(
      'during cleanup',
    );
    const result = await report(false);
    expect(result).toMatchObject({
      pass: false,
      failedStage: 'cleanup',
      cleanup: { runtimesDisposed: false, privateFilesRemoved: false },
    });
    expect(JSON.stringify(result)).not.toContain('sensitive-cleanup-canary');
    await disposed();
  });
});
