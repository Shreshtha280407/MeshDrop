import type { TransferFile } from '@meshdrop/protocol';

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
  prepareReceiver(storageKey: string, files: readonly TransferFile[]): Promise<void>;
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
      event: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>,
    ) => {
      if (!this.pending || event.data.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data.result);
      else pending.reject(new Error(event.data.error ?? 'Hash/storage worker failed.'));
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
  async prepareReceiver(storageKey: string, files: readonly TransferFile[]): Promise<void> {
    await this.request('receiver', { storageKey, files });
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
  const root = await navigator.storage.getDirectory();
  try {
    const directory = await root.getDirectoryHandle(TEMPORARY_STORE_DIRECTORY);
    await directory.removeEntry(storageKey, { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
}
