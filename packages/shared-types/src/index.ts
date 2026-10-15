import type { ErrorCode, PeerState, RoomState, TransferState } from '@meshdrop/protocol';

export type PeerRole = 'owner' | 'candidate' | 'receiver';
export type StorageMode = 'opfs' | 'direct-save' | 'memory';
export type ResumeMode = 'persistent' | 'session-only' | 'unavailable';
export interface PeerCapabilities {
  readonly protocolVersion: 1;
  readonly preferredFrameBytes: number;
  readonly maxMessageBytes: number;
  readonly supportedHashes: readonly ['SHA-256'];
  readonly storageModes: readonly StorageMode[];
  readonly resumeMode: ResumeMode;
}
export interface DeviceCapabilities {
  readonly secureContext: boolean;
  readonly webRtc: boolean;
  readonly opfsApi: boolean;
  readonly indexedDbApi: boolean;
  readonly savePickerApi: boolean;
  readonly storageEstimateApi: boolean;
}
export interface ApiError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly retryable: boolean;
}
export interface SessionSnapshot {
  readonly roomId: string;
  readonly roomState: RoomState;
  readonly peerState: PeerState;
  readonly transferState: TransferState;
  readonly epoch: number;
}
