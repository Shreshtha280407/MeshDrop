import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  receivePolicy,
  LARGE_FILE_WARNING_BYTES,
  UNKNOWN_SPACE_LIMIT_BYTES,
} from '../../packages/platform/src/PlatformPolicy';
import type { CapabilityResult } from '../../packages/platform/src/CapabilityProbe';
import { estimateCapacity } from '../../packages/storage/src/QuotaManager';
const supported: CapabilityResult = {
  secureContext: true,
  webRtc: true,
  opfs: 'available',
  checkpointDb: 'available',
  exclusiveAccess: true,
  savePicker: false,
  filePicker: true,
  persistentStorage: false,
  estimatedFreeBytes: 2 * 1024 ** 3,
  camera: { supported: true, permission: 'prompt' },
  shareFiles: true,
  pwaMode: 'browser',
  serviceWorker: true,
  backgroundRisk: 'foreground-required',
};
afterEach(() => vi.unstubAllGlobals());
describe('measured device policy', () => {
  it.each(['secureContext', 'webRtc', 'exclusiveAccess'] as const)(
    'rejects missing %s without pretending API presence is storage permission',
    (key) => {
      expect(receivePolicy({ ...supported, [key]: false }, 1).allowed).toBe(false);
    },
  );
  it.each(['opfs', 'checkpointDb'] as const)(
    'rejects an unusable %s even when other APIs exist',
    (key) => {
      expect(receivePolicy({ ...supported, [key]: 'unavailable' }, 1).strategy).toBe('unavailable');
    },
  );
  it('caps unknown-quota offers, requires acknowledgement and distinguishes unknown from zero space', () => {
    const unknown = { ...supported, estimatedFreeBytes: null };
    expect(receivePolicy(unknown, UNKNOWN_SPACE_LIMIT_BYTES)).toMatchObject({
      allowed: true,
      requiresAcknowledgement: true,
    });
    expect(receivePolicy(unknown, UNKNOWN_SPACE_LIMIT_BYTES + 1).allowed).toBe(false);
    expect(receivePolicy({ ...supported, estimatedFreeBytes: 0 }, 0).allowed).toBe(false);
  });
  it('reserves quota headroom and warns on large exports without making a universal platform-size claim', () => {
    expect(
      receivePolicy({ ...supported, estimatedFreeBytes: 104 * 1024 ** 2 }, 100 * 1024 ** 2).allowed,
    ).toBe(false);
    expect(receivePolicy(supported, LARGE_FILE_WARNING_BYTES)).toMatchObject({
      allowed: true,
      requiresAcknowledgement: true,
      strategy: 'opfs-checkpoint',
      exportStrategy: 'share-or-download',
    });
    expect(receivePolicy({ ...supported, savePicker: true }, 1).exportStrategy).toBe(
      'picker-or-download',
    );
  });
  it.each([-1, NaN, Infinity, 1.5])('rejects invalid receive size %s', (size) =>
    expect(receivePolicy(supported, size).allowed).toBe(false),
  );
  it('keeps the worker preflight aligned when estimate is absent, malformed, rejected or known-full', async () => {
    const storage: { getDirectory(): void; estimate?: () => Promise<StorageEstimate> } = {
      getDirectory() {},
    };
    vi.stubGlobal('navigator', { storage, locks: {} });
    vi.stubGlobal('indexedDB', {});
    expect((await estimateCapacity(64 * 1024 ** 2)).available).toBe(true);
    expect((await estimateCapacity(64 * 1024 ** 2 + 1)).available).toBe(false);
    storage.estimate = async () => ({ quota: NaN, usage: 0 });
    expect((await estimateCapacity(1)).estimatedFreeBytes).toBeNull();
    storage.estimate = async () => {
      throw new Error('Denied');
    };
    expect((await estimateCapacity(1)).estimatedFreeBytes).toBeNull();
    storage.estimate = async () => ({ quota: 10, usage: 10 });
    expect((await estimateCapacity(1)).available).toBe(false);
  });
});
