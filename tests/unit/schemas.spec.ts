import { describe, expect, it } from 'vitest';
import {
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_ICE_CANDIDATE_BYTES,
  MAX_SDP_BYTES,
  parseSignalingMessage,
  serializeSignalingMessage,
  signalingEnvelopeSchema,
} from '@meshdrop/protocol';
import fixture from '../fixtures/signaling-v1.json';

describe('protocol v1 signaling', () => {
  it('round-trips the golden fixture without changing fields', () => {
    const parsed = parseSignalingMessage(JSON.stringify(fixture));
    expect(JSON.parse(serializeSignalingMessage(parsed))).toEqual(fixture);
  });
  for (const field of [
    'version',
    'type',
    'roomId',
    'peerId',
    'messageId',
    'epoch',
    'seq',
    'sentAt',
    'payload',
  ]) {
    it(`rejects missing ${field}`, () => {
      const raw: Record<string, unknown> = { ...fixture };
      delete raw[field];
      expect(() => parseSignalingMessage(JSON.stringify(raw))).toThrow('Invalid protocol');
    });
  }
  it.each([0, 2, '1', null])('rejects unsupported version %s', (version) => {
    expect(signalingEnvelopeSchema.safeParse({ ...fixture, version }).success).toBe(false);
  });
  it.each(['roomId', 'peerId', 'messageId'])('rejects invalid UUID in %s', (field) => {
    expect(signalingEnvelopeSchema.safeParse({ ...fixture, [field]: '../room' }).success).toBe(
      false,
    );
  });
  it.each([-1, 0.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid epoch and sequence %s',
    (value) => {
      for (const field of ['epoch', 'seq'])
        expect(signalingEnvelopeSchema.safeParse({ ...fixture, [field]: value }).success).toBe(
          false,
        );
    },
  );
  it.each(['not-json', 'null', '[]', '{}'])('rejects malformed input %s', (raw) => {
    expect(() => parseSignalingMessage(raw)).toThrow('Invalid protocol');
  });
  it('rejects unknown fields, unknown events and client-supplied roles', () => {
    for (const extra of [
      { type: 'FILE_BYTES' },
      { role: 'owner' },
      { payload: { ...fixture.payload, bytes: 'secret' } },
      { sentAt: 'yesterday' },
    ])
      expect(signalingEnvelopeSchema.safeParse({ ...fixture, ...extra }).success).toBe(false);
  });
  it('caps control messages by UTF-8 bytes before JSON parsing', () => {
    for (const text of [
      ' '.repeat(MAX_CONTROL_MESSAGE_BYTES + 1),
      '🚀'.repeat(MAX_CONTROL_MESSAGE_BYTES / 4 + 1),
    ])
      expect(() => parseSignalingMessage(text)).toThrow('byte limit');
  });
  it('never echoes sensitive malformed input in its error', () => {
    expect(() => parseSignalingMessage('secret-invite-value')).toThrow(
      /^Invalid protocol v1 control message\.$/,
    );
  });
  const cases = [
    ['JOINED', { approval: 'pending' }],
    ['PEER_APPROVED', fixture.payload],
    ['PEER_REJECTED', fixture.payload],
    ['SDP_OFFER', { sdp: 'synthetic-offer' }],
    ['SDP_ANSWER', { sdp: 'synthetic-answer' }],
    ['ICE_CANDIDATE', { candidate: '', sdpMid: null, sdpMLineIndex: null }],
    ['RENEGOTIATE', { reason: 'ice-restart' }],
    ['ROOM_CLOSED', { reason: 'expired' }],
    ['ERROR', { code: 'UNAUTHORIZED', message: 'Admission denied.', retryable: false }],
  ] as const;
  it.each(cases)('accepts typed %s payload', (type, payload) => {
    expect(parseSignalingMessage(JSON.stringify({ ...fixture, type, payload })).type).toBe(type);
  });
  it.each(['SDP_OFFER', 'SDP_ANSWER'])('enforces %s byte caps', (type) => {
    expect(
      signalingEnvelopeSchema.safeParse({
        ...fixture,
        type,
        payload: { sdp: 'x'.repeat(MAX_SDP_BYTES) },
      }).success,
    ).toBe(true);
    expect(
      signalingEnvelopeSchema.safeParse({
        ...fixture,
        type,
        payload: { sdp: 'é'.repeat(MAX_SDP_BYTES) },
      }).success,
    ).toBe(false);
  });
  it('rejects oversized ICE and mismatched payload shapes', () => {
    expect(
      signalingEnvelopeSchema.safeParse({
        ...fixture,
        type: 'ICE_CANDIDATE',
        payload: {
          candidate: 'x'.repeat(MAX_ICE_CANDIDATE_BYTES + 1),
          sdpMid: null,
          sdpMLineIndex: null,
        },
      }).success,
    ).toBe(false);
    expect(signalingEnvelopeSchema.safeParse({ ...fixture, type: 'SDP_OFFER' }).success).toBe(
      false,
    );
  });
});
