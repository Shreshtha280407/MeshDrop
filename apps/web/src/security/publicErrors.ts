import type { ErrorCode } from '@meshdrop/protocol';

/** Only locally authored guidance is safe to display from an exception. */
export class PublicRoomError extends Error {}
export function publicRoomError(error: unknown, fallback: string): string {
  return error instanceof PublicRoomError ? error.message : fallback;
}
/** Keep useful protocol distinctions without trusting a remote message or raw exception text. */
export function signalingError(code: ErrorCode): string {
  const messages: Partial<Record<ErrorCode, string>> = {
    UNAUTHORIZED: 'Room authorization is required. Request a fresh invitation.',
    FORBIDDEN: 'This operation is not authorized for this room.',
    NOT_FOUND: 'This room is unavailable. Request a fresh invitation.',
    ROOM_CLOSED: 'This room is closed. Request a fresh invitation.',
    INVITE_EXPIRED: 'Invitation expired. Request a fresh invitation.',
    INVITE_REVOKED: 'Invitation revoked. Request a fresh invitation.',
    INVITE_USED: 'Invitation already used. Request a fresh invitation.',
    TICKET_EXPIRED: 'Signaling ticket expired. Reconnect to request a fresh ticket.',
    TICKET_USED: 'Signaling ticket already used. Reconnect to request a fresh ticket.',
    RATE_LIMITED: 'Too many requests. Wait before trying again.',
    CAPACITY_EXCEEDED: 'This room already has its intended receiver.',
    PEER_UNAVAILABLE: 'The approved peer is unavailable. Check both devices.',
    STALE_EPOCH: 'The connection changed. Reconnect and compare a fresh code.',
    CONFLICT: 'The room changed. Refresh its state before trying again.',
    SERVICE_UNAVAILABLE: 'The signaling service is unavailable. Try again later.',
    INTERNAL_ERROR: 'The signaling service could not finish this operation.',
    INVALID_ORIGIN: 'This request is not from the allowed application origin.',
  };
  return `${code}: ${messages[code] ?? 'The signaling request was rejected. Reconnect or request a fresh invitation.'}`;
}
