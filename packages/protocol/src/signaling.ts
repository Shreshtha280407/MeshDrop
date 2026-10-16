import { z } from 'zod';
import { ERROR_CODES, uuidSchema } from './schemas';
import { ROOM_STATES } from './states';

export const capabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const createSessionRequestSchema = z.strictObject({});
export const joinSessionRequestSchema = z.strictObject({
  peerId: uuidSchema,
  peerCapability: capabilitySchema,
});
export const decisionRequestSchema = z.strictObject({
  candidatePeerId: uuidSchema,
  decision: z.enum(['approve', 'reject']),
});
export const ticketRequestSchema = z.strictObject({});
export const sessionCreatedSchema = z.strictObject({
  roomId: uuidSchema,
  peerId: uuidSchema,
  ownerCapability: capabilitySchema,
  inviteCapability: capabilitySchema,
  expiresAt: z.number().int(),
  inviteExpiresAt: z.number().int(),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export const sessionStatusSchema = z.strictObject({
  roomId: uuidSchema,
  peerId: uuidSchema,
  role: z.enum(['owner', 'candidate', 'receiver']),
  approval: z.enum(['pending', 'approved', 'rejected']),
  state: z.enum(ROOM_STATES),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  expiresAt: z.number().int(),
  nextSeq: z.number().int().nonnegative(),
  candidatePeerId: uuidSchema.optional(),
});
export const socketTicketSchema = z.strictObject({
  ticket: capabilitySchema,
  expiresAt: z.number().int(),
  epoch: z.number().int().nonnegative(),
  nextSeq: z.number().int().nonnegative(),
});
export type SessionCreated = z.infer<typeof sessionCreatedSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SocketTicket = z.infer<typeof socketTicketSchema>;
export const CLIENT_SIGNAL_TYPES = [
  'SDP_OFFER',
  'SDP_ANSWER',
  'ICE_CANDIDATE',
  'RENEGOTIATE',
] as const;
export const apiErrorSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string().max(256),
  requestId: uuidSchema,
  retryable: z.boolean(),
});
