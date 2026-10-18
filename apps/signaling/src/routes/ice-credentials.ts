import type { IceConfiguration } from '@meshdrop/protocol';
import { duration } from '../env';
import type { Env } from '../env';
import { iceUrls, turnProvider } from '../turn-config';
import { cloudflareTurn } from './cloudflare-turn';

/** coturn TURN REST credentials: expiry:opaque-id and base64(HMAC-SHA1(secret, username)). */
export async function iceCredentials(env: Env, roomExpiresAt: number): Promise<IceConfiguration> {
  const stun = iceUrls(env.STUN_URLS, false);
  const turn = iceUrls(env.TURN_URLS, true);
  const provider = turnProvider(env);
  const expiresAt =
    Math.floor(
      Math.min(roomExpiresAt, Date.now() + duration(env.TURN_TTL_SECONDS, 300, 600)) / 1000,
    ) * 1000;
  const iceServers: IceConfiguration['iceServers'] = stun.length ? [{ urls: stun }] : [];
  if (provider === 'cloudflare') {
    const credentials = await cloudflareTurn(env, expiresAt);
    return { ...credentials, iceServers: [...iceServers, ...credentials.iceServers] };
  }
  if (turn.length && env.TURN_SHARED_SECRET) {
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
