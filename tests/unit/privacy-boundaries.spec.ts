import { afterEach, expect, it, vi } from 'vitest';
import type { TransferReceipt } from '@meshdrop/protocol';
import { LedgerReconciler } from '../../packages/storage/src/LedgerReconciler';
import type { OpfsReceiverStore } from '../../packages/storage/src/OpfsReceiverStore';
import { digestBytes, digestManifest } from '../../packages/storage/src/integrity';
import { RoomClient } from '../../apps/web/src/features/pairing/RoomClient';
import {
  consumeInvitationUrl,
  observeInvitationUrls,
} from '../../apps/web/src/security/invitationUrl';

const clients: RoomClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
});
function stored() {
  const bytes = new Uint8Array([3, 1, 4]);
  const file = {
    fileId: crypto.randomUUID(),
    path: 'safe.bin',
    size: bytes.length,
    sha256: digestBytes(bytes),
  };
  const manifest = {
    version: 1 as const,
    revision: 1 as const,
    transferId: crypto.randomUUID(),
    blockBytes: 1048576 as const,
    files: [file],
    totalBytes: bytes.length,
  };
  const receipt: TransferReceipt = {
    receiptId: crypto.randomUUID(),
    transferId: manifest.transferId,
    manifestDigest: digestManifest(manifest),
    epoch: 1,
    totalBytes: bytes.length,
    files: [file],
    destination: 'browser-temporary',
    completedAt: new Date().toISOString(),
  };
  const record = {
    schemaVersion: 1 as const,
    transferId: manifest.transferId,
    manifestDigest: digestManifest(manifest),
    blockSize: 1048576,
    storageKey: crypto.randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    retention: '24-hours' as const,
    state: 'complete' as const,
    finalizedFiles: [file.fileId],
    receipt,
  };
  const block = {
    transferId: manifest.transferId,
    fileId: file.fileId,
    index: 0,
    bytes: bytes.length,
    digest: file.sha256,
    committedAt: Date.now(),
  };
  // Actual reconciler/hash checks with a bounded byte-store seam; browser tests
  // separately exercise real OPFS/IndexedDB rather than claiming this is durable I/O.
  const store = {
    manifest,
    record,
    db: { blocks: async () => [block], reconcile: vi.fn(async () => {}) },
    readBlock: async () => bytes,
    truncateTail: async () => {},
    verifyFile: async () => ({ file: new File([bytes], file.path), sha256: digestBytes(bytes) }),
  } as unknown as OpfsReceiverStore;
  return { store, receipt };
}
it('retains a consistent receipt only after actual stored-byte rehash', async () => {
  const f = stored();
  const checkpoint = await new LedgerReconciler().reconcile(f.store);
  expect(checkpoint.committedBytes).toBe(3);
  expect(checkpoint.record.receipt).toEqual(f.receipt);
  expect(checkpoint.record.state).toBe('complete');
});
it.each(['transfer', 'manifest', 'total', 'file-id', 'file-hash', 'file-size', 'file-path'])(
  'discards a structurally valid but mismatched persisted receipt: %s',
  async (field) => {
    const f = stored();
    const receipt = structuredClone(f.receipt);
    if (field === 'transfer') receipt.transferId = crypto.randomUUID();
    if (field === 'manifest') receipt.manifestDigest = '0'.repeat(64);
    if (field === 'total') receipt.totalBytes++;
    if (field === 'file-id') receipt.files[0]!.fileId = crypto.randomUUID();
    if (field === 'file-hash') receipt.files[0]!.sha256 = '0'.repeat(64);
    if (field === 'file-size') receipt.files[0]!.size++;
    if (field === 'file-path') receipt.files[0]!.path = 'another.bin';
    f.store.record.receipt = receipt;
    const checkpoint = await new LedgerReconciler().reconcile(f.store);
    expect(checkpoint.committedBytes).toBe(3);
    expect(checkpoint.files[0]!.finalized).toBe(true);
    expect(checkpoint.record.receipt).toBeNull();
    expect(checkpoint.record.state).toBe('interrupted');
  },
);
it.each(['fetch', 'json', 'api-error'])(
  'keeps synthetic credential material out of UI errors from %s failures',
  async (kind) => {
    const canary = 'task15-private-canary-' + 'X'.repeat(32);
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', async () => {
      if (kind === 'fetch') throw Error(canary);
      if (kind === 'json')
        return {
          ok: true,
          json: async () => {
            throw Error(canary);
          },
        };
      return Response.json(
        {
          code: 'INTERNAL_ERROR',
          message: canary,
          retryable: true,
          requestId: crypto.randomUUID(),
        },
        { status: 500 },
      );
    });
    const client = new RoomClient();
    clients.push(client);
    await client.createRoom();
    expect(client.getSnapshot().busy).toBe(false);
    expect(client.getSnapshot().error.length).toBeGreaterThan(0);
    // Boolean assertion prevents even a failed test from echoing the canary.
    expect(client.getSnapshot().error.includes(canary)).toBe(false);
  },
);
it('preserves actionable offline and malformed-invitation guidance', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const client = new RoomClient();
  clients.push(client);
  await client.createRoom();
  expect(client.getSnapshot().error).toContain('offline');
  await client.joinRoom('not-an-invitation');
  expect(client.getSnapshot().error).toContain('Invalid invitation');
});

function navigation(href = 'https://app.example.test/') {
  const target = new EventTarget();
  let location = new URL(href);
  const state = { publicNavigation: true };
  const replaceState = vi.fn((_state: unknown, _title: string, path: string) => {
    location = new URL(path, location);
  });
  vi.stubGlobal('window', {
    get location() {
      return location;
    },
    history: { state, replaceState },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  return {
    target,
    replaceState,
    set: (href: string) => (location = new URL(href, location)),
    current: () => location.href,
  };
}
it.each(['hashchange', 'popstate', 'pageshow'])(
  'scrubs a restored invitation before the %s consumer sees it',
  (event) => {
    const nav = navigation();
    const consumed: string[] = [];
    const stop = observeInvitationUrls((value) => {
      expect(new URL(nav.current()).hash).toBe('');
      consumed.push(value);
    });
    try {
      nav.set('/#room=synthetic-room&invite=synthetic-invitation');
      nav.target.dispatchEvent(new Event(event));
      expect(consumed).toHaveLength(1);
      expect(consumed[0]!.includes('synthetic-invitation')).toBe(true);
      expect(nav.replaceState).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  },
);
it('consumes the subscription gap and removes every navigation listener on cleanup', () => {
  const nav = navigation('https://app.example.test/#synthetic-invitation');
  const receive = vi.fn();
  const stop = observeInvitationUrls(receive);
  expect(receive).toHaveBeenCalledTimes(1);
  stop();
  for (const event of ['hashchange', 'popstate', 'pageshow']) {
    nav.set('/#synthetic-later-invitation');
    nav.target.dispatchEvent(new Event(event));
  }
  expect(receive).toHaveBeenCalledTimes(1);
  expect(nav.replaceState).toHaveBeenCalledTimes(1);
});
it('scrubs oversized fragment input without delivering it to the application', () => {
  const nav = navigation('https://app.example.test/#' + 'x'.repeat(2049));
  expect(consumeInvitationUrl()).toBe('');
  expect(nav.current()).toBe('https://app.example.test/');
});
it('leaves fragment-free navigation and history state untouched', () => {
  const nav = navigation('https://app.example.test/public');
  expect(consumeInvitationUrl()).toBe('');
  expect(nav.replaceState).not.toHaveBeenCalled();
});
