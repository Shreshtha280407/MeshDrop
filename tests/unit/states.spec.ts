import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  PEER_TRANSITIONS,
  ROOM_TRANSITIONS,
  TRANSFER_TRANSITIONS,
  transitionPeer,
  transitionRoom,
  transitionTransfer,
} from '@meshdrop/protocol';
import type {
  PeerEvent,
  PeerState,
  RoomEvent,
  RoomState,
  TransferEvent,
  TransferState,
} from '@meshdrop/protocol';

function verifyMatrix<S extends string, E extends { type: string }>(
  name: string,
  table: Readonly<Record<S, Readonly<Partial<Record<E['type'], S>>>>>,
  events: readonly E[],
  reducer: (state: S, event: E) => S,
) {
  describe(name, () => {
    for (const state of Object.keys(table) as S[]) {
      for (const event of events) {
        const expected = table[state][event.type as E['type']];
        it(`${state} + ${event.type} -> ${expected ?? 'REJECT'}`, () => {
          if (expected === undefined)
            expect(() => reducer(state, event)).toThrow(IllegalTransitionError);
          else {
            expect(reducer(state, event)).toBe(expected);
            expect(reducer(state, event)).toBe(expected);
          }
        });
      }
    }
  });
}
verifyMatrix<RoomState, RoomEvent>(
  'room matrix',
  ROOM_TRANSITIONS,
  ['REQUEST_JOIN', 'APPROVE', 'REJECT', 'CLOSE', 'EXPIRE', 'REVOKE'].map(
    (type) => ({ type }) as RoomEvent,
  ),
  transitionRoom,
);
verifyMatrix<PeerState, PeerEvent>(
  'peer matrix',
  PEER_TRANSITIONS,
  ['BEGIN_SIGNALING', 'CHECK_CONNECTIVITY', 'CONNECT', 'DISCONNECT', 'RETRY', 'CLOSE'].map(
    (type) => ({ type }) as PeerEvent,
  ),
  transitionPeer,
);
verifyMatrix<TransferState, TransferEvent>(
  'transfer matrix',
  TRANSFER_TRANSITIONS,
  [
    { type: 'PREPARED' },
    { type: 'ACCEPT' },
    { type: 'PAUSE' },
    { type: 'RESUME' },
    { type: 'DISCONNECT' },
    { type: 'RECONNECTED' },
    { type: 'ALL_BLOCKS_COMMITTED', committedBytes: 42, totalBytes: 42 },
    { type: 'VERIFY_SUCCESS', integrityVerified: true, storageFinalized: true },
    { type: 'FAIL', code: 'test' },
    { type: 'CANCEL' },
  ],
  transitionTransfer,
);

it('requires complete receiver commitment before verification', () => {
  for (const [committedBytes, totalBytes] of [
    [1, 2],
    [3, 2],
    [-1, -1],
    [0.5, 0.5],
    [Number.NaN, Number.NaN],
  ])
    expect(() =>
      transitionTransfer('active', {
        type: 'ALL_BLOCKS_COMMITTED',
        committedBytes: committedBytes!,
        totalBytes: totalBytes!,
      }),
    ).toThrow();
});
it('requires verified integrity AND finalized storage at runtime', () => {
  for (const flags of [
    { integrityVerified: false, storageFinalized: true },
    { integrityVerified: true, storageFinalized: false },
    {},
  ])
    expect(() =>
      transitionTransfer('verifying', { type: 'VERIFY_SUCCESS', ...flags } as TransferEvent),
    ).toThrow('Completion requires');
});
it('has deterministic idempotent cancellation and terminal states', () => {
  expect(
    transitionTransfer(transitionTransfer('active', { type: 'CANCEL' }), { type: 'CANCEL' }),
  ).toBe('cancelled');
  expect(() => transitionTransfer('complete', { type: 'CANCEL' })).toThrow(IllegalTransitionError);
  expect(transitionRoom('approved', { type: 'APPROVE' })).toBe('approved');
});

it('rejects inherited object keys even when a runtime caller bypasses TypeScript', () => {
  expect(() => transitionRoom('created', { type: 'toString' } as unknown as RoomEvent)).toThrow(
    IllegalTransitionError,
  );
  expect(() => transitionRoom('constructor' as RoomState, { type: 'CLOSE' })).toThrow(
    IllegalTransitionError,
  );
});

it('cannot skip negotiation, commitment, or verification on the happy path', () => {
  expect(() => transitionTransfer('preparing', { type: 'ACCEPT' })).toThrow();
  expect(() =>
    transitionTransfer('active', {
      type: 'VERIFY_SUCCESS',
      integrityVerified: true,
      storageFinalized: true,
    }),
  ).toThrow();
  let state = transitionTransfer('preparing', { type: 'PREPARED' });
  state = transitionTransfer(state, { type: 'ACCEPT' });
  state = transitionTransfer(state, {
    type: 'ALL_BLOCKS_COMMITTED',
    committedBytes: 12,
    totalBytes: 12,
  });
  expect(state).toBe('verifying');
  expect(
    transitionTransfer(state, {
      type: 'VERIFY_SUCCESS',
      integrityVerified: true,
      storageFinalized: true,
    }),
  ).toBe('complete');
});
