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
export const MAX_CHECKPOINTS = 64;
export const MAX_SOURCE_MANIFESTS = 32;
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
  checkpointDigest: sha256Schema.optional(),
  lastResume: z
    .strictObject({
      roomId: uuidSchema,
      epoch: z.number().int().min(1).max(0xffffffff),
      attemptId: uuidSchema,
      checkpointDigest: sha256Schema,
      reusedBytes: z.number().int().nonnegative(),
    })
    .optional(),
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
    return (await this.read<unknown[]>('transfers')).flatMap((value) => {
      const parsed = transferSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async catalogIssues(
    store: 'transfers' | 'sources',
  ): Promise<{ transferId: string; reason: string; kind: 'receiver' | 'source' }[]> {
    const schema = store === 'transfers' ? transferSchema : sourceSchema;
    return (await this.read<unknown[]>(store)).flatMap((value) => {
      if (schema.safeParse(value).success) return [];
      const id = uuidSchema.safeParse((value as { transferId?: unknown } | null)?.transferId);
      return [
        {
          transferId: id.success ? id.data : 'local-storage',
          kind: store === 'sources' ? ('source' as const) : ('receiver' as const),
          reason:
            store === 'sources' ? 'Source metadata is damaged.' : 'Checkpoint metadata is damaged.',
        },
      ];
    });
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
      // Count and insertion must share a transaction across independent tabs.
      const count = tx.objectStore('transfers').count();
      count.onsuccess = () => {
        if (count.result >= MAX_CHECKPOINTS) {
          tx.abort();
          return;
        }
        tx.objectStore('transfers').add(record);
        tx.objectStore('manifests').add(manifest);
      };
    });
  }
  /** Updates cannot recreate deleted records or overwrite a new incarnation. */
  private async update(
    record: TransferRecord,
    stores: string[],
    work: (tx: IDBTransaction) => void,
  ): Promise<void> {
    transferSchema.parse(record);
    await this.write(['transfers', ...stores], (tx) => {
      const reading = tx.objectStore('transfers').get(record.transferId);
      reading.onsuccess = () => {
        try {
          const current = transferSchema.parse(reading.result);
          if (
            current.storageKey !== record.storageKey ||
            current.manifestDigest !== record.manifestDigest ||
            current.createdAt !== record.createdAt ||
            (current.state === 'deleting' && record.state !== 'deleting')
          ) {
            tx.abort();
            return;
          }
          work(tx);
          tx.objectStore('transfers').put(record);
        } catch {
          tx.abort();
        }
      };
    });
  }
  async put(record: TransferRecord): Promise<void> {
    await this.update(record, [], () => {});
  }
  /** Explicit deletion needs only the locked UUID, even if other metadata is damaged. */
  async markDeleting(id: string, mode: 'explicit' | 'retention' = 'explicit'): Promise<boolean> {
    uuidSchema.parse(id);
    let marked = false;
    await this.write(['transfers'], (tx) => {
      const store = tx.objectStore('transfers');
      const reading = store.get(id);
      reading.onsuccess = () => {
        const raw = reading.result as Record<string, unknown> | undefined;
        if (!raw) return;
        if (mode === 'retention' && raw.state !== 'deleting') {
          const parsed = transferSchema.safeParse(raw);
          if (
            !parsed.success ||
            (parsed.data.retention !== 'discard' && parsed.data.expiresAt > Date.now())
          )
            return;
        }
        store.put({ ...raw, state: 'deleting', updatedAt: Date.now() });
        marked = true;
      };
    });
    return marked;
  }
  async pendingDeletions(): Promise<string[]> {
    return (await this.read<unknown[]>('transfers')).flatMap((value) => {
      const raw = value as { transferId?: unknown; state?: unknown } | null;
      const id = uuidSchema.safeParse(raw?.transferId);
      return raw?.state === 'deleting' && id.success ? [id.data] : [];
    });
  }
  async commit(record: TransferRecord, block: BlockRecord): Promise<void> {
    transferSchema.parse(record);
    blockRecordSchema.parse(block);
    await this.update(record, ['blocks'], (tx) => {
      tx.objectStore('blocks').put(block);
    });
  }
  async reconcile(record: TransferRecord, invalid: BlockRecord[]): Promise<void> {
    transferSchema.parse(record);
    await this.update(record, ['blocks'], (tx) => {
      for (const block of invalid)
        tx.objectStore('blocks').delete([record.transferId, block.fileId, block.index]);
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
  /** Stream distinct metadata keys; do not load every block row to discover orphans. */
  async orphanIds(limit = 128): Promise<string[]> {
    const db = await this.open();
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction(['transfers', 'manifests', 'blocks']);
        const ids = new Set<string>();
        tx.oncomplete = () => resolve([...ids]);
        tx.onabort = () => reject(tx.error ?? new Error('Metadata inspection failed.'));
        const keys = tx.objectStore('transfers').getAllKeys();
        keys.onsuccess = () => {
          const known = new Set(keys.result);
          for (const cursor of [
            tx.objectStore('manifests').openKeyCursor(),
            tx.objectStore('blocks').index('transferId').openKeyCursor(null, 'nextunique'),
          ])
            cursor.onsuccess = () => {
              const value = cursor.result;
              if (!value || ids.size >= limit) return;
              const parsed = uuidSchema.safeParse(value.key);
              if (parsed.success && !known.has(parsed.data)) ids.add(parsed.data);
              value.continue();
            };
        };
      });
    } finally {
      db.close();
    }
  }
  async rememberSource(record: SourceRecord): Promise<void> {
    sourceSchema.parse(record);
    await this.write(['sources'], (tx) => {
      const object = tx.objectStore('sources');
      const reading = object.getAll();
      reading.onsuccess = () => {
        try {
          const old = (reading.result as unknown[])
            .map((value) => sourceSchema.parse(value))
            .filter((value) => value.transferId !== record.transferId)
            .sort((a, b) => a.expiresAt - b.expiresAt);
          for (const value of old.slice(0, Math.max(0, old.length - MAX_SOURCE_MANIFESTS + 1)))
            object.delete(value.transferId);
          object.put(record);
        } catch {
          tx.abort();
        }
      };
    });
  }
  async sources(): Promise<SourceRecord[]> {
    return (await this.read<unknown[]>('sources')).flatMap((value) => {
      const parsed = sourceSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async removeSource(id: string, mode: 'explicit' | 'retention' = 'explicit'): Promise<boolean> {
    uuidSchema.parse(id);
    let removed = false;
    await this.write(['sources'], (tx) => {
      const object = tx.objectStore('sources');
      if (mode === 'explicit') {
        object.delete(id);
        removed = true;
        return;
      }
      const reading = object.get(id);
      reading.onsuccess = () => {
        const parsed = sourceSchema.safeParse(reading.result);
        if (parsed.success && parsed.data.expiresAt <= Date.now()) {
          object.delete(id);
          removed = true;
        }
      };
    });
    return removed;
  }
}
