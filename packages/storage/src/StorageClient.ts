import { StorageFailure } from './ReceiverStore';
import type { RecoveryListing } from './ReceiverStore';
/** Local worker only; no network, credentials or file bytes go to the signaling server. */
export class StorageClient {
  private readonly worker: Worker;
  private disposed = false;
  private pending: {
    id: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private next = 0;
  constructor() {
    this.worker = new Worker(new URL('./recovery.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (
      event: MessageEvent<{ id: number; ok: boolean; result?: unknown; code?: string }>,
    ) => {
      if (!this.pending || this.pending.id !== event.data.id) return;
      const current = this.pending;
      this.pending = null;
      clearTimeout(current.timer);
      if (event.data.ok) current.resolve(event.data.result);
      else
        current.reject(
          new StorageFailure(
            event.data.code === 'busy' ||
              event.data.code === 'quota' ||
              event.data.code === 'integrity'
              ? event.data.code
              : 'unavailable',
            'Local storage operation failed. Check browser support, free space and whether this transfer is open in another tab.',
          ),
        );
    };
    this.worker.onerror = () => this.dispose();
  }
  private request<T>(operation: string, payload: unknown): Promise<T> {
    if (this.disposed)
      return Promise.reject(new StorageFailure('unavailable', 'Local storage client is closed.'));
    if (this.pending)
      return Promise.reject(new Error('Another local storage operation is running.'));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.pending = {
        id,
        resolve: (value) => resolve(value as T),
        reject,
        timer: setTimeout(() => this.dispose(), 300000),
      };
      try {
        this.worker.postMessage({ id, operation, payload });
      } catch {
        clearTimeout(this.pending.timer);
        this.pending = null;
        reject(new StorageFailure('unavailable', 'Local storage operation could not start.'));
      }
    });
  }
  list(): Promise<RecoveryListing> {
    return this.request('list', null);
  }
  purge(transferId: string): Promise<void> {
    return this.request('purge', { transferId });
  }
  removeSource(transferId: string): Promise<void> {
    return this.request('remove-source', { transferId });
  }
  exportFile(transferId: string, fileId: string): Promise<File> {
    return this.request('export', { transferId, fileId });
  }
  verifySource(
    transferId: string,
    fileId: string,
    file: File,
  ): Promise<{ sha256: string; fileId: string }> {
    return this.request('reselect', { transferId, fileId, file });
  }
  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Local storage check stopped.'));
      this.pending = null;
    }
  }
}
