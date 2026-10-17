import type { StorageProbe } from './CapabilityProbe';
interface SyncAccess {
  write(value: Uint8Array, options: { at: number }): number;
  read(value: Uint8Array, options: { at: number }): number;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}
self.onmessage = async () => {
  const result: StorageProbe = {
    opfs: typeof navigator.storage?.getDirectory === 'function' ? 'unavailable' : 'unsupported',
    checkpointDb: typeof indexedDB === 'undefined' ? 'unsupported' : 'unavailable',
    exclusiveAccess: false,
  };
  const name = `meshdrop-probe-${crypto.randomUUID()}`;
  let root: FileSystemDirectoryHandle | undefined;
  try {
    root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle(name, { create: true });
    const access = await (
      file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> }
    ).createSyncAccessHandle();
    try {
      const output = new Uint8Array(1);
      if (access.write(new Uint8Array([71]), { at: 0 }) !== 1)
        throw new Error('Probe write failed.');
      await access.flush();
      if (access.read(output, { at: 0 }) !== 1 || output[0] !== 71)
        throw new Error('Probe read failed.');
      result.opfs = 'available';
    } finally {
      await access.close();
    }
  } catch {
    /* Report usable storage, not API presence. */
  } finally {
    await root?.removeEntry(name).catch(() => {});
  }
  let db: IDBDatabase | undefined;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('probe');
    db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('probe', 'readwrite');
      tx.objectStore('probe').put(71, 'test');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => {};
    });
    result.checkpointDb = 'available';
  } catch {
    /* Probe failures never create transfer progress. */
  } finally {
    db?.close();
    if (typeof indexedDB !== 'undefined')
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
  }
  try {
    await navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      result.exclusiveAccess = Boolean(lock);
    });
  } catch {
    /* Unsupported or denied. */
  }
  self.postMessage(result);
};
