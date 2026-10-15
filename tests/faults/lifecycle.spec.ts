import { describe, expect, it } from 'vitest';
import { transitionPeer, transitionTransfer } from '@meshdrop/protocol';
import type { TransferState } from '@meshdrop/protocol';

describe('P0 synthetic lifecycle fault injection (no real transport/storage)', () => {
  it('requires negotiation again after a disconnected active transfer', () => {
    let state = transitionTransfer('active', { type: 'DISCONNECT' });
    expect(state).toBe('reconnecting');
    expect(() => transitionTransfer(state, { type: 'ACCEPT' })).toThrow();
    state = transitionTransfer(state, { type: 'RECONNECTED' });
    expect(state).toBe('negotiating');
    expect(transitionTransfer(state, { type: 'ACCEPT' })).toBe('active');
  });
  it('retries peer negotiation and cannot reopen a closed peer', () => {
    let state = transitionPeer('connected', { type: 'DISCONNECT' });
    state = transitionPeer(state, { type: 'RETRY' });
    expect(state).toBe('signaling');
    expect(() => transitionPeer('closed', { type: 'BEGIN_SIGNALING' })).toThrow();
  });
  it.each<TransferState>([
    'preparing',
    'negotiating',
    'active',
    'paused',
    'reconnecting',
    'verifying',
  ])('cancels safely from %s and rejects later work', (state) => {
    const cancelled = transitionTransfer(state, { type: 'CANCEL' });
    expect(transitionTransfer(cancelled, { type: 'CANCEL' })).toBe('cancelled');
    expect(() => transitionTransfer(cancelled, { type: 'RECONNECTED' })).toThrow();
    expect(() =>
      transitionTransfer(cancelled, {
        type: 'VERIFY_SUCCESS',
        integrityVerified: true,
        storageFinalized: true,
      }),
    ).toThrow();
  });
});
