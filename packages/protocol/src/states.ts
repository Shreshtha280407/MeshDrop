export const ROOM_STATES = ['created', 'pending', 'approved', 'closed'] as const;
export const PEER_STATES = [
  'idle',
  'signaling',
  'checking',
  'connected',
  'reconnecting',
  'closed',
] as const;
export const TRANSFER_STATES = [
  'preparing',
  'negotiating',
  'active',
  'paused',
  'reconnecting',
  'verifying',
  'complete',
  'failed',
  'cancelled',
] as const;
export type RoomState = (typeof ROOM_STATES)[number];
export type PeerState = (typeof PEER_STATES)[number];
export type TransferState = (typeof TRANSFER_STATES)[number];

export type RoomEvent =
  | { type: 'REQUEST_JOIN' }
  | { type: 'APPROVE' }
  | { type: 'REJECT' }
  | { type: 'CLOSE' }
  | { type: 'EXPIRE' }
  | { type: 'REVOKE' };
export type PeerEvent =
  | { type: 'BEGIN_SIGNALING' }
  | { type: 'CHECK_CONNECTIVITY' }
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'RETRY' }
  | { type: 'CLOSE' };
export type TransferEvent =
  | { type: 'PREPARED' }
  | { type: 'ACCEPT' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DISCONNECT' }
  | { type: 'RECONNECTED' }
  | { type: 'ALL_BLOCKS_COMMITTED'; committedBytes: number; totalBytes: number }
  | { type: 'VERIFY_SUCCESS'; integrityVerified: true; storageFinalized: true }
  | { type: 'FAIL'; code: string }
  | { type: 'CANCEL' };

type TransitionTable<S extends string, E extends { type: string }> = Readonly<
  Record<S, Readonly<Partial<Record<E['type'], S>>>>
>;

// Self-transitions deliberately specify which repeated events are idempotent.
export const ROOM_TRANSITIONS = {
  created: {
    REQUEST_JOIN: 'pending',
    REJECT: 'created',
    CLOSE: 'closed',
    EXPIRE: 'closed',
    REVOKE: 'closed',
  },
  pending: {
    REQUEST_JOIN: 'pending',
    APPROVE: 'approved',
    REJECT: 'created',
    CLOSE: 'closed',
    EXPIRE: 'closed',
    REVOKE: 'closed',
  },
  approved: { APPROVE: 'approved', CLOSE: 'closed', EXPIRE: 'closed', REVOKE: 'closed' },
  closed: { CLOSE: 'closed', EXPIRE: 'closed', REVOKE: 'closed' },
} as const satisfies TransitionTable<RoomState, RoomEvent>;

export const PEER_TRANSITIONS = {
  idle: { BEGIN_SIGNALING: 'signaling', CLOSE: 'closed' },
  signaling: { BEGIN_SIGNALING: 'signaling', CHECK_CONNECTIVITY: 'checking', CLOSE: 'closed' },
  checking: {
    CHECK_CONNECTIVITY: 'checking',
    CONNECT: 'connected',
    DISCONNECT: 'reconnecting',
    CLOSE: 'closed',
  },
  connected: { CONNECT: 'connected', DISCONNECT: 'reconnecting', CLOSE: 'closed' },
  reconnecting: {
    DISCONNECT: 'reconnecting',
    RETRY: 'signaling',
    CONNECT: 'connected',
    CLOSE: 'closed',
  },
  closed: { CLOSE: 'closed' },
} as const satisfies TransitionTable<PeerState, PeerEvent>;

export const TRANSFER_TRANSITIONS = {
  preparing: { PREPARED: 'negotiating', FAIL: 'failed', CANCEL: 'cancelled' },
  negotiating: {
    PREPARED: 'negotiating',
    ACCEPT: 'active',
    DISCONNECT: 'reconnecting',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  active: {
    ACCEPT: 'active',
    PAUSE: 'paused',
    DISCONNECT: 'reconnecting',
    ALL_BLOCKS_COMMITTED: 'verifying',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  paused: {
    PAUSE: 'paused',
    RESUME: 'active',
    DISCONNECT: 'reconnecting',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  reconnecting: {
    DISCONNECT: 'reconnecting',
    RECONNECTED: 'negotiating',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  verifying: {
    ALL_BLOCKS_COMMITTED: 'verifying',
    VERIFY_SUCCESS: 'complete',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  complete: { VERIFY_SUCCESS: 'complete' },
  failed: { FAIL: 'failed' },
  cancelled: { CANCEL: 'cancelled' },
} as const satisfies TransitionTable<TransferState, TransferEvent>;

export class IllegalTransitionError extends Error {
  constructor(
    public readonly state: string,
    public readonly eventType: string,
  ) {
    super(`Illegal transition: ${state} + ${eventType}`);
    this.name = 'IllegalTransitionError';
  }
}

function transition<S extends string, E extends { type: string }>(
  table: TransitionTable<S, E>,
  state: S,
  event: E,
): S {
  const events = Object.hasOwn(table, state) ? table[state] : undefined;
  const next =
    events && Object.hasOwn(events, event.type) ? events[event.type as E['type']] : undefined;
  if (next === undefined) throw new IllegalTransitionError(state, event.type);
  return next;
}

export const transitionRoom = (state: RoomState, event: RoomEvent): RoomState =>
  transition<RoomState, RoomEvent>(ROOM_TRANSITIONS, state, event);
export const transitionPeer = (state: PeerState, event: PeerEvent): PeerState =>
  transition<PeerState, PeerEvent>(PEER_TRANSITIONS, state, event);
export function transitionTransfer(state: TransferState, event: TransferEvent): TransferState {
  if (
    event.type === 'ALL_BLOCKS_COMMITTED' &&
    (!Number.isSafeInteger(event.totalBytes) ||
      event.totalBytes < 0 ||
      event.committedBytes !== event.totalBytes)
  ) {
    throw new Error('Verification requires all receiver-committed bytes.');
  }
  if (
    event.type === 'VERIFY_SUCCESS' &&
    (event.integrityVerified !== true || event.storageFinalized !== true)
  ) {
    throw new Error('Completion requires integrity verification and finalized storage.');
  }
  return transition<TransferState, TransferEvent>(TRANSFER_TRANSITIONS, state, event);
}
