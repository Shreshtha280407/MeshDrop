import type { StorageMode } from '@meshdrop/shared-types';

export type CapacityResult =
  | { available: true; estimatedFreeBytes: number | null }
  | { available: false; reason: 'unsupported' | 'quota' | 'permission' };
export type SaveResult =
  | { finalized: true; mode: StorageMode }
  | { finalized: false; reason: string };
/** P4 contract. writeBlock alone never authorizes an ACK. */
export interface ReceiverStore {
  prepare(transferId: string, totalBytes: number): Promise<CapacityResult>;
  writeBlock(fileId: string, index: number, bytes: Uint8Array): Promise<void>;
  commitBlock(fileId: string, index: number, digest: string): Promise<void>;
  readBlock(fileId: string, index: number): Promise<Uint8Array>;
  finalize(fileId: string): Promise<SaveResult>;
  purge(transferId: string): Promise<void>;
}
