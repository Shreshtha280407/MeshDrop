import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  disposeLocalRuntime,
  requireHistoricalExports,
  verifyLocalRollback,
} from '../../scripts/deploy/local-rollback';

describe('local runtime cleanup', () => {
  it('accepts only the original initialization error replay after disposal', async () => {
    const error = new Error('startup failure');
    const dispose = vi.fn().mockRejectedValue(error);
    await expect(disposeLocalRuntime({ dispose }, { error })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('propagates a separate cleanup error even with an identical message', async () => {
    const error = new Error('startup failure');
    const cleanupError = new Error(error.message);
    const dispose = vi.fn().mockRejectedValue(cleanupError);
    await expect(disposeLocalRuntime({ dispose }, { error })).rejects.toBe(cleanupError);
  });
  it('does not ignore an undefined rejection without a recorded initialization failure', async () => {
    const dispose = vi.fn().mockRejectedValue(undefined);
    await expect(disposeLocalRuntime({ dispose })).rejects.toBeUndefined();
  });
});

describe('local historical rollback preflight', () => {
  it('accepts the historical room-only export set', () => {
    expect(() => requireHistoricalExports(['default', 'SessionRoom'])).not.toThrow();
  });
  it('rejects a historical bundle missing the required room class', () => {
    expect(() => requireHistoricalExports(['default', 'OtherRoom'])).toThrow(
      'Historical Worker must export SessionRoom.',
    );
  });
  it.each(['not-a-sha', '0'.repeat(40)])(
    'rejects unavailable baseline %s before runtime or artifacts',
    async (baseline) => {
      const directory = await mkdtemp(join(tmpdir(), 'meshdrop-rollback-preflight-'));
      const runtimeFactory = vi.fn();
      try {
        await expect(
          verifyLocalRollback({ baseline, artifactRoot: directory, runtimeFactory }),
        ).rejects.toThrow(
          baseline.length === 40 ? 'unavailable locally' : 'exact baseline commit SHA',
        );
        expect(runtimeFactory).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
