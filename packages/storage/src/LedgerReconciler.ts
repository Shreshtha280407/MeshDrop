import { checkpointDigest } from '@meshdrop/recovery';
import { VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import { blockRecordSchema, CheckpointDB } from './CheckpointDB';
import {
  digestBytes,
  digestManifest,
  receiptMatchesManifest,
  storedBlockLength,
} from './integrity';
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
    const assertRetained = () => {
      if (
        record.state === 'deleting' ||
        record.expiresAt <= Date.now() ||
        record.retention === 'discard'
      )
        throw new StorageFailure('unavailable', 'Checkpoint retention has ended.');
    };
    assertRetained();
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
      finalized.length === manifest.files.length && receiptMatchesManifest(record.receipt, manifest)
        ? record.receipt
        : null;
    const next = {
      ...record,
      finalizedFiles: finalized,
      checkpointDigest: checkpointDigest(record.manifestDigest, valid),
      receipt,
      state: receipt ? ('complete' as const) : ('interrupted' as const),
      updatedAt: Date.now(),
    };
    assertRetained();
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
    // A durable explicit-deletion intent survives even damaged non-identity metadata.
    const deleting = new Set(await db.pendingDeletions());
    for (const id of deleting) {
      try {
        if (await purgeStoredTransfer(id, 'retention')) result.cleaned++;
      } catch (error) {
        result.unavailable.push({
          transferId: id,
          kind: 'receiver',
          reason:
            error instanceof StorageFailure && error.code === 'busy'
              ? 'Open in another tab.'
              : 'Local deletion could not finish. Try deleting this checkpoint again.',
        });
      }
    }
    result.unavailable.push(
      ...(await db.catalogIssues('transfers')).filter((item) => !deleting.has(item.transferId)),
    );
    for (const record of await db.list()) {
      if (deleting.has(record.transferId)) continue;
      const store = new OpfsReceiverStore();
      try {
        if (
          record.state === 'deleting' ||
          record.expiresAt <= Date.now() ||
          record.retention === 'discard'
        ) {
          if (await purgeStoredTransfer(record.transferId, 'retention')) {
            result.cleaned++;
            continue;
          }
        }
        await store.open(record.transferId);
        result.checkpoints.push(await this.reconcile(store));
      } catch (error) {
        result.unavailable.push({
          transferId: record.transferId,
          kind: 'receiver',
          reason:
            error instanceof StorageFailure && error.code === 'busy'
              ? 'Open in another tab.'
              : 'Checkpoint unavailable. Storage may be missing, denied or damaged.',
        });
      } finally {
        await store.close();
      }
    }
    result.unavailable.push(...(await db.catalogIssues('sources')));
    for (let source of await db.sources()) {
      if (source.expiresAt <= Date.now()) {
        if (await db.removeSource(source.transferId, 'retention')) continue;
        const fresh = (await db.sources()).find((value) => value.transferId === source.transferId);
        if (!fresh || fresh.expiresAt <= Date.now()) continue;
        source = fresh;
      }
      if (
        source.transferId !== source.manifest.transferId ||
        digestManifest(source.manifest) !== source.manifestDigest
      ) {
        result.unavailable.push({
          transferId: source.transferId,
          kind: 'source',
          reason: 'Source metadata is damaged.',
        });
        continue;
      }
      result.sources.push(source);
    }
    // Loss of transfer rows can strand both OPFS and manifest/block metadata.
    // Each candidate is rechecked under the same lock used by prepare/purge.
    try {
      let parent: FileSystemDirectoryHandle | null = null;
      try {
        parent = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle(RECEIVER_DIRECTORY);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
      const known = new Set([
        ...(await db.list()).map((r) => r.transferId),
        ...(await db.catalogIssues('transfers')).map((r) => r.transferId),
      ]);
      const collect = async (id: string) => {
        const { acquireStoreLock } = await import('./locks');
        let release: () => Promise<void>;
        try {
          release = await acquireStoreLock(id);
        } catch (error) {
          if (!(error instanceof StorageFailure && error.code === 'busy'))
            result.unavailable.push({ transferId: id, reason: 'Orphan cleanup is unavailable.' });
          return;
        }
        try {
          if (await db.get(id)) return;
          // Remove orphan metadata first: a crash still leaves a discoverable
          // UUID directory for the next pass. Sources are independently scoped.
          await db.remove(id);
          if (parent) {
            let directory = false;
            try {
              await parent.getDirectoryHandle(id);
              directory = true;
            } catch (error) {
              if (
                !(
                  error instanceof DOMException &&
                  ['NotFoundError', 'TypeMismatchError'].includes(error.name)
                )
              )
                throw error;
            }
            if (directory) await parent.removeEntry(id, { recursive: true });
          }
          result.cleaned++;
        } catch {
          result.unavailable.push({ transferId: id, reason: 'Orphan cleanup could not finish.' });
        } finally {
          await release();
        }
      };
      for (const id of await db.orphanIds()) await collect(id);
      if (parent) {
        const iterable = parent as FileSystemDirectoryHandle & {
          entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
        };
        for await (const [name, handle] of iterable.entries())
          if (handle.kind === 'directory' && uuidSchema.safeParse(name).success && !known.has(name))
            await collect(name);
      }
    } catch {
      result.unavailable.push({
        transferId: 'local-storage',
        reason: 'Some orphaned storage could not be inspected.',
      });
    }
    const unavailable = new Map<string, RecoveryListing['unavailable'][number]>();
    for (const item of result.unavailable) {
      const key = `${item.kind ?? 'orphan'}:${item.transferId}`;
      const previous = unavailable.get(key);
      if (!previous) unavailable.set(key, item);
      else if (!previous.reason.includes(item.reason)) previous.reason += ' ' + item.reason;
    }
    result.unavailable = [...unavailable.values()];
    return result;
  }
}
