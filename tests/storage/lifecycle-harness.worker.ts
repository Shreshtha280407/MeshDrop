/// <reference lib="webworker" />
// Isolated browser test infrastructure; never imported by application code.
import {
  OpfsReceiverStore,
  purgeStoredTransfer,
  RECEIVER_DIRECTORY,
} from '../../packages/storage/src/OpfsReceiverStore';
import { CheckpointDB } from '../../packages/storage/src/CheckpointDB';
import { LedgerReconciler } from '../../packages/storage/src/LedgerReconciler';
import { digestManifest } from '../../packages/storage/src/integrity';
import type { TransferManifest, TransferReceipt } from '@meshdrop/protocol';
import type { RetentionPolicy, TransferRecord } from '../../packages/storage/src/ReceiverStore';
import { acquireStoreLock } from '../../packages/storage/src/locks';

let store: OpfsReceiverStore | null = null;
let reconciling: OpfsReceiverStore | null = null;
let clock: number | null = null;
const wallClock = Date.now;
Date.now = () => clock ?? wallClock();
let armed = '';
let fault = '';
let faultName = 'NotAllowedError';
let transferId = '';
let catalogReads = 0;
const locks = new Map<string, () => Promise<void>>();
let release: (() => void) | null = null;
function fail(name: string) {
  if (fault !== name) return;
  fault = '';
  throw new DOMException('Injected isolated storage failure.', faultName);
}
async function gate(name: string) {
  fail(name);
  if (armed !== name) return;
  armed = '';
  await new Promise<void>((resolve) => {
    release = resolve;
    self.postMessage({ event: 'stage', stage: name });
  });
}
const originalList = CheckpointDB.prototype.list;
CheckpointDB.prototype.list = async function () {
  const snapshot = await originalList.call(this);
  await gate('catalog');
  if (++catalogReads === 2) await gate('orphan-catalog');
  return snapshot;
};
const originalSources = CheckpointDB.prototype.sources;
CheckpointDB.prototype.sources = async function () {
  const snapshot = await originalSources.call(this);
  await gate('source-catalog');
  return snapshot;
};
const originalPut = CheckpointDB.prototype.put;
CheckpointDB.prototype.put = async function (record) {
  if (record.state === 'complete') await gate('receipt');
  await originalPut.call(this, record);
};
const originalMarkDeleting = CheckpointDB.prototype.markDeleting;
CheckpointDB.prototype.markDeleting = async function (id, mode) {
  await gate('before-tombstone');
  const marked = await originalMarkDeleting.call(this, id, mode);
  if (marked) await gate('after-tombstone');
  return marked;
};
const originalCreate = CheckpointDB.prototype.create;
CheckpointDB.prototype.create = async function (record, manifest) {
  await gate('before-metadata');
  await originalCreate.call(this, record, manifest);
  await gate('after-metadata');
};
const originalRemove = CheckpointDB.prototype.remove;
CheckpointDB.prototype.remove = async function (id) {
  await gate('before-idb-remove');
  await originalRemove.call(this, id);
  await gate('after-idb-remove');
};
const originalCommit = CheckpointDB.prototype.commit;
CheckpointDB.prototype.commit = async function (record, block) {
  await gate('ledger-callback');
  return originalCommit.call(this, record, block);
};
const originalReconcile = CheckpointDB.prototype.reconcile;
CheckpointDB.prototype.reconcile = async function (record, invalid) {
  await gate('reconcile-callback');
  return originalReconcile.call(this, record, invalid);
};
const directory = FileSystemDirectoryHandle.prototype;
const getDirectory = directory.getDirectoryHandle;
directory.getDirectoryHandle = async function (name, options) {
  if (options?.create && name === RECEIVER_DIRECTORY) await gate('before-parent');
  const result = await getDirectory.call(this, name, options);
  if (options?.create) {
    if (name === RECEIVER_DIRECTORY) await gate('after-parent');
    if (name === transferId) await gate('after-transfer-directory');
    if (name === store?.record?.storageKey) await gate('after-storage-directory');
  }
  return result;
};
const getFile = directory.getFileHandle;
directory.getFileHandle = async function (name, options) {
  fail('file-handle');
  const result = await getFile.call(this, name, options);
  if (options?.create && this.name === store?.record?.storageKey)
    await gate('during-file-creation');
  return result;
};
const removeEntry = directory.removeEntry;
directory.removeEntry = async function (name, options) {
  if (this.name === RECEIVER_DIRECTORY && name === transferId) await gate('before-opfs-remove');
  await removeEntry.call(this, name, options);
  if (this.name === RECEIVER_DIRECTORY && name === transferId) await gate('after-opfs-remove');
};
const createAccess = FileSystemFileHandle.prototype.createSyncAccessHandle;
FileSystemFileHandle.prototype.createSyncAccessHandle = async function () {
  fail('sync-access');
  const access = await createAccess.call(this);
  return new Proxy(access, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            if (key === 'write' || key === 'flush') fail(String(key));
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  });
};
const getRoot = navigator.storage.getDirectory.bind(navigator.storage);
navigator.storage.getDirectory = async () => {
  fail('get-directory');
  return getRoot();
};
const estimate = navigator.storage.estimate.bind(navigator.storage);
navigator.storage.estimate = async () => {
  if (fault === 'capacity') {
    fault = '';
    return { quota: 1, usage: 0 };
  }
  return estimate();
};
async function raw(storeName: string, key: IDBValidKey, mutate: (value: unknown) => unknown) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('meshdrop-checkpoints-v1', 1);
    request.onerror = () => reject(Error('Fixture database unavailable.'));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, 'readwrite');
      const object = tx.objectStore(storeName);
      const reading = object.get(key);
      reading.onsuccess = () => {
        const value = mutate(reading.result);
        object.delete(key);
        if (value !== undefined) object.put(value);
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(Error('Fixture transaction aborted.'));
      };
    };
  });
}
async function run(operation: string, value: unknown): Promise<unknown> {
  const input = value as {
    now: number;
    stage: string;
    manifest: TransferManifest;
    manifests: TransferManifest[];
    retention: RetentionPolicy;
    transferId: string;
    fileId: string;
    bytes: number[];
    digest: string;
    receipt: TransferReceipt;
    error: string;
    expiresAt: number;
    names: string[];
    patch: Record<string, unknown>;
    index: number;
  };
  const db = new CheckpointDB();
  if (operation === 'clock') {
    clock = input.now;
    return null;
  }
  if (operation === 'arm') {
    armed = input.stage;
    catalogReads = 0;
    return null;
  }
  if (operation === 'release') {
    release?.();
    release = null;
    return null;
  }
  if (operation === 'prepare') {
    transferId = input.manifest.transferId;
    store = new OpfsReceiverStore();
    return store.prepare(input.manifest, {
      retention: input.retention ?? '24-hours',
      onStage: gate,
    });
  }
  if (operation === 'commit') {
    await store!.writeBlock(input.fileId, input.index ?? 0, new Uint8Array(input.bytes));
    await store!.commitBlock(input.fileId, input.index ?? 0, input.digest);
    return store!.record;
  }
  if (operation === 'finalize') return (await store!.finalize(input.fileId)).sha256;
  if (operation === 'receipt') {
    await store!.rememberReceipt(input.receipt);
    return null;
  }
  if (operation === 'close') {
    await store?.close();
    await reconciling?.close();
    store = null;
    return null;
  }
  if (operation === 'purge') {
    transferId = input.transferId;
    await purgeStoredTransfer(input.transferId);
    return null;
  }
  if (operation === 'list') return new LedgerReconciler().listAndReconcile();
  if (operation === 'record') return db.get(input.transferId);
  if (operation === 'records') return db.list();
  if (operation === 'fault') {
    fault = input.stage;
    faultName = input.error;
    return null;
  }
  if (operation === 'open-write') {
    store = new OpfsReceiverStore();
    await store.open(input.transferId);
    const checkpoint = await new LedgerReconciler().reconcile(store);
    await store.enableResumeWrites();
    return checkpoint;
  }
  if (operation === 'blocks') return db.blocks(input.transferId);
  if (operation === 'manifest') return db.manifest(input.transferId);
  if (operation === 'source') {
    await db.rememberSource({
      transferId: input.manifest.transferId,
      manifest: input.manifest,
      manifestDigest: digestManifest(input.manifest),
      expiresAt: input.expiresAt,
    });
    return null;
  }
  if (operation === 'forget-source') {
    await db.removeSource(input.transferId);
    return null;
  }
  if (operation === 'sources') return db.sources();
  if (operation === 'patch-record') {
    await raw('transfers', input.transferId, (value) => ({ ...(value as object), ...input.patch }));
    return null;
  }
  if (operation === 'patch-block') {
    await raw('blocks', [input.transferId, input.fileId, input.index ?? 0], (value) => ({
      ...(value as object),
      ...input.patch,
    }));
    return null;
  }
  if (operation === 'delete-record') {
    await raw('transfers', input.transferId, () => undefined);
    return null;
  }
  if (operation === 'patch-source') {
    await raw('sources', input.transferId, (value) => ({ ...(value as object), ...input.patch }));
    return null;
  }
  if (operation === 'lock') {
    locks.set(input.transferId, await acquireStoreLock(input.transferId));
    return null;
  }
  if (operation === 'unlock') {
    await locks.get(input.transferId)?.();
    locks.delete(input.transferId);
    return null;
  }
  if (operation === 'orphan-directories' || operation === 'orphan-file') {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY, { create: true });
    for (const name of input.names) {
      if (operation === 'orphan-file') await parent.getFileHandle(name, { create: true });
      else await parent.getDirectoryHandle(name, { create: true });
    }
    return null;
  }
  if (operation === 'entries') {
    const root = await navigator.storage.getDirectory();
    try {
      const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY);
      const entries = [];
      const iterable = parent as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      for await (const [name, handle] of iterable.entries())
        entries.push({ name, kind: handle.kind });
      return entries;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return [];
      throw error;
    }
  }
  if (
    operation === 'remove-opfs' ||
    operation === 'change-bytes' ||
    operation === 'delete-file' ||
    operation === 'truncate-file'
  ) {
    const record = await db.get(input.transferId);
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY);
    if (operation === 'remove-opfs') {
      await parent.removeEntry(input.transferId, { recursive: true });
      return null;
    }
    const child = await (
      await parent.getDirectoryHandle(input.transferId)
    ).getDirectoryHandle(record!.storageKey);
    if (operation === 'delete-file') {
      await child.removeEntry(input.fileId);
      return null;
    }
    const access = await (await child.getFileHandle(input.fileId)).createSyncAccessHandle();
    try {
      if (operation === 'truncate-file') access.truncate(input.index);
      else access.write(new Uint8Array(input.bytes), { at: input.index ?? 0 });
      access.flush();
    } finally {
      access.close();
    }
    return null;
  }
  if (operation === 'reconcile') {
    const opened = new OpfsReceiverStore();
    reconciling = opened;
    try {
      await opened.open(input.transferId);
      return await new LedgerReconciler().reconcile(opened);
    } finally {
      await opened.close();
      if (reconciling === opened) reconciling = null;
    }
  }
  if (operation === 'seed') {
    for (const manifest of input.manifests) {
      const now = Date.now();
      const record: TransferRecord = {
        schemaVersion: 1,
        transferId: manifest.transferId,
        manifestDigest: digestManifest(manifest),
        storageKey: crypto.randomUUID(),
        blockSize: 1048576,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 86400000,
        retention: '24-hours',
        state: 'interrupted',
        finalizedFiles: [],
        receipt: null,
      };
      await db.create(record, manifest);
    }
    return null;
  }
  throw new Error('Unsupported isolated lifecycle operation.');
}
self.onmessage = (event: MessageEvent<{ id: number; operation: string; payload: unknown }>) => {
  const { id, operation, payload } = event.data;
  void run(operation, payload)
    .then((result) => self.postMessage({ id, ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.name : 'Error',
      }),
    );
};
