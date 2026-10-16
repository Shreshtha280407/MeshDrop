import { VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import { blockRecordSchema, CheckpointDB } from './CheckpointDB';
import { digestBytes, digestManifest, storedBlockLength } from './integrity';
import { OpfsReceiverStore, purgeStoredTransfer, RECEIVER_DIRECTORY } from './OpfsReceiverStore';
import type { BlockRecord, Checkpoint, RecoveryListing } from './ReceiverStore';
import { StorageFailure } from './ReceiverStore';
import { uuidSchema } from '@meshdrop/protocol';

export function compactRanges(indices: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === index) last[1] = index;
    else ranges.push([index, index]);
  }
  return ranges;
}
/** OPFS and IDB have no common transaction: only rehashed, ledger-backed bytes survive. */
export class LedgerReconciler {
  async reconcile(store: OpfsReceiverStore): Promise<Checkpoint> {
    const { manifest, record, db } = store;
    const all = await db.blocks(record.transferId);
    const valid: BlockRecord[] = [];
    const invalid: BlockRecord[] = [];
    for (const raw of all) {
      try {
        const block = blockRecordSchema.parse(raw);
        const file = manifest.files.find((file) => file.fileId === block.fileId);
        if (
          !file ||
          block.transferId !== record.transferId ||
          block.bytes !== storedBlockLength(file.size, block.index)
        )
          throw new Error('Invalid ledger bounds.');
        if (digestBytes(await store.readBlock(block.fileId, block.index)) !== block.digest)
          throw new Error('Persisted block changed.');
        valid.push(block);
      } catch (error) {
        // Permission/locking/storage failures are not evidence of corrupt bytes. Leave the ledger intact.
        if (error instanceof DOMException && error.name !== 'NotFoundError') throw error;
        invalid.push(raw);
      }
    }
    const finalized: string[] = [];
    for (const file of manifest.files) {
      const blocks = valid.filter((block) => block.fileId === file.fileId);
      const end = blocks.reduce(
        (max, b) => Math.max(max, b.index * VERIFICATION_BLOCK_BYTES + b.bytes),
        0,
      );
      try {
        // Uncommitted tail writes never become a checkpoint merely because bytes survived.
        await store.truncateTail(file.fileId, end);
        if (blocks.length === Math.ceil(file.size / VERIFICATION_BLOCK_BYTES)) {
          await store.verifyFile(file.fileId);
          finalized.push(file.fileId);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name !== 'NotFoundError') throw error;
        if (blocks.length === Math.ceil(file.size / VERIFICATION_BLOCK_BYTES)) {
          for (const block of blocks) {
            valid.splice(valid.indexOf(block), 1);
            invalid.push(block);
          }
        }
      }
    }
    const receipt =
      record.receipt && finalized.length === manifest.files.length ? record.receipt : null;
    const next = {
      ...record,
      finalizedFiles: finalized,
      receipt,
      state: receipt ? ('complete' as const) : ('interrupted' as const),
      updatedAt: Date.now(),
    };
    await db.reconcile(next, invalid);
    store.record = next;
    return {
      record: next,
      manifest,
      committedBytes: valid.reduce((sum, b) => sum + b.bytes, 0),
      files: manifest.files.map((file) => {
        const blocks = valid.filter((b) => b.fileId === file.fileId);
        return {
          fileId: file.fileId,
          ranges: compactRanges(blocks.map((b) => b.index)),
          verifiedBytes: blocks.reduce((sum, b) => sum + b.bytes, 0),
          finalized: finalized.includes(file.fileId),
        };
      }),
      discardedBlocks: invalid.length,
      verifiedAt: Date.now(),
    };
  }
  async listAndReconcile(): Promise<RecoveryListing> {
    const db = new CheckpointDB();
    const result: RecoveryListing = { checkpoints: [], sources: [], unavailable: [], cleaned: 0 };
    for (const record of await db.list()) {
      const store = new OpfsReceiverStore();
      try {
        if (
          record.state === 'deleting' ||
          record.expiresAt <= Date.now() ||
          record.retention === 'discard'
        ) {
          await purgeStoredTransfer(record.transferId);
          result.cleaned++;
          continue;
        }
        await store.open(record.transferId);
        result.checkpoints.push(await this.reconcile(store));
      } catch (error) {
        result.unavailable.push({
          transferId: record.transferId,
          reason:
            error instanceof StorageFailure && error.code === 'busy'
              ? 'Open in another tab.'
              : 'Checkpoint unavailable. Storage may be missing, denied or damaged.',
        });
      } finally {
        await store.close();
      }
    }
    for (const source of await db.sources()) {
      if (source.expiresAt <= Date.now()) {
        await db.removeSource(source.transferId);
        continue;
      }
      if (
        source.transferId !== source.manifest.transferId ||
        digestManifest(source.manifest) !== source.manifestDigest
      )
        continue;
      result.sources.push(source);
    }
    // A cleared/missing IDB may leave OPFS directories. Only collect this package's valid UUID roots,
    // under the same exclusive lock used by prepare/purge; never touch unrelated origin data.
    try {
      const parent = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle(RECEIVER_DIRECTORY);
      const known = new Set((await db.list()).map((r) => r.transferId));
      const iterable = parent as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      for await (const [name] of iterable.entries())
        if (uuidSchema.safeParse(name).success && !known.has(name)) {
          // Recheck after taking the lock to avoid racing a newly prepared transfer.
          const { acquireStoreLock } = await import('./locks');
          const release = await acquireStoreLock(name).catch(() => null);
          if (!release) continue;
          try {
            if (!(await db.get(name))) {
              await parent.removeEntry(name, { recursive: true });
              result.cleaned++;
            }
          } finally {
            await release();
          }
        }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError'))
        result.unavailable.push({
          transferId: 'local-storage',
          reason: 'Some orphaned storage could not be inspected.',
        });
    }
    return result;
  }
}
