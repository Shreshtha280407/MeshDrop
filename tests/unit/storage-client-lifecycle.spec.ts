import { afterEach, expect, it, vi } from 'vitest';
import { StorageClient } from '../../packages/storage/src/StorageClient';
import { OpfsReceiverStore } from '../../packages/storage/src/OpfsReceiverStore';
class WorkerFixture {
  static latest: WorkerFixture;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerFixture.latest = this;
  }
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('disposed recovery clients reject new work without sending RPC or arming a five-minute timer', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', WorkerFixture);
  const client = new StorageClient();
  client.dispose();
  let rejected = false;
  void client.list().catch(() => {
    rejected = true;
  });
  await Promise.resolve();
  const timers = vi.getTimerCount();
  client.dispose();
  expect(rejected).toBe(true);
  expect(WorkerFixture.latest.postMessage).not.toHaveBeenCalled();
  expect(timers).toBe(0);
});
it.each(['busy', 'quota', 'integrity', 'unavailable'] as const)(
  'preserves sanitized storage failure classification %s',
  async (code) => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', WorkerFixture);
    const client = new StorageClient();
    try {
      const result = client.list();
      WorkerFixture.latest.onmessage!({
        data: { id: 0, ok: false, code, error: 'synthetic-private-local-path' },
      });
      await expect(result).rejects.toMatchObject({ code });
      await result.catch((error: Error) =>
        expect(error.message.includes('synthetic-private-local-path')).toBe(false),
      );
    } finally {
      client.dispose();
    }
  },
);
it('a synchronous RPC send failure clears pending work and redacts its native error', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', WorkerFixture);
  const client = new StorageClient();
  WorkerFixture.latest.postMessage.mockImplementationOnce(() => {
    throw Error('synthetic-private-rpc-detail');
  });
  try {
    let publicMessage = '';
    await client.list().catch((error: Error) => {
      publicMessage = error.message;
    });
    const timers = vi.getTimerCount();
    expect(publicMessage.includes('synthetic-private-rpc-detail')).toBe(false);
    expect(timers).toBe(0);
    const next = client.list();
    WorkerFixture.latest.onmessage!({
      data: {
        id: 1,
        ok: true,
        result: { checkpoints: [], sources: [], unavailable: [], cleaned: 0 },
      },
    });
    await expect(next).resolves.toMatchObject({ cleaned: 0 });
  } finally {
    client.dispose();
  }
});
it.each(['missing-api', 'unknown-large-quota', 'known-insufficient-quota'])(
  'preparation distinguishes %s without writing metadata',
  async (kind) => {
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal('navigator', {
      locks: {},
      storage: {
        ...(kind === 'missing-api' ? {} : { getDirectory() {} }),
        estimate: async () => (kind === 'known-insufficient-quota' ? { quota: 1, usage: 0 } : {}),
        persisted: async () => false,
      },
    });
    const size = kind === 'unknown-large-quota' ? 65 * 1024 ** 2 : 3;
    const manifest = {
      version: 1 as const,
      revision: 1 as const,
      transferId: crypto.randomUUID(),
      blockBytes: 1048576 as const,
      totalBytes: size,
      files: [{ fileId: crypto.randomUUID(), path: 'capacity.bin', size, sha256: '0'.repeat(64) }],
    };
    await expect(new OpfsReceiverStore().prepare(manifest)).rejects.toMatchObject({
      code: kind === 'known-insufficient-quota' ? 'quota' : 'unavailable',
    });
  },
);
