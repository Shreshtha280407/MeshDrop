import type { TransferEvent, TransferState } from '@meshdrop/protocol';

/** Implemented in P3; progress is receiver-committed bytes, never queued sends. */
export interface TransferProgress {
  readonly transferId: string;
  readonly totalBytes: number;
  readonly committedBytes: number;
  readonly state: TransferState;
}
export interface TransferEngine {
  readonly progress: TransferProgress;
  dispatch(event: TransferEvent): void;
  onProgress(listener: (progress: TransferProgress) => void): () => void;
  cancel(): Promise<void>;
}
