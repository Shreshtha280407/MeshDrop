import type { IceConfiguration } from '@meshdrop/protocol';
import { duration } from '../env';
import type { Env } from '../env';
import { HttpError } from '../errors';

function urls(value: string | undefined, turn: boolean): string[] {
  if (!value?.trim()) return [];
  const list = value.split(',').map((url) => url.trim());
  const pattern = turn
    ? /^turns?:[a-zA-Z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/
    : /^stuns?:[a-zA-Z0-9.\-[\]:]+$/;
  if (list.length > 8 || list.some((url) => url.length > 512 || !pattern.test(url)))
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Invalid ICE server configuration.');
  return list;
}

/** coturn TURN REST credentials: expiry:opaque-id and base64(HMAC-SHA1(secret, username)). */
export async function iceCredentials(env: Env, roomExpiresAt: number): Promise<IceConfiguration> {
  const stun = urls(env.STUN_URLS, false);
  const turn = urls(env.TURN_URLS, true);
  if (Boolean(turn.length) !== Boolean(env.TURN_SHARED_SECRET?.trim()))
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'TURN configuration is incomplete.');
  const expiresAt =
    Math.floor(
      Math.min(roomExpiresAt, Date.now() + duration(env.TURN_TTL_SECONDS, 300, 600)) / 1000,
    ) * 1000;
  const iceServers: IceConfiguration['iceServers'] = stun.length ? [{ urls: stun }] : [];
  if (turn.length && env.TURN_SHARED_SECRET) {
    if (env.TURN_SHARED_SECRET.length < 32)
      throw new HttpError(
        503,
        'SERVICE_UNAVAILABLE',
        'TURN secret must contain at least 32 characters.',
      );
    const username = `${expiresAt / 1000}:${crypto.randomUUID()}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.TURN_SHARED_SECRET),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
    iceServers.push({
      urls: turn,
      username,
      credential: btoa(String.fromCharCode(...new Uint8Array(signature))),
    });
  }
  return { iceServers, relayAvailable: turn.length > 0, expiresAt };
}
