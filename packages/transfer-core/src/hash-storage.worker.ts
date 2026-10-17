/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha2.js';
import { VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type {
  BlockProof,
  TransferFile,
  TransferManifest,
  TransferReceipt,
} from '@meshdrop/protocol';
import {
  CheckpointDB,
  LedgerReconciler,
  OpfsReceiverStore,
  StorageFailure,
  isQuotaError,
  retentionExpiry,
} from '@meshdrop/storage';
import type { RetentionPolicy, TransferRecord } from '@meshdrop/storage';
import { digestManifest, hashLocalFile, hexDigest } from '@meshdrop/storage';
import type { SourceEntry } from './HashWorker';
import { blockLength } from './Manifest';
import { validateResumeEpoch } from '@meshdrop/recovery';
const sources = new Map<string, File>();
let store: OpfsReceiverStore | null = null;
let retry: {
  fileId: string;
  index: number;
  bytes: Uint8Array<ArrayBuffer>;
  digest: string;
} | null = null;
async function commit(block: NonNullable<typeof retry>): Promise<void> {
  if (!store) throw new Error('Destination unavailable.');
  try {
    await store.writeBlock(block.fileId, block.index, block.bytes);
    await store.commitBlock(block.fileId, block.index, block.digest);
    retry = null;
  } catch (error) {
    if (isQuotaError(error)) {
      retry = block;
      await store.db
        .put({ ...store.record, state: 'storage-full', updatedAt: Date.now() })
        .catch(() => {});
      throw new StorageFailure(
        'quota',
        'Browser storage is full. Valid committed blocks are retained.',
      );
    }
    throw error;
  }
}
async function run(operation: string, payload: unknown): Promise<unknown> {
  if (operation === 'sources') {
    if (sources.size || store) throw new Error('Worker already owns a transfer.');
    const entries = payload as SourceEntry[];
    const result: TransferFile[] = [];
    for (const entry of entries) {
      sources.set(entry.fileId, entry.file);
      result.push({
        fileId: entry.fileId,
        path: entry.path,
        size: entry.file.size,
        sha256: await hashLocalFile(entry.file),
      });
    }
    return result;
  }
  if (operation === 'remember-sources') {
    const { manifest, retention } = payload as {
      manifest: TransferManifest;
      retention: RetentionPolicy;
    };
    if (retention !== 'discard') {
      const db = new CheckpointDB();
      const old = await db.sources();
      if (old.length >= 32)
        await db.removeSource(old.sort((a, b) => a.expiresAt - b.expiresAt)[0]!.transferId);
      await db.rememberSource({
        transferId: manifest.transferId,
        manifest,
        manifestDigest: digestManifest(manifest),
        expiresAt: retentionExpiry(retention),
      });
    }
    return null;
  }
  if (operation === 'source-block' || operation === 'source-digest') {
    const { fileId, index } = payload as { fileId: string; index: number };
    const file = sources.get(fileId);
    if (!file) throw new Error('Source file unavailable.');
    const length = blockLength(file.size, index);
    const bytes = new Uint8Array(
      await file
        .slice(index * VERIFICATION_BLOCK_BYTES, index * VERIFICATION_BLOCK_BYTES + length)
        .arrayBuffer(),
    );
    if (bytes.length !== length) throw new Error('Source file could not be read.');
    const digest = hexDigest(sha256(bytes));
    return operation === 'source-digest' ? digest : { bytes, digest };
  }
  if (operation === 'open-checkpoint') {
    if (store || sources.size) throw new Error('Worker already owns a transfer.');
    const { transferId, digest } = payload as { transferId: string; digest: string };
    store = new OpfsReceiverStore();
    await store.open(transferId);
    if (
      store.record.manifestDigest !== digest ||
      store.record.expiresAt <= Date.now() ||
      store.record.retention === 'discard'
    )
      throw new Error('Checkpoint identity or retention changed.');
    const checkpoint = await new LedgerReconciler().reconcile(store);
    await store.enableResumeWrites();
    const blocks = (await store.db.blocks(transferId)).map(({ fileId, index, digest }) => ({
      fileId,
      index,
      digest,
    }));
    return { checkpoint, blocks };
  }
  if (operation === 'invalidate-checkpoint') {
    if (!store) throw new Error('No checkpoint.');
    const rejected = payload as BlockProof[];
    const all = await store.db.blocks(store.record.transferId);
    const invalid = all.filter((block) =>
      rejected.some((b) => b.fileId === block.fileId && b.index === block.index),
    );
    const changed = new Set(invalid.map((b) => b.fileId));
    const next = {
      ...store.record,
      receipt: null,
      state: 'interrupted' as const,
      finalizedFiles: store.record.finalizedFiles.filter((id) => !changed.has(id)),
      checkpointDigest: undefined,
    };
    await store.db.reconcile(next, invalid);
    store.record = next;
    await store.enableResumeWrites();
    return null;
  }
  if (operation === 'bind-resume') {
    if (!store) throw new Error('No checkpoint.');
    const resume = payload as NonNullable<TransferRecord['lastResume']>;
    validateResumeEpoch(store.record.lastResume, resume);
    const next = {
      ...store.record,
      lastResume: resume,
      checkpointDigest: resume.checkpointDigest,
      receipt: null,
      state: 'receiving' as const,
    };
    await store.db.put(next);
    store.record = next;
    return null;
  }
  if (operation === 'receiver') {
    if (store || sources.size) throw new Error('Worker already owns a transfer.');
    const { storageKey, manifest, retention } = payload as {
      storageKey: string;
      manifest: TransferManifest;
      retention: RetentionPolicy;
    };
    store = new OpfsReceiverStore();
    return store.prepare(manifest, { storageKey, retention });
  }
  if (operation === 'commit') {
    await commit(payload as NonNullable<typeof retry>);
    return null;
  }
  if (operation === 'retry-commit') {
    if (!retry) throw new Error('No pending storage retry.');
    await commit(retry);
    return null;
  }
  if (operation === 'finalize') {
    if (!store) throw new Error('Destination unavailable.');
    return store.finalize((payload as { fileId: string }).fileId);
  }
  if (operation === 'receipt') {
    if (!store) throw new Error('Destination unavailable.');
    await store.rememberReceipt(payload as TransferReceipt);
    await store.close();
    return null;
  }
  throw new Error('Unknown hash/storage operation.');
}
let busy = false;
self.onmessage = (event: MessageEvent<{ id: number; operation: string; payload: unknown }>) => {
  const { id, operation, payload } = event.data;
  if (busy) {
    self.postMessage({ id, ok: false, error: 'Hash/storage worker is busy.' });
    return;
  }
  busy = true;
  void run(operation, payload)
    .then((result) => {
      const transfer =
        operation === 'source-block'
          ? [(result as { bytes: Uint8Array<ArrayBuffer> }).bytes.buffer]
          : [];
      self.postMessage({ id, ok: true, result }, transfer);
    })
    .catch((error: unknown) => {
      const code = isQuotaError(error)
        ? 'quota'
        : error instanceof StorageFailure
          ? error.code
          : 'unavailable';
      // Local filenames, raw paths, capabilities and OS messages never enter error responses.
      self.postMessage({
        id,
        ok: false,
        code,
        error:
          code === 'quota'
            ? 'Browser storage is full. Valid blocks are retained.'
            : 'File integrity or local storage operation failed.',
      });
    })
    .finally(() => {
      busy = false;
    });
};
