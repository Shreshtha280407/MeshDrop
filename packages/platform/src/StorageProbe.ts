import type { StorageProbe } from './CapabilityProbe';

interface SyncAccess {
  write(value: Uint8Array, options: { at: number }): number;
  read(value: Uint8Array, options: { at: number }): number;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Worker-only, isolated one-byte round trips; never touches transfer storage. */
export async function probeStorageApis(): Promise<StorageProbe> {
  const result: StorageProbe = {
    worker: 'available',
    opfs: typeof navigator.storage?.getDirectory === 'function' ? 'unavailable' : 'unsupported',
    checkpointDb: typeof indexedDB === 'undefined' ? 'unsupported' : 'unavailable',
    exclusiveAccess: false,
  };
  let name: string;
  try {
    name = `meshdrop-probe-${crypto.randomUUID()}`;
  } catch {
    return result;
  }
  let root: FileSystemDirectoryHandle | undefined;
  let opfsUsable = false;
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
    } finally {
      // Some older implementations return promises. Finalization must succeed too.
      await access.close();
    }
    opfsUsable = true;
  } catch {
    /* API presence is not successful file I/O. */
  } finally {
    if (root)
      try {
        await root.removeEntry(name);
      } catch {
        opfsUsable = false;
      }
  }
  if (opfsUsable) result.opfs = 'available';

  let db: IDBDatabase | undefined;
  let checkpointUsable = false;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('probe');
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = open.onblocked = () => reject(new Error('Probe database unavailable.'));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('probe', 'readwrite', { durability: 'strict' });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => {};
      tx.objectStore('probe').put(71, 'test');
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('probe', 'readonly');
      let exact = false;
      tx.oncomplete = () =>
        exact ? resolve() : reject(new Error('Probe checkpoint readback failed.'));
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => {};
      const request = tx.objectStore('probe').get('test');
      request.onsuccess = () => {
        exact = request.result === 71;
      };
      request.onerror = () => reject(request.error);
    });
    db.close();
    db = undefined;
    checkpointUsable = true;
  } catch {
    /* A committed write and an exact read are both required. */
  } finally {
    try {
      db?.close();
    } catch {
      checkpointUsable = false;
    }
    if (typeof indexedDB !== 'undefined') {
      const deleted = await new Promise<boolean>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve(true);
        request.onerror = request.onblocked = () => resolve(false);
      }).catch(() => false);
      if (!deleted) checkpointUsable = false;
    }
  }
  if (checkpointUsable) result.checkpointDb = 'available';
  try {
    await navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      result.exclusiveAccess = Boolean(lock);
    });
  } catch {
    /* Unsupported or denied; recovery cannot claim exclusive storage access. */
  }
  return result;
}
