import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { compactRanges } from '../../packages/storage/src/LedgerReconciler';
import { retentionExpiry } from '../../packages/storage/src/ReceiverStore';
import { verifyReselectedSource } from '../../packages/storage/src/integrity';
import { estimateCapacity, requestPersistence } from '../../packages/storage/src/QuotaManager';
afterEach(() => vi.unstubAllGlobals());
it('compacts verified indices without filling holes or double-counting duplicates', () => {
  expect(compactRanges([4, 1, 1, 0, 7, 6, 5])).toEqual([
    [0, 1],
    [4, 7],
  ]);
  expect(compactRanges([])).toEqual([]);
});
it('sets explicit bounded retention deadlines', () => {
  expect(retentionExpiry('24-hours', 1000)).toBe(86401000);
  expect(retentionExpiry('7-days', 1000)).toBe(604801000);
  expect(retentionExpiry('discard', 1000)).toBe(3601000);
});
it('reselection checks full bytes rather than only a matching name and size', async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const expected = {
    fileId: crypto.randomUUID(),
    path: 'folder/source.bin',
    size: 3,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await expect(verifyReselectedSource(new File([bytes], 'source.bin'), expected)).resolves.toBe(
    expected.sha256,
  );
  await expect(
    verifyReselectedSource(new File([new Uint8Array([7, 8, 0])], 'source.bin'), expected),
  ).rejects.toThrow('SHA-256');
  await expect(verifyReselectedSource(new File([bytes], 'other.bin'), expected)).rejects.toThrow(
    'name or size',
  );
});
it('preflight rejects insufficient space and reports eviction/persistence limitations', async () => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('navigator', {
    locks: {},
    storage: {
      getDirectory: () => {},
      estimate: async () => ({ quota: 10 * 1024 ** 2, usage: 8 * 1024 ** 2 }),
      persisted: async () => false,
    },
  });
  const result = await estimateCapacity(1024 ** 2);
  expect(result.available).toBe(false);
  expect(result.estimatedFreeBytes).toBe(2 * 1024 ** 2);
  expect(result.warnings.join(' ')).toContain('evicted');
});
it('unknown quota is a warning rather than an invented capacity guarantee', async () => {
  vi.stubGlobal('indexedDB', {});
  vi.stubGlobal('navigator', {
    locks: {},
    storage: {
      getDirectory: () => {},
      estimate: async () => ({}),
      persisted: async () => false,
      persist: async () => false,
    },
  });
  const result = await estimateCapacity(300 * 1024 ** 2);
  expect(result.available).toBe(true);
  expect(result.estimatedFreeBytes).toBeNull();
  expect(result.warnings).toHaveLength(3);
  expect(await requestPersistence()).toBe(false);
});
