/// <reference lib="webworker" />
import { sha256 } from '@noble/hashes/sha2.js';
import { VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { TransferFile } from '@meshdrop/protocol';
import type { SourceEntry } from './HashWorker';
import { blockLength } from './Manifest';

// This is a P3 temporary destination with a volatile commit frontier, not a P4 checkpoint database.
const sources = new Map<string, File>();
const stores = new Map<
  string,
  {
    meta: TransferFile;
    handle: FileSystemFileHandle;
    access: FileSystemSyncAccessHandle;
    nextBlock: number;
    finalized: boolean;
  }
>();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
async function hashFile(file: File): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += VERIFICATION_BLOCK_BYTES)
    hash.update(
      new Uint8Array(await file.slice(offset, offset + VERIFICATION_BLOCK_BYTES).arrayBuffer()),
    );
  return hex(hash.digest());
}
async function run(operation: string, payload: unknown): Promise<unknown> {
  if (operation === 'sources') {
    if (sources.size || stores.size) throw new Error('Worker already owns a transfer.');
    const entries = payload as SourceEntry[];
    const result: TransferFile[] = [];
    for (const entry of entries) {
      sources.set(entry.fileId, entry.file);
      result.push({
        fileId: entry.fileId,
        path: entry.path,
        size: entry.file.size,
        sha256: await hashFile(entry.file),
      });
    }
    return result;
  }
  if (operation === 'source-block') {
    const { fileId, index } = payload as { fileId: string; index: number };
    const file = sources.get(fileId);
    if (!file) throw new Error('Source file unavailable.');
    const length = blockLength(file.size, index);
    const bytes = new Uint8Array(
      await file
        .slice(index * VERIFICATION_BLOCK_BYTES, index * VERIFICATION_BLOCK_BYTES + length)
        .arrayBuffer(),
    );
    if (bytes.length !== length) throw new Error('Source file changed or could not be read.');
    return { bytes, digest: hex(sha256(bytes)) };
  }
  if (operation === 'receiver') {
    if (sources.size || stores.size) throw new Error('Worker already owns a transfer.');
    const { storageKey, files } = payload as { storageKey: string; files: TransferFile[] };
    const estimate = await navigator.storage.estimate();
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (
      estimate.quota !== undefined &&
      estimate.usage !== undefined &&
      estimate.quota - estimate.usage < total + 4 * VERIFICATION_BLOCK_BYTES
    )
      throw new Error('Insufficient browser storage for this transfer.');
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle('meshdrop-p3-sessions', { create: true });
    const directory = await parent.getDirectoryHandle(storageKey, { create: true });
    for (const meta of files) {
      const handle = await directory.getFileHandle(meta.fileId, { create: true });
      if (typeof handle.createSyncAccessHandle !== 'function')
        throw new Error('This browser cannot provide a flushable temporary destination.');
      const access = await handle.createSyncAccessHandle();
      await access.truncate(0);
      stores.set(meta.fileId, { meta, handle, access, nextBlock: 0, finalized: false });
    }
    return null;
  }
  if (operation === 'commit') {
    const { fileId, index, bytes, digest } = payload as {
      fileId: string;
      index: number;
      bytes: Uint8Array<ArrayBuffer>;
      digest: string;
    };
    const store = stores.get(fileId);
    if (
      !store ||
      store.finalized ||
      index !== store.nextBlock ||
      bytes.length !== blockLength(store.meta.size, index)
    )
      throw new Error('Invalid block commit.');
    if (hex(sha256(bytes)) !== digest) throw new Error('Block SHA-256 mismatch.');
    let written = 0;
    while (written < bytes.length) {
      const count = store.access.write(bytes.subarray(written), {
        at: index * VERIFICATION_BLOCK_BYTES + written,
      });
      if (count <= 0) throw new Error('Destination write made no progress.');
      written += count;
    }
    await store.access.flush();
    // The in-session frontier advances only after successful validation, write and flush.
    store.nextBlock++;
    return null;
  }
  if (operation === 'finalize') {
    const { fileId } = payload as { fileId: string };
    const store = stores.get(fileId);
    if (
      !store ||
      store.finalized ||
      store.nextBlock !== Math.ceil(store.meta.size / VERIFICATION_BLOCK_BYTES) ||
      store.access.getSize() !== store.meta.size
    )
      throw new Error('Destination is incomplete.');
    const hash = sha256.create();
    const buffer = new Uint8Array(VERIFICATION_BLOCK_BYTES);
    for (let offset = 0; offset < store.meta.size; offset += buffer.length) {
      const length = Math.min(buffer.length, store.meta.size - offset);
      let read = 0;
      while (read < length) {
        const count = store.access.read(buffer.subarray(read, length), { at: offset + read });
        if (count <= 0) throw new Error('Stored file could not be fully reread.');
        read += count;
      }
      hash.update(buffer.subarray(0, length));
    }
    const actual = hex(hash.digest());
    if (actual !== store.meta.sha256) throw new Error('Stored file SHA-256 mismatch.');
    await store.access.flush();
    await store.access.close();
    store.finalized = true;
    const file = await store.handle.getFile();
    if (file.size !== store.meta.size) throw new Error('Finalized size mismatch.');
    return { file, sha256: actual };
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
      // No file names, paths, keys or source contents in error responses.
      const message =
        error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'Browser storage is full.'
          : error instanceof DOMException
            ? `${error.name}: temporary storage operation failed.`
            : error instanceof Error && !('code' in error)
              ? error.message
              : 'Hash/storage operation failed.';
      self.postMessage({ id, ok: false, error: message });
    })
    .finally(() => {
      busy = false;
    });
};
