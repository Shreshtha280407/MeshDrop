import { vi } from 'vitest';
import { CheckpointDB } from '../../packages/storage/src/CheckpointDB';
import type {
  BlockRecord,
  SourceRecord,
  TransferRecord,
} from '../../packages/storage/src/ReceiverStore';
import type { TransferManifest } from '@meshdrop/protocol';

// API simulation for seeded schedules. Real IDB transactions, worker termination
// and cross-tab locks are verified separately by the browser lifecycle suite.
class MemoryFile {
  readonly kind = 'file';
  bytes = new Uint8Array(0);
  busy = false;
  constructor(
    readonly name: string,
    private readonly env: StorageModel,
  ) {}
  async getFile() {
    return new File([new Uint8Array(this.bytes)], this.name);
  }
  async createSyncAccessHandle() {
    if (this.busy) throw new DOMException('Fixture busy.', 'NoModificationAllowedError');
    this.busy = true;
    let closed = false;
    const current = () => {
      if (closed) throw new DOMException('Fixture closed.', 'InvalidStateError');
    };
    return {
      getSize: () => {
        current();
        return this.bytes.length;
      },
      read: (target: Uint8Array, { at }: { at: number }) => {
        current();
        const bytes = this.bytes.subarray(at, at + target.length);
        target.set(bytes);
        return bytes.length;
      },
      write: (input: Uint8Array, { at }: { at: number }) => {
        current();
        if (this.env.quota) {
          this.env.quota = false;
          throw new DOMException('Fixture quota.', 'QuotaExceededError');
        }
        const next = new Uint8Array(Math.max(this.bytes.length, at + input.length));
        next.set(this.bytes);
        next.set(input, at);
        this.bytes = next;
        return input.length;
      },
      truncate: (length: number) => {
        current();
        const next = new Uint8Array(length);
        next.set(this.bytes.subarray(0, length));
        this.bytes = next;
      },
      flush: () => {
        current();
      },
      close: () => {
        closed = true;
        this.busy = false;
      },
    };
  }
}
export class MemoryDirectory {
  readonly kind = 'directory';
  readonly children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(
    readonly name: string,
    private readonly env: StorageModel,
  ) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let value = this.children.get(name);
    if (!value && options?.create) {
      value = new MemoryDirectory(name, this.env);
      this.children.set(name, value);
    }
    if (!value) throw new DOMException('Fixture missing.', 'NotFoundError');
    if (value.kind !== 'directory')
      throw new DOMException('Fixture kind mismatch.', 'TypeMismatchError');
    return value;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let value = this.children.get(name);
    if (!value && options?.create) {
      value = new MemoryFile(name, this.env);
      this.children.set(name, value);
    }
    if (!value) throw new DOMException('Fixture missing.', 'NotFoundError');
    if (value.kind !== 'file')
      throw new DOMException('Fixture kind mismatch.', 'TypeMismatchError');
    return value;
  }
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException('Fixture missing.', 'NotFoundError');
  }
  async *entries() {
    yield* this.children.entries();
  }
}
const copy = <T>(value: T): T => structuredClone(value);
const blockKey = (b: BlockRecord) => [b.transferId, b.fileId, b.index].join(':');
export class StorageModel {
  now = 2000000000000;
  quota = false;
  readonly root = new MemoryDirectory('', this);
  readonly records = new Map<string, TransferRecord>();
  readonly manifests = new Map<string, TransferManifest>();
  readonly blocks = new Map<string, BlockRecord>();
  readonly sources = new Map<string, SourceRecord>();
  readonly locks = new Set<string>();
  install() {
    vi.spyOn(Date, 'now').mockImplementation(() => this.now);
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => this.root,
        estimate: async () => ({ quota: 1e9, usage: 0 }),
        persisted: async () => false,
      },
      locks: {
        request: async (
          name: string,
          _options: unknown,
          callback: (lock: object | null) => Promise<void>,
        ) => {
          if (this.locks.has(name)) return callback(null);
          this.locks.add(name);
          try {
            await callback({ name });
          } finally {
            this.locks.delete(name);
          }
        },
      },
    });
    const db = CheckpointDB.prototype;
    vi.spyOn(db, 'get').mockImplementation(async (id) => copy(this.records.get(id) ?? null));
    vi.spyOn(db, 'list').mockImplementation(async () => copy([...this.records.values()]));
    vi.spyOn(db, 'catalogIssues').mockImplementation(async () => []);
    vi.spyOn(db, 'manifest').mockImplementation(async (id) => copy(this.manifests.get(id)!));
    vi.spyOn(db, 'blocks').mockImplementation(async (id) =>
      copy([...this.blocks.values()].filter((b) => b.transferId === id)),
    );
    vi.spyOn(db, 'create').mockImplementation(async (record, manifest) => {
      if (this.records.has(record.transferId)) throw Error('Fixture duplicate.');
      this.records.set(record.transferId, copy(record));
      this.manifests.set(record.transferId, copy(manifest));
    });
    vi.spyOn(db, 'put').mockImplementation(async (record) => {
      this.records.set(record.transferId, copy(record));
    });
    vi.spyOn(db, 'markDeleting').mockImplementation(async (id, mode) => {
      const record = this.records.get(id);
      if (!record) return false;
      if (
        mode === 'retention' &&
        record.state !== 'deleting' &&
        record.retention !== 'discard' &&
        record.expiresAt > this.now
      )
        return false;
      this.records.set(id, { ...record, state: 'deleting', updatedAt: this.now });
      return true;
    });
    vi.spyOn(db, 'pendingDeletions').mockImplementation(async () =>
      [...this.records.values()].filter((r) => r.state === 'deleting').map((r) => r.transferId),
    );
    vi.spyOn(db, 'commit').mockImplementation(async (record, block) => {
      this.records.set(record.transferId, copy(record));
      this.blocks.set(blockKey(block), copy(block));
    });
    vi.spyOn(db, 'reconcile').mockImplementation(async (record, invalid) => {
      this.records.set(record.transferId, copy(record));
      for (const block of invalid) this.blocks.delete(blockKey(block));
    });
    vi.spyOn(db, 'remove').mockImplementation(async (id) => {
      this.records.delete(id);
      this.manifests.delete(id);
      for (const [key, block] of this.blocks) if (block.transferId === id) this.blocks.delete(key);
    });
    vi.spyOn(db, 'orphanIds').mockImplementation(async () =>
      [
        ...new Set([
          ...this.manifests.keys(),
          ...[...this.blocks.values()].map((b) => b.transferId),
        ]),
      ]
        .filter((id) => !this.records.has(id))
        .slice(0, 128),
    );
    vi.spyOn(db, 'rememberSource').mockImplementation(async (source) => {
      this.sources.set(source.transferId, copy(source));
    });
    vi.spyOn(db, 'sources').mockImplementation(async () => copy([...this.sources.values()]));
    vi.spyOn(db, 'removeSource').mockImplementation(async (id, mode) => {
      const record = this.sources.get(id);
      if (mode === 'retention' && (!record || record.expiresAt > this.now)) return false;
      return this.sources.delete(id);
    });
  }
  async file(record: TransferRecord, fileId: string) {
    return (
      await (
        await (
          await this.root.getDirectoryHandle('meshdrop-receiver-v1')
        ).getDirectoryHandle(record.transferId)
      ).getDirectoryHandle(record.storageKey)
    ).getFileHandle(fileId);
  }
}
