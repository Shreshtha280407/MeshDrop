import type { TransferFile, TransferManifest, TransferReceipt } from '@meshdrop/protocol';
import { CheckpointDB, purgeStoredTransfer, StorageFailure } from '@meshdrop/storage';
import type { RetentionPolicy, CapacityResult } from '@meshdrop/storage';

export interface SourceEntry {
  fileId: string;
  path: string;
  file: File;
}
export interface HashStorage {
  prepareSources(entries: SourceEntry[]): Promise<TransferFile[]>;
  sourceBlock(
    fileId: string,
    index: number,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; digest: string }>;
  prepareReceiver(
    storageKey: string,
    files: readonly TransferFile[],
    manifest?: TransferManifest,
    retention?: RetentionPolicy,
  ): Promise<CapacityResult | void>;
  rememberSources?(manifest: TransferManifest, retention: RetentionPolicy): Promise<void>;
  retryCommit?(): Promise<void>;
  rememberReceipt?(receipt: TransferReceipt): Promise<void>;
  commitBlock(
    fileId: string,
    index: number,
    bytes: Uint8Array<ArrayBuffer>,
    digest: string,
  ): Promise<void>;
  finalizeFile(fileId: string): Promise<{ file: File; sha256: string }>;
  dispose(): void;
}
/** Dedicated worker RPC: at most one file/block operation is outstanding. ArrayBuffers are transferred. */
export class HashWorker implements HashStorage {
  private worker: Worker | null;
  private nextId = 0;
  private pending: {
    id: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor() {
    this.worker = new Worker(new URL('./hash-storage.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (
      event: MessageEvent<{
        id: number;
        ok: boolean;
        result?: unknown;
        error?: string;
        code?: string;
      }>,
    ) => {
      if (!this.pending || event.data.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data.result);
      else
        pending.reject(
          new StorageFailure(
            event.data.code === 'quota' ? 'quota' : 'unavailable',
            event.data.error ?? 'Hash/storage worker failed.',
          ),
        );
    };
    this.worker.onerror = () => this.dispose();
  }
  private async request<T>(
    operation: string,
    payload: unknown,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (!this.worker || this.pending) throw new Error('Hash/storage worker is closed or busy.');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending = {
        id,
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(
          () => this.dispose(),
          operation === 'sources' || operation === 'finalize' ? 300000 : 30000,
        ),
      };
      this.worker!.postMessage({ id, operation, payload }, transfer);
    });
  }
  prepareSources(entries: SourceEntry[]): Promise<TransferFile[]> {
    return this.request('sources', entries);
  }
  sourceBlock(
    fileId: string,
    index: number,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; digest: string }> {
    return this.request('source-block', { fileId, index });
  }
  async prepareReceiver(
    storageKey: string,
    _files: readonly TransferFile[],
    manifest?: TransferManifest,
    retention: RetentionPolicy = '24-hours',
  ): Promise<CapacityResult> {
    if (!manifest) throw new Error('A full manifest is required for checkpoint storage.');
    return this.request('receiver', { storageKey, manifest, retention });
  }
  async rememberSources(manifest: TransferManifest, retention: RetentionPolicy): Promise<void> {
    await this.request('remember-sources', { manifest, retention });
  }
  async retryCommit(): Promise<void> {
    await this.request('retry-commit', null);
  }
  async rememberReceipt(receipt: TransferReceipt): Promise<void> {
    await this.request('receipt', receipt);
  }
  async commitBlock(
    fileId: string,
    index: number,
    bytes: Uint8Array<ArrayBuffer>,
    digest: string,
  ): Promise<void> {
    await this.request('commit', { fileId, index, bytes, digest }, [bytes.buffer]);
  }
  finalizeFile(fileId: string): Promise<{ file: File; sha256: string }> {
    return this.request('finalize', { fileId });
  }
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Hash/storage operation stopped.'));
      this.pending = null;
    }
  }
}
export const TEMPORARY_STORE_DIRECTORY = 'meshdrop-p3-sessions';
export async function purgeTemporaryStore(storageKey: string | null): Promise<void> {
  if (!storageKey) return;
  const record = await new CheckpointDB().getByStorageKey(storageKey);
  if (record) {
    // Worker termination releases locks asynchronously; wait briefly for our own worker to exit.
    for (let attempt = 0; ; attempt++)
      try {
        await purgeStoredTransfer(record.transferId);
        break;
      } catch (error) {
        if (!(error instanceof StorageFailure && error.code === 'busy') || attempt >= 20)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    return;
  }
  const root = await navigator.storage.getDirectory();
  try {
    const directory = await root.getDirectoryHandle(TEMPORARY_STORE_DIRECTORY);
    await directory.removeEntry(storageKey, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
}
