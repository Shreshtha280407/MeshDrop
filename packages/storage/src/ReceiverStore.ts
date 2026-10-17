import type { TransferManifest, TransferReceipt } from '@meshdrop/protocol';

export type RetentionPolicy = '24-hours' | '7-days' | 'discard';
export type StorageState = 'receiving' | 'interrupted' | 'storage-full' | 'complete' | 'deleting';
export interface CapacityResult {
  available: boolean;
  estimatedFreeBytes: number | null;
  persistent: boolean;
  warnings: string[];
}
export interface TransferRecord {
  schemaVersion: 1;
  transferId: string;
  manifestDigest: string;
  blockSize: number;
  storageKey: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  retention: RetentionPolicy;
  state: StorageState;
  finalizedFiles: string[];
  receipt: TransferReceipt | null;
  checkpointDigest?: string | undefined;
  lastResume?:
    | {
        roomId: string;
        epoch: number;
        attemptId: string;
        checkpointDigest: string;
        reusedBytes: number;
      }
    | undefined;
}
export interface BlockRecord {
  transferId: string;
  fileId: string;
  index: number;
  bytes: number;
  digest: string;
  committedAt: number;
}
export interface SourceRecord {
  transferId: string;
  manifest: TransferManifest;
  manifestDigest: string;
  expiresAt: number;
}
export interface Checkpoint {
  record: TransferRecord;
  manifest: TransferManifest;
  committedBytes: number;
  files: {
    fileId: string;
    ranges: [number, number][];
    verifiedBytes: number;
    finalized: boolean;
  }[];
  discardedBlocks: number;
  verifiedAt: number;
}
export interface RecoveryListing {
  checkpoints: Checkpoint[];
  sources: SourceRecord[];
  unavailable: { transferId: string; reason: string }[];
  cleaned: number;
}
export type CommitStage =
  | 'after-write'
  | 'after-digest'
  | 'after-flush'
  | 'before-ledger'
  | 'after-ledger';
export interface StoreOptions {
  storageKey?: string;
  retention?: RetentionPolicy;
  /** Dependency injection for crash-consistency tests; never controlled by a URL or peer. */
  onStage?: (stage: CommitStage) => Promise<void>;
}
export interface ReceiverStore {
  prepare(manifest: TransferManifest, options?: StoreOptions): Promise<CapacityResult>;
  writeBlock(fileId: string, index: number, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  commitBlock(fileId: string, index: number, digest: string): Promise<void>;
  readBlock(fileId: string, index: number): Promise<Uint8Array<ArrayBuffer>>;
  finalize(fileId: string): Promise<{ file: File; sha256: string }>;
  purge(transferId: string): Promise<void>;
  close(): Promise<void>;
}
export class StorageFailure extends Error {
  constructor(
    public readonly code: 'quota' | 'busy' | 'integrity' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'StorageFailure';
  }
}
export function isQuotaError(error: unknown): boolean {
  return error instanceof StorageFailure
    ? error.code === 'quota'
    : error instanceof DOMException && error.name === 'QuotaExceededError';
}
export function retentionExpiry(policy: RetentionPolicy, now = Date.now()): number {
  // Discard-on-interruption still gets a short crash-orphan deadline.
  return now + (policy === '7-days' ? 7 * 86400000 : policy === 'discard' ? 3600000 : 86400000);
}
