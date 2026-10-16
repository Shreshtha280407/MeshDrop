import { expect, it } from 'vitest';
import {
  capabilitySchema,
  decisionRequestSchema,
  joinSessionRequestSchema,
  sessionStatusSchema,
} from '@meshdrop/protocol';
import fixture from '../fixtures/signaling-v1.json';

it('requires a peer capability and UUID, rejecting client-selected roles', () => {
  const base = { peerId: fixture.peerId, peerCapability: 'x'.repeat(43) };
  expect(joinSessionRequestSchema.safeParse(base).success).toBe(true);
  for (const input of [
    { ...base, role: 'owner' },
    { peerId: fixture.peerId },
    { ...base, peerId: 'not-a-uuid' },
    { ...base, peerCapability: 'short' },
  ])
    expect(joinSessionRequestSchema.safeParse(input).success).toBe(false);
});
it('accepts only approve/reject decisions with a candidate identifier', () => {
  expect(
    decisionRequestSchema.safeParse({ candidatePeerId: fixture.peerId, decision: 'approve' })
      .success,
  ).toBe(true);
  expect(
    decisionRequestSchema.safeParse({ candidatePeerId: fixture.peerId, decision: 'reject' })
      .success,
  ).toBe(true);
  expect(
    decisionRequestSchema.safeParse({ candidatePeerId: fixture.peerId, decision: 'owner' }).success,
  ).toBe(false);
});
it('rejects credentials in a public session status response', () => {
  expect(
    sessionStatusSchema.safeParse({
      roomId: fixture.roomId,
      peerId: fixture.peerId,
      role: 'candidate',
      approval: 'pending',
      state: 'pending',
      epoch: 0,
      revision: 1,
      expiresAt: 1,
      nextSeq: 0,
      ownerCapability: 'x'.repeat(43),
    }).success,
  ).toBe(false);
});
it.each(['x'.repeat(42), 'x'.repeat(44), 'a'.repeat(42) + '+', 'token=private'])(
  'rejects malformed capability shape %s',
  (value) => {
    expect(capabilitySchema.safeParse(value).success).toBe(false);
  },
);
