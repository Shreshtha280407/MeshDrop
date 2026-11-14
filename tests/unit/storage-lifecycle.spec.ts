import { afterEach, expect, it, vi } from 'vitest';
import {
  OpfsReceiverStore,
  purgeStoredTransfer,
} from '../../packages/storage/src/OpfsReceiverStore';
import { LedgerReconciler } from '../../packages/storage/src/LedgerReconciler';
import { digestBytes, digestManifest } from '../../packages/storage/src/integrity';
import { CheckpointDB } from '../../packages/storage/src/CheckpointDB';
import { StorageModel } from '../helpers/storage-model';
import type { TransferManifest } from '@meshdrop/protocol';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const bytes = new Uint8Array([3, 1, 4]);
const actions = [
  'write',
  'commit',
  'crash',
  'open',
  'expire',
  'purge',
  'quota',
  'corrupt',
  'list',
  'source',
  'source-expiry',
  'forget-source',
  'lock',
  'prepare',
  'tombstone',
  'orphan',
] as const;
for (const seed of [7, 17, 97, 2027, 0x5eed, 0xcafe, 0x1234, 0x9876])
  it(`seed ${seed}: 250 lifecycle schedules preserve committed-byte, expiry, lock and cleanup invariants`, async () => {
    const model = new StorageModel();
    model.install();
    let random = seed;
    const choose = () => {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      return actions[(random >>> 16) % actions.length]!;
    };
    const seen = new Set<string>();
    for (let schedule = 0; schedule < 250; schedule++) {
      model.records.clear();
      model.manifests.clear();
      model.blocks.clear();
      model.sources.clear();
      model.root.children.clear();
      model.quota = false;
      const m: TransferManifest = {
        version: 1,
        revision: 1,
        transferId: crypto.randomUUID(),
        blockBytes: 1048576,
        totalBytes: bytes.length,
        files: [
          {
            fileId: crypto.randomUUID(),
            path: 'schedule.bin',
            size: bytes.length,
            sha256: digestBytes(bytes),
          },
        ],
      };
      const retention = (['24-hours', '7-days', 'discard'] as const)[schedule % 3]!;
      let active: OpfsReceiverStore | null = new OpfsReceiverStore();
      let committed = false;
      let sourceExpires: number | null = null;
      const unrelated = crypto.randomUUID();
      const namespace = await model.root.getDirectoryHandle('meshdrop-receiver-v1', {
        create: true,
      });
      await namespace.getFileHandle(unrelated, { create: true });
      await active.prepare(m, { retention });
      await active.writeBlock(m.files[0]!.fileId, 0, bytes);
      let pending = true;
      try {
        for (let step = 0; step < 24; step++) {
          model.now++;
          const action = choose();
          seen.add(action);
          const before = model.records.get(m.transferId);
          if (action === 'write' && active && !committed) {
            await active.writeBlock(m.files[0]!.fileId, 0, bytes);
            pending = true;
          } else if (action === 'commit' && active && pending && !committed) {
            await active.commitBlock(m.files[0]!.fileId, 0, m.files[0]!.sha256);
            committed = true;
            pending = false;
          } else if (action === 'crash') {
            await active?.close();
            active = null;
            pending = false;
          } else if (action === 'open' && !active && before) {
            const reopened = new OpfsReceiverStore();
            if (
              before.state === 'deleting' ||
              before.expiresAt <= model.now ||
              retention === 'discard'
            ) {
              await expect(reopened.open(m.transferId)).rejects.toThrow();
            } else {
              await reopened.open(m.transferId);
              const checkpoint = await new LedgerReconciler().reconcile(reopened);
              expect(checkpoint.committedBytes).toBe(committed ? bytes.length : 0);
              expect(checkpoint.record.receipt).toBeNull();
              expect(checkpoint.record.expiresAt).toBe(before.expiresAt);
              await reopened.enableResumeWrites();
              active = reopened;
            }
          } else if (action === 'expire' && before) {
            model.now = Math.max(model.now, before.expiresAt);
          } else if (action === 'purge') {
            if (active)
              await expect(purgeStoredTransfer(m.transferId)).rejects.toMatchObject({
                code: 'busy',
              });
            else {
              await purgeStoredTransfer(m.transferId);
              committed = false;
              pending = false;
            }
          } else if (action === 'quota' && active && !committed) {
            model.quota = true;
            await expect(active.writeBlock(m.files[0]!.fileId, 0, bytes)).rejects.toMatchObject({
              name: 'QuotaExceededError',
            });
            pending = false;
          } else if (action === 'corrupt' && !active && before && committed) {
            const file = await model.file(before, m.files[0]!.fileId);
            file.bytes[0] = file.bytes[0]! ^ 255;
            committed = false;
          } else if (action === 'source') {
            sourceExpires = model.now + 50;
            await new CheckpointDB().rememberSource({
              transferId: m.transferId,
              manifest: m,
              manifestDigest: digestManifest(m),
              expiresAt: sourceExpires,
            });
          } else if (action === 'source-expiry' && sourceExpires !== null) {
            model.now = Math.max(model.now, sourceExpires);
          } else if (action === 'forget-source') {
            const receiver = structuredClone(before);
            await new CheckpointDB().removeSource(m.transferId);
            sourceExpires = null;
            expect(model.records.get(m.transferId)).toEqual(receiver);
          } else if (action === 'lock' && active) {
            const second = new OpfsReceiverStore();
            await expect(second.open(m.transferId)).rejects.toMatchObject({ code: 'busy' });
          } else if (action === 'prepare' && !active && !before) {
            active = new OpfsReceiverStore();
            await active.prepare(m, { retention });
            committed = false;
            pending = false;
          } else if (action === 'tombstone' && !active && before) {
            model.records.set(m.transferId, { ...before, state: 'deleting' });
          } else if (action === 'orphan') {
            await namespace.getDirectoryHandle(crypto.randomUUID(), { create: true });
          }
          if (action === 'list') {
            const record = model.records.get(m.transferId);
            const retained =
              !!record &&
              record.state !== 'deleting' &&
              record.expiresAt > model.now &&
              retention !== 'discard';
            const listing = await new LedgerReconciler().listAndReconcile();
            if (active) {
              expect(listing.checkpoints).toEqual([]);
              expect(listing.unavailable.some((v) => v.transferId === m.transferId)).toBe(true);
              expect(model.records.get(m.transferId)).toEqual(record);
            } else if (retained) {
              expect(listing.checkpoints.length).toBe(1);
              expect(listing.checkpoints[0]!.committedBytes).toBe(committed ? bytes.length : 0);
              expect(listing.checkpoints[0]!.record.receipt).toBeNull();
              expect(listing.checkpoints[0]!.record.expiresAt).toBe(record!.expiresAt);
            } else {
              expect(listing.checkpoints).toEqual([]);
              expect(model.records.has(m.transferId)).toBe(false);
              committed = false;
              pending = false;
            }
            const expectedSource = sourceExpires !== null && sourceExpires > model.now;
            // Sources use the real manifest digest in their own independent ledger.
            expect(listing.sources.length).toBe(expectedSource ? 1 : 0);
            expect(namespace.children.has(unrelated)).toBe(true);
          }
          expect([...model.blocks.values()].every((b) => b.bytes <= m.totalBytes)).toBe(true);
        }
      } finally {
        await active?.close();
      }
      expect(model.locks.size).toBe(0);
      // Bound test instrumentation as well as the simulated byte stores.
      for (const name of [
        'get',
        'list',
        'catalogIssues',
        'markDeleting',
        'pendingDeletions',
        'manifest',
        'blocks',
        'create',
        'put',
        'commit',
        'reconcile',
        'remove',
        'orphanIds',
        'sources',
        'rememberSource',
        'removeSource',
      ] as const) {
        const mock = CheckpointDB.prototype[name];
        if (vi.isMockFunction(mock)) mock.mockClear();
      }
    }
    expect(seen.size).toBe(actions.length);
  });
