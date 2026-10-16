import { z } from 'zod';
import {
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_ICE_CANDIDATE_BYTES,
  MAX_SDP_BYTES,
  MAX_UINT32,
  PROTOCOL_VERSION,
} from './constants';

const encoder = new TextEncoder();
export const uuidSchema = z.uuid();
const boundedText = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes)
    .refine((value) => encoder.encode(value).byteLength <= maxBytes, 'UTF-8 byte limit exceeded');
const uint32 = z.number().int().min(0).max(MAX_UINT32);
const base = {
  version: z.literal(PROTOCOL_VERSION),
  roomId: uuidSchema,
  peerId: uuidSchema,
  messageId: uuidSchema,
  epoch: uint32,
  seq: uint32,
  sentAt: z.iso.datetime({ offset: true }),
};
export const ERROR_CODES = [
  'INVALID_MESSAGE',
  'UNSUPPORTED_VERSION',
  'MESSAGE_TOO_LARGE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ROOM_CLOSED',
  'STALE_EPOCH',
  'REPLAY',
  'CAPACITY_EXCEEDED',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INVALID_ORIGIN',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_USED',
  'TICKET_EXPIRED',
  'TICKET_USED',
  'CONFLICT',
  'PEER_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export const errorPayloadSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: boundedText(256),
  retryable: z.boolean(),
});
const peerPair = { ownerPeerId: uuidSchema, receiverPeerId: uuidSchema };
const sdpPayload = z.strictObject({ sdp: boundedText(MAX_SDP_BYTES).min(1) });

export const signalingEnvelopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...base, type: z.literal('PEER_READY'), payload: z.strictObject(peerPair) }),
  z.strictObject({
    ...base,
    type: z.literal('CONNECTION_EPOCH'),
    payload: z.strictObject({
      ...peerPair,
      epoch: uint32,
      mode: z.enum(['ice-restart', 'new-connection']),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('JOINED'),
    payload: z.strictObject({ approval: z.enum(['pending', 'approved']) }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('PEER_PENDING'),
    payload: z.strictObject({ candidatePeerId: uuidSchema }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('PEER_APPROVED'),
    payload: z.strictObject({ candidatePeerId: uuidSchema }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('PEER_REJECTED'),
    payload: z.strictObject({ candidatePeerId: uuidSchema }),
  }),
  z.strictObject({ ...base, type: z.literal('SDP_OFFER'), payload: sdpPayload }),
  z.strictObject({ ...base, type: z.literal('SDP_ANSWER'), payload: sdpPayload }),
  z.strictObject({
    ...base,
    type: z.literal('ICE_CANDIDATE'),
    payload: z.strictObject({
      candidate: boundedText(MAX_ICE_CANDIDATE_BYTES),
      usernameFragment: boundedText(256).nullable().optional(),
      sdpMid: boundedText(256).nullable(),
      sdpMLineIndex: z.number().int().min(0).max(65535).nullable(),
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('RENEGOTIATE'),
    payload: z.strictObject({ reason: z.enum(['ice-restart', 'new-connection']) }),
  }),
  z.strictObject({
    ...base,
    type: z.literal('ROOM_CLOSED'),
    payload: z.strictObject({ reason: z.enum(['owner-closed', 'expired', 'revoked']) }),
  }),
  z.strictObject({ ...base, type: z.literal('ERROR'), payload: errorPayloadSchema }),
]);
export type SignalingEnvelope = z.infer<typeof signalingEnvelopeSchema>;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ProtocolValidationError extends Error {
  constructor(public readonly code: 'INVALID_MESSAGE' | 'MESSAGE_TOO_LARGE') {
    // Never echo the original input: it may contain credentials, SDP, or addresses.
    super(
      code === 'MESSAGE_TOO_LARGE'
        ? 'Control message exceeds byte limit.'
        : 'Invalid protocol v1 control message.',
    );
    this.name = 'ProtocolValidationError';
  }
}
export function parseSignalingMessage(raw: string): SignalingEnvelope {
  if (
    raw.length > MAX_CONTROL_MESSAGE_BYTES ||
    encoder.encode(raw).byteLength > MAX_CONTROL_MESSAGE_BYTES
  )
    throw new ProtocolValidationError('MESSAGE_TOO_LARGE');
  try {
    return signalingEnvelopeSchema.parse(JSON.parse(raw));
  } catch {
    throw new ProtocolValidationError('INVALID_MESSAGE');
  }
}
export function serializeSignalingMessage(envelope: SignalingEnvelope): string {
  const raw = JSON.stringify(signalingEnvelopeSchema.parse(envelope));
  parseSignalingMessage(raw);
  return raw;
}
