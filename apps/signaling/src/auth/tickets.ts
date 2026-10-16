import { capabilitySchema } from '@meshdrop/protocol';
import { HttpError } from '../errors';

export const SOCKET_PROTOCOL = 'meshdrop.v1';
export function socketCredential(request: Request): string {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    throw new HttpError(426, 'INVALID_MESSAGE', 'A WebSocket upgrade is required.');
  const protocols =
    request.headers
      .get('Sec-WebSocket-Protocol')
      ?.split(',')
      .map((value) => value.trim()) ?? [];
  if (
    protocols.length !== 2 ||
    protocols[0] !== SOCKET_PROTOCOL ||
    !protocols[1]?.startsWith('meshdrop.ticket.')
  )
    throw new HttpError(401, 'UNAUTHORIZED', 'A single-use admission ticket is required.');
  const ticket = protocols[1].slice('meshdrop.ticket.'.length);
  if (!capabilitySchema.safeParse(ticket).success)
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid admission ticket.');
  return ticket;
}
