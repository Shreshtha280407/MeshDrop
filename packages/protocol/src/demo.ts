import { parseSignalingMessage } from './schemas';
import { transitionPeer, transitionRoom, transitionTransfer } from './states';
import type { PeerState, RoomState, TransferState } from './states';

export interface DemoSnapshot {
  readonly room: RoomState;
  readonly peer: PeerState;
  readonly transfer: TransferState;
}
export const INITIAL_DEMO: DemoSnapshot = { room: 'created', peer: 'idle', transfer: 'preparing' };
export const DEMO_ROOM_ID = '11111111-1111-4111-8111-111111111111';
export const DEMO_PEER_ID = '22222222-2222-4222-8222-222222222222';
export const DEMO_CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';

/** Synthetic P0 input only. Never use as a real session or authorization source. */
export function demoRoomMessage(type: 'PEER_PENDING' | 'PEER_APPROVED' | 'ROOM_CLOSED'): string {
  return JSON.stringify({
    version: 1,
    type,
    roomId: DEMO_ROOM_ID,
    peerId: DEMO_PEER_ID,
    messageId: '44444444-4444-4444-8444-444444444444',
    epoch: 0,
    seq: 0,
    sentAt: '2026-10-16T00:00:00Z',
    payload:
      type === 'ROOM_CLOSED' ? { reason: 'owner-closed' } : { candidatePeerId: DEMO_CANDIDATE_ID },
  });
}
export function applyDemoRoomMessage(snapshot: DemoSnapshot, raw: string): DemoSnapshot {
  const message = parseSignalingMessage(raw);
  switch (message.type) {
    case 'PEER_PENDING':
      return { ...snapshot, room: transitionRoom(snapshot.room, { type: 'REQUEST_JOIN' }) };
    case 'PEER_APPROVED':
      return { ...snapshot, room: transitionRoom(snapshot.room, { type: 'APPROVE' }) };
    case 'ROOM_CLOSED':
      return { ...snapshot, room: transitionRoom(snapshot.room, { type: 'CLOSE' }) };
    default:
      throw new Error('Unsupported event in the P0 room demonstration.');
  }
}
export function runDemoLifecycle(): readonly DemoSnapshot[] {
  const snapshots: DemoSnapshot[] = [{ ...INITIAL_DEMO }];
  const push = (snapshot: DemoSnapshot) => {
    snapshots.push(snapshot);
    return snapshot;
  };
  let current = push(applyDemoRoomMessage(INITIAL_DEMO, demoRoomMessage('PEER_PENDING')));
  current = push(applyDemoRoomMessage(current, demoRoomMessage('PEER_APPROVED')));
  let peer = transitionPeer(current.peer, { type: 'BEGIN_SIGNALING' });
  current = push({ ...current, peer });
  peer = transitionPeer(peer, { type: 'CHECK_CONNECTIVITY' });
  current = push({ ...current, peer });
  peer = transitionPeer(peer, { type: 'CONNECT' });
  current = push({ ...current, peer });
  let transfer = transitionTransfer(current.transfer, { type: 'PREPARED' });
  current = push({ ...current, transfer });
  transfer = transitionTransfer(transfer, { type: 'ACCEPT' });
  current = push({ ...current, transfer });
  // Synthetic evidence: no file has been sent or saved by this demonstration.
  transfer = transitionTransfer(transfer, {
    type: 'ALL_BLOCKS_COMMITTED',
    committedBytes: 0,
    totalBytes: 0,
  });
  current = push({ ...current, transfer });
  transfer = transitionTransfer(transfer, {
    type: 'VERIFY_SUCCESS',
    integrityVerified: true,
    storageFinalized: true,
  });
  current = push({ ...current, transfer });
  current = push(applyDemoRoomMessage(current, demoRoomMessage('ROOM_CLOSED')));
  push({ ...current, peer: transitionPeer(current.peer, { type: 'CLOSE' }) });
  return snapshots;
}
