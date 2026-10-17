import {
  manifestSchema,
  receiptSchema,
  uuidSchema,
  VERIFICATION_BLOCK_BYTES,
} from '@meshdrop/protocol';
import type { TransferManifest, TransferReceipt } from '@meshdrop/protocol';
import { CheckpointDB } from './CheckpointDB';
import { acquireStoreLock } from './locks';
import { digestBytes, digestManifest, hashLocalFile, storedBlockLength } from './integrity';
import { estimateCapacity } from './QuotaManager';
import { StorageFailure, retentionExpiry } from './ReceiverStore';
import type { CapacityResult, ReceiverStore, StoreOptions, TransferRecord } from './ReceiverStore';

export const RECEIVER_DIRECTORY = 'meshdrop-receiver-v1';
const missing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';
// Sync access is worker-only and absent from main-thread lib.dom declarations.
interface SyncAccess {
  read(bytes: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  write(bytes: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  getSize(): number;
  truncate(size: number): void | Promise<void>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccess> };
export class OpfsReceiverStore implements ReceiverStore {
  readonly db = new CheckpointDB();
  manifest!: TransferManifest;
  record!: TransferRecord;
  private options: StoreOptions = {};
  private directory: FileSystemDirectoryHandle | null = null;
  private release: (() => Promise<void>) | null = null;
  private readonly handles = new Map<
    string,
    { handle: FileSystemFileHandle; access: SyncAccess }
  >();
  private readonly committed = new Set<string>();
  private pending: { fileId: string; index: number } | null = null;
  async prepare(input: TransferManifest, options: StoreOptions = {}): Promise<CapacityResult> {
    if (this.release) throw new Error('Store already open.');
    const manifest = manifestSchema.parse(input);
    const capacity = await estimateCapacity(manifest.totalBytes);
    if (!capacity.available)
      throw new StorageFailure('quota', capacity.warnings.at(-1) ?? 'Storage is unavailable.');
    this.release = await acquireStoreLock(manifest.transferId);
    this.options = options;
    try {
      if (await this.db.get(manifest.transferId))
        throw new Error('A checkpoint with this transfer ID already exists.');
      if ((await this.db.list()).length >= 64)
        throw new Error('Clear saved transfers before accepting more files.');
      this.manifest = manifest;
      const now = Date.now();
      const retention = options.retention ?? '24-hours';
      this.record = {
        schemaVersion: 1,
        transferId: manifest.transferId,
        manifestDigest: digestManifest(manifest),
        blockSize: VERIFICATION_BLOCK_BYTES,
        storageKey: uuidSchema.parse(options.storageKey ?? crypto.randomUUID()),
        createdAt: now,
        updatedAt: now,
        expiresAt: retentionExpiry(retention, now),
        retention,
        state: 'receiving',
        finalizedFiles: [],
        receipt: null,
      };
      // Metadata first makes even a crash during directory creation discoverable.
      await this.db.create(this.record, manifest);
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY, { create: true });
      const transfer = await parent.getDirectoryHandle(manifest.transferId, { create: true });
      this.directory = await transfer.getDirectoryHandle(this.record.storageKey, { create: true });
      for (const file of manifest.files) {
        const handle = await this.directory.getFileHandle(file.fileId, { create: true });
        const access = await (handle as SyncFileHandle).createSyncAccessHandle();
        await access.truncate(0);
        this.handles.set(file.fileId, { handle, access });
      }
      return capacity;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async open(transferId: string): Promise<void> {
    this.release = await acquireStoreLock(transferId);
    try {
      const record = await this.db.get(transferId);
      if (!record || record.state === 'deleting')
        throw new Error('Checkpoint is missing or being deleted.');
      const manifest = await this.db.manifest(transferId);
      if (
        manifest.transferId !== record.transferId ||
        digestManifest(manifest) !== record.manifestDigest
      )
        throw new StorageFailure('integrity', 'Checkpoint manifest is damaged.');
      this.record = record;
      this.manifest = manifest;
      try {
        const root = await navigator.storage.getDirectory();
        const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY);
        this.directory = await (
          await parent.getDirectoryHandle(transferId)
        ).getDirectoryHandle(record.storageKey);
      } catch (error) {
        if (!missing(error)) throw error;
        this.directory = null;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private meta(fileId: string) {
    if (!this.release) throw new Error('Store is closed.');
    const meta = this.manifest.files.find((file) => file.fileId === fileId);
    if (!meta) throw new Error('File outside manifest.');
    return meta;
  }
  private async handle(fileId: string) {
    this.meta(fileId);
    let entry = this.handles.get(fileId);
    if (!entry) {
      if (!this.directory) throw new DOMException('Stored file unavailable.', 'NotFoundError');
      const handle = await this.directory.getFileHandle(fileId);
      entry = { handle, access: await (handle as SyncFileHandle).createSyncAccessHandle() };
      this.handles.set(fileId, entry);
    }
    return entry;
  }
  /** Recreate only missing scoped files after reconciliation, and prohibit overwriting reused blocks. */
  async enableResumeWrites(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY, { create: true });
    const directory = await parent.getDirectoryHandle(this.manifest.transferId, { create: true });
    this.directory = await directory.getDirectoryHandle(this.record.storageKey, { create: true });
    for (const file of this.manifest.files)
      await this.directory.getFileHandle(file.fileId, { create: true });
    this.committed.clear();
    for (const block of await this.db.blocks(this.record.transferId))
      this.committed.add(`${block.fileId}:${block.index}`);
  }
  async writeBlock(fileId: string, index: number, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const meta = this.meta(fileId);
    if (
      bytes.length !== storedBlockLength(meta.size, index) ||
      this.committed.has(`${fileId}:${index}`) ||
      this.record.finalizedFiles.includes(fileId)
    )
      throw new Error('Invalid or duplicate block write.');
    if (this.pending && (this.pending.fileId !== fileId || this.pending.index !== index))
      throw new Error('Only one pending block is permitted.');
    this.pending = { fileId, index };
    const { access } = await this.handle(fileId);
    let written = 0;
    while (written < bytes.length) {
      const n = access.write(bytes.subarray(written), {
        at: index * VERIFICATION_BLOCK_BYTES + written,
      });
      if (n <= 0) throw new Error('Storage write made no progress.');
      written += n;
    }
    await this.options.onStage?.('after-write');
  }
  async readBlock(fileId: string, index: number): Promise<Uint8Array<ArrayBuffer>> {
    const length = storedBlockLength(this.meta(fileId).size, index);
    const { access } = await this.handle(fileId);
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = access.read(bytes.subarray(read), { at: index * VERIFICATION_BLOCK_BYTES + read });
      if (n <= 0) throw new Error('Stored block is missing or truncated.');
      read += n;
    }
    return bytes;
  }
  async commitBlock(fileId: string, index: number, digest: string): Promise<void> {
    if (!this.pending || this.pending.fileId !== fileId || this.pending.index !== index)
      throw new Error('No matching pending write.');
    const bytes = await this.readBlock(fileId, index);
    if (digestBytes(bytes) !== digest)
      throw new StorageFailure('integrity', 'Written block SHA-256 mismatch.');
    await this.options.onStage?.('after-digest');
    await (await this.handle(fileId)).access.flush();
    await this.options.onStage?.('after-flush');
    const now = Date.now();
    const next = {
      ...this.record,
      updatedAt: now,
      expiresAt: retentionExpiry(this.record.retention, now),
      state: 'receiving' as const,
      checkpointDigest: undefined,
    };
    await this.options.onStage?.('before-ledger');
    await this.db.commit(next, {
      transferId: next.transferId,
      fileId,
      index,
      bytes: bytes.length,
      digest,
      committedAt: now,
    });
    this.record = next;
    this.committed.add(`${fileId}:${index}`);
    this.pending = null;
    await this.options.onStage?.('after-ledger');
  }
  async fileSize(fileId: string): Promise<number> {
    return (await this.handle(fileId)).access.getSize();
  }
  async truncateTail(fileId: string, end: number): Promise<void> {
    const { access } = await this.handle(fileId);
    if (access.getSize() > end) {
      await access.truncate(end);
      await access.flush();
    }
  }
  async verifyFile(fileId: string): Promise<{ file: File; sha256: string }> {
    const meta = this.meta(fileId);
    const entry = await this.handle(fileId);
    if (entry.access.getSize() !== meta.size) throw new Error('Stored file has the wrong size.');
    await entry.access.flush();
    await entry.access.close();
    this.handles.delete(fileId);
    const file = await entry.handle.getFile();
    const digest = await hashLocalFile(file);
    if (digest !== meta.sha256)
      throw new StorageFailure('integrity', 'Complete stored file SHA-256 mismatch.');
    return { file, sha256: digest };
  }
  async finalize(fileId: string): Promise<{ file: File; sha256: string }> {
    const meta = this.meta(fileId);
    const blocks = await this.db.blocks(this.record.transferId);
    const records = blocks.filter((block) => block.fileId === fileId);
    if (
      records.length !== Math.ceil(meta.size / VERIFICATION_BLOCK_BYTES) ||
      records.some((block) => block.bytes !== storedBlockLength(meta.size, block.index))
    )
      throw new Error('File has uncommitted blocks.');
    const result = await this.verifyFile(fileId);
    const next = {
      ...this.record,
      updatedAt: Date.now(),
      finalizedFiles: [...new Set([...this.record.finalizedFiles, fileId])],
    };
    await this.db.put(next);
    this.record = next;
    return result;
  }
  async rememberReceipt(input: TransferReceipt): Promise<void> {
    const receipt = receiptSchema.parse(input);
    if (
      receipt.transferId !== this.record.transferId ||
      receipt.manifestDigest !== this.record.manifestDigest ||
      JSON.stringify(receipt.files) !== JSON.stringify(this.manifest.files) ||
      receipt.totalBytes !== this.manifest.totalBytes ||
      this.record.finalizedFiles.length !== this.manifest.files.length
    )
      throw new Error('Receipt does not match finalized storage.');
    const next = { ...this.record, state: 'complete' as const, receipt, updatedAt: Date.now() };
    await this.db.put(next);
    this.record = next;
  }
  async close(): Promise<void> {
    for (const entry of this.handles.values()) {
      try {
        await entry.access.close();
      } catch {
        /* A terminated worker may already have closed the handle. */
      }
    }
    this.handles.clear();
    const release = this.release;
    this.release = null;
    if (release) await release();
  }
  async purge(transferId: string): Promise<void> {
    await this.close();
    await purgeStoredTransfer(transferId);
  }
}
/** Tombstone before OPFS deletion, then remove ledger. A crash leaves a retryable deletion. */
export async function purgeStoredTransfer(transferId: string): Promise<void> {
  const release = await acquireStoreLock(transferId);
  const db = new CheckpointDB();
  try {
    const record = await db.get(transferId);
    if (!record) return;
    await db.put({ ...record, state: 'deleting', updatedAt: Date.now() });
    try {
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle(RECEIVER_DIRECTORY);
      const transfer = await parent.getDirectoryHandle(transferId);
      await transfer.removeEntry(record.storageKey, { recursive: true });
      // The validated transfer directory belongs to this record and contains no external paths.
      await parent.removeEntry(transferId, { recursive: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    await db.remove(transferId);
  } finally {
    await release();
  }
}
