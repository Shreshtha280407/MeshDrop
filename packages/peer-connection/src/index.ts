import type { PeerEvent, PeerState, SignalingEnvelope } from '@meshdrop/protocol';
import type { PeerCapabilities } from '@meshdrop/shared-types';

/** Implemented in P2. Authenticated admission must precede connect(). */
export interface PeerSession {
  readonly state: PeerState;
  readonly epoch: number;
  connect(signal: AbortSignal): Promise<PeerCapabilities>;
  receiveSignal(envelope: SignalingEnvelope): Promise<void>;
  onState(listener: (state: PeerState, event: PeerEvent) => void): () => void;
  close(): void;
}
