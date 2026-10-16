/// <reference lib="webworker" />
// Browser-only fault harness. This file is not imported by or bundled into the application.
import {
  OpfsReceiverStore,
  RECEIVER_DIRECTORY,
  purgeStoredTransfer,
} from '../../packages/storage/src/OpfsReceiverStore';
import { CheckpointDB } from '../../packages/storage/src/CheckpointDB';
import { LedgerReconciler } from '../../packages/storage/src/LedgerReconciler';
import type { CommitStage, RetentionPolicy } from '../../packages/storage/src/ReceiverStore';
import type { TransferManifest } from '@meshdrop/protocol';
import { hashLocalFile } from '../../packages/storage/src/integrity';
let store: OpfsReceiverStore | null = null;
let stage: CommitStage | null = null;
let quota = false;
let abortLedger = false;
const originalPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
  const result =
    key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  if (abortLedger && this.name === 'transfers') {
    abortLedger = false;
    this.transaction.abort();
  }
  return result;
};
async function run(operation: string, payload: unknown): Promise<unknown> {
  const input = payload as {
    manifest?: TransferManifest;
    transferId: string;
    fileId: string;
    index: number;
    bytes: number[];
    digest: string;
    stage: CommitStage;
    retention?: RetentionPolicy;
  };
  const db = new CheckpointDB();
  if (operation === 'prepare') {
    store = new OpfsReceiverStore();
    return store.prepare(input.manifest!, {
      retention: input.retention ?? '24-hours',
      onStage: async (current) => {
        if (current === stage) {
          self.postMessage({ event: 'stage', stage: current });
          await new Promise(() => {});
        }
        if (quota && current === 'after-write') {
          quota = false;
          throw new DOMException('Injected test quota.', 'QuotaExceededError');
        }
      },
    });
  }
  if (operation === 'arm') {
    stage = input.stage;
    return null;
  }
  if (operation === 'quota') {
    quota = true;
    return null;
  }
  if (operation === 'abort-ledger') {
    abortLedger = true;
    return null;
  }
  if (operation === 'commit') {
    if (!store) throw new Error('No store.');
    await store.writeBlock(input.fileId, input.index, new Uint8Array(input.bytes));
    await store.commitBlock(input.fileId, input.index, input.digest);
    return { committed: true };
  }
  if (operation === 'close') {
    await store?.close();
    store = null;
    return null;
  }
  if (operation === 'reconcile') {
    const reopened = new OpfsReceiverStore();
    try {
      await reopened.open(input.transferId);
      return await new LedgerReconciler().reconcile(reopened);
    } finally {
      await reopened.close();
    }
  }
  if (operation === 'list') return new LedgerReconciler().listAndReconcile();
  if (operation === 'expire') {
    const record = await db.get(input.transferId);
    await db.put({ ...record!, expiresAt: Date.now() - 1 });
    return null;
  }
  if (operation === 'remove-ledger') {
    await db.remove(input.transferId);
    return null;
  }
  if (operation === 'mutate' || operation === 'delete-file') {
    await store?.close();
    store = null;
    const record = await db.get(input.transferId);
    const parent = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(RECEIVER_DIRECTORY);
    const directory = await (
      await parent.getDirectoryHandle(input.transferId)
    ).getDirectoryHandle(record!.storageKey);
    if (operation === 'delete-file') {
      await directory.removeEntry(input.fileId);
      return null;
    }
    const access = await (await directory.getFileHandle(input.fileId)).createSyncAccessHandle();
    access.write(new Uint8Array([255]), { at: input.index * 1024 ** 2 });
    await access.flush();
    await access.close();
    return null;
  }
  if (operation === 'forge-ledger') {
    const record = await db.get(input.transferId);
    await db.commit(record!, {
      transferId: input.transferId,
      fileId: input.fileId,
      index: input.index,
      bytes: 1024 ** 2,
      digest: input.digest,
      committedAt: Date.now(),
    });
    return null;
  }
  if (operation === 'records') return db.blocks(input.transferId);
  if (operation === 'record') return db.get(input.transferId);
  if (operation === 'purge') {
    await purgeStoredTransfer(input.transferId);
    return null;
  }
  if (operation === 'prefix-digest') {
    const record = await db.get(input.transferId);
    const parent = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(RECEIVER_DIRECTORY);
    const directory = await (
      await parent.getDirectoryHandle(input.transferId)
    ).getDirectoryHandle(record!.storageKey);
    const file = await (await directory.getFileHandle(input.fileId)).getFile();
    return { bytes: file.size, sha256: await hashLocalFile(file) };
  }
  throw new Error('Unknown test operation.');
}
self.onmessage = (event: MessageEvent<{ id: number; operation: string; payload: unknown }>) => {
  const { id, operation, payload } = event.data;
  void run(operation, payload)
    .then((result) => self.postMessage({ id, ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.name : 'Error' }),
    );
};
