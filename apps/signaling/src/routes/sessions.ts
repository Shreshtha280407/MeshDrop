import { createSessionRequestSchema, uuidSchema } from '@meshdrop/protocol';
import { randomCapability, verifier } from '../auth/capabilities';
import { duration } from '../env';
import type { Env } from '../env';
import { HttpError } from '../errors';
import { readJson } from '../limits';

export async function createSession(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!createSessionRequestSchema.safeParse(await readJson(request)).success)
    throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid room creation request.');
  const roomId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  const ownerCapability = randomCapability();
  const inviteCapability = randomCapability();
  const expiresAt = Date.now() + duration(env.ROOM_TTL_SECONDS, 900, 3600);
  const inviteExpiresAt = Math.min(
    expiresAt,
    Date.now() + duration(env.INVITE_TTL_SECONDS, 300, 3600),
  );
  const [ownerVerifier, inviteVerifier] = await Promise.all([
    verifier('owner', roomId, ownerCapability),
    verifier('invite', roomId, inviteCapability),
  ]);
  const stub = env.SESSION_ROOMS.get(env.SESSION_ROOMS.idFromName(roomId));
  const initialized = await stub.fetch('https://room.internal/initialize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
    body: JSON.stringify({
      roomId,
      peerId,
      ownerVerifier,
      inviteVerifier,
      expiresAt,
      inviteExpiresAt,
    }),
  });
  if (!initialized.ok) return initialized;
  return Response.json(
    {
      roomId,
      peerId,
      ownerCapability,
      inviteCapability,
      expiresAt,
      inviteExpiresAt,
      epoch: 0,
      revision: 0,
    },
    { status: 201 },
  );
}
export function roomRoute(path: string): { roomId: string; action: string } | null {
  const match =
    /^\/v1\/sessions\/([^/]+)(?:\/(status|join|decisions|ws-ticket|ws|connection|ice-credentials))?$/.exec(
      path,
    );
  if (!match) return null;
  const parsed = uuidSchema.safeParse(match[1]);
  if (!parsed.success) throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid room identifier.');
  return { roomId: parsed.data.toLowerCase(), action: match[2] ?? 'close' };
}
