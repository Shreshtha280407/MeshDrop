import { z } from 'zod';
import {
  manifestSchema,
  receiptSchema,
  sha256Schema,
  uuidSchema,
  VERIFICATION_BLOCK_BYTES,
} from '@meshdrop/protocol';
import type { TransferManifest } from '@meshdrop/protocol';
import type { BlockRecord, SourceRecord, TransferRecord } from './ReceiverStore';

export const CHECKPOINT_DB = 'meshdrop-checkpoints-v1';
const transferSchema = z.strictObject({
  schemaVersion: z.literal(1),
  transferId: uuidSchema,
  manifestDigest: sha256Schema,
  blockSize: z.literal(VERIFICATION_BLOCK_BYTES),
  storageKey: uuidSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  retention: z.enum(['24-hours', '7-days', 'discard']),
  state: z.enum(['receiving', 'interrupted', 'storage-full', 'complete', 'deleting']),
  finalizedFiles: z.array(uuidSchema).max(16),
  receipt: receiptSchema.nullable(),
});
export const blockRecordSchema = z.strictObject({
  transferId: uuidSchema,
  fileId: uuidSchema,
  index: z.number().int().min(0).max(65535),
  bytes: z.number().int().min(1).max(VERIFICATION_BLOCK_BYTES),
  digest: sha256Schema,
  committedAt: z.number().int().nonnegative(),
});
const sourceSchema = z.strictObject({
  transferId: uuidSchema,
  manifest: manifestSchema,
  manifestDigest: sha256Schema,
  expiresAt: z.number().int().nonnegative(),
});
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
/** Never await crypto/OPFS inside an IDB transaction. Resolve writes only at transaction completion. */
export class CheckpointDB {
  private async open(): Promise<IDBDatabase> {
    const r = indexedDB.open(CHECKPOINT_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('transfers', { keyPath: 'transferId' }).createIndex(
        'storageKey',
        'storageKey',
        { unique: true },
      );
      db.createObjectStore('manifests', { keyPath: 'transferId' });
      db.createObjectStore('blocks', { keyPath: ['transferId', 'fileId', 'index'] }).createIndex(
        'transferId',
        'transferId',
      );
      db.createObjectStore('sources', { keyPath: 'transferId' });
    };
    const db = await request(r);
    db.onversionchange = () => db.close();
    return db;
  }
  private async read<T>(store: string, key?: IDBValidKey): Promise<T> {
    const db = await this.open();
    try {
      const object = db.transaction(store).objectStore(store);
      return (await request(key === undefined ? object.getAll() : object.get(key))) as T;
    } finally {
      db.close();
    }
  }
  private async write(stores: string[], work: (tx: IDBTransaction) => void): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Checkpoint transaction aborted.'));
        tx.onerror = () => {};
        try {
          work(tx);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  }
  async list(): Promise<TransferRecord[]> {
    return (await this.read<unknown[]>('transfers')).map((value) => transferSchema.parse(value));
  }
  async get(id: string): Promise<TransferRecord | null> {
    const value = await this.read<unknown>('transfers', uuidSchema.parse(id));
    return value ? transferSchema.parse(value) : null;
  }
  async getByStorageKey(key: string): Promise<TransferRecord | null> {
    const db = await this.open();
    try {
      const value = await request(
        db
          .transaction('transfers')
          .objectStore('transfers')
          .index('storageKey')
          .get(uuidSchema.parse(key)),
      );
      return value ? transferSchema.parse(value) : null;
    } finally {
      db.close();
    }
  }
  async manifest(id: string): Promise<TransferManifest> {
    return manifestSchema.parse(await this.read('manifests', uuidSchema.parse(id)));
  }
  async blocks(id: string): Promise<BlockRecord[]> {
    const db = await this.open();
    try {
      return (await request(
        db
          .transaction('blocks')
          .objectStore('blocks')
          .index('transferId')
          .getAll(uuidSchema.parse(id)),
      )) as BlockRecord[];
    } finally {
      db.close();
    }
  }
  async create(record: TransferRecord, manifest: TransferManifest): Promise<void> {
    transferSchema.parse(record);
    manifestSchema.parse(manifest);
    await this.write(['transfers', 'manifests'], (tx) => {
      tx.objectStore('transfers').add(record);
      tx.objectStore('manifests').add(manifest);
    });
  }
  async put(record: TransferRecord): Promise<void> {
    transferSchema.parse(record);
    await this.write(['transfers'], (tx) => {
      tx.objectStore('transfers').put(record);
    });
  }
  async commit(record: TransferRecord, block: BlockRecord): Promise<void> {
    transferSchema.parse(record);
    blockRecordSchema.parse(block);
    await this.write(['transfers', 'blocks'], (tx) => {
      tx.objectStore('blocks').put(block);
      tx.objectStore('transfers').put(record);
    });
  }
  async reconcile(record: TransferRecord, invalid: BlockRecord[]): Promise<void> {
    transferSchema.parse(record);
    await this.write(['transfers', 'blocks'], (tx) => {
      for (const block of invalid)
        tx.objectStore('blocks').delete([record.transferId, block.fileId, block.index]);
      tx.objectStore('transfers').put(record);
    });
  }
  async remove(id: string): Promise<void> {
    uuidSchema.parse(id);
    await this.write(['transfers', 'manifests', 'blocks'], (tx) => {
      tx.objectStore('transfers').delete(id);
      tx.objectStore('manifests').delete(id);
      const cursor = tx
        .objectStore('blocks')
        .index('transferId')
        .openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          tx.objectStore('blocks').delete(c.primaryKey);
          c.continue();
        }
      };
    });
  }
  async rememberSource(record: SourceRecord): Promise<void> {
    sourceSchema.parse(record);
    await this.write(['sources'], (tx) => {
      tx.objectStore('sources').put(record);
    });
  }
  async sources(): Promise<SourceRecord[]> {
    return (await this.read<unknown[]>('sources')).map((value) => sourceSchema.parse(value));
  }
  async removeSource(id: string): Promise<void> {
    uuidSchema.parse(id);
    await this.write(['sources'], (tx) => {
      tx.objectStore('sources').delete(id);
    });
  }
}
