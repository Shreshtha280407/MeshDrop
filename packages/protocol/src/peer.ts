import { z } from 'zod';
import { DEFAULT_FRAME_BYTES, FRAME_HEADER_BYTES, MAX_UINT32 } from './constants';
import { uuidSchema } from './schemas';

export const connectionModeSchema = z.enum(['ice-restart', 'new-connection']);
export const connectionRequestSchema = z.strictObject({
  expectedEpoch: z
    .number()
    .int()
    .min(0)
    .max(MAX_UINT32 - 1),
  mode: connectionModeSchema,
});
export const connectionEpochSchema = z.strictObject({
  epoch: z.number().int().min(1).max(MAX_UINT32),
  mode: connectionModeSchema,
  ownerPeerId: uuidSchema,
  receiverPeerId: uuidSchema,
});
export const iceConfigurationSchema = z.strictObject({
  iceServers: z
    .array(
      z.strictObject({
        urls: z.array(z.string().max(512)).max(8),
        username: z.string().max(256).optional(),
        credential: z.string().max(256).optional(),
      }),
    )
    .max(8),
  relayAvailable: z.boolean(),
  expiresAt: z.number().int(),
});
export const peerCapabilitiesSchema = z.strictObject({
  protocolVersion: z.literal(1),
  preferredFrameBytes: z
    .number()
    .int()
    .min(FRAME_HEADER_BYTES + 1)
    .max(DEFAULT_FRAME_BYTES),
  maxMessageBytes: z
    .number()
    .int()
    .min(FRAME_HEADER_BYTES + 1)
    .max(16 * 1024 * 1024),
  supportedHashes: z.tuple([z.literal('SHA-256')]),
  storageModes: z
    .array(z.enum(['memory', 'opfs', 'direct-save']))
    .min(1)
    .max(3),
  resumeMode: z.enum(['unavailable', 'session-only', 'persistent']),
});
const context = {
  version: z.literal(1),
  roomId: uuidSchema,
  peerId: uuidSchema,
  epoch: z.number().int().min(1).max(MAX_UINT32),
};
export const peerHelloSchema = z.strictObject({
  ...context,
  type: z.literal('HELLO'),
  role: z.enum(['owner', 'receiver']),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  dtlsFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: peerCapabilitiesSchema,
});
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const signedHelloSchema = z.strictObject({
  hello: peerHelloSchema,
  signature: signatureSchema,
});
export const peerPingSchema = z.strictObject({
  ...context,
  type: z.enum(['PING', 'PONG', 'PAIRING_CONFIRMED']),
  transcript: z.string().regex(/^[a-f0-9]{64}$/),
  messageId: uuidSchema,
  seq: z.number().int().min(0).max(MAX_UINT32),
});
export const signedPingSchema = z.strictObject({
  ping: peerPingSchema,
  signature: signatureSchema,
});
export const MAX_PEER_CONTROL_BYTES = DEFAULT_FRAME_BYTES;
export type ConnectionEpoch = z.infer<typeof connectionEpochSchema>;
export type IceConfiguration = z.infer<typeof iceConfigurationSchema>;
export type PeerHello = z.infer<typeof peerHelloSchema>;
export type SignedHello = z.infer<typeof signedHelloSchema>;
export type PeerPing = z.infer<typeof peerPingSchema>;
