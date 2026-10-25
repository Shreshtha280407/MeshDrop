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
  if (provider === 'metered') {
    if (!env.RELAY_POOLS) return { iceServers, relayAvailable: false, expiresAt };
    try {
      const response = await env.RELAY_POOLS.get(env.RELAY_POOLS.idFromName('deployment')).fetch(
        new Request('https://relay.internal/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomExpiresAt }),
        }),
      );
      if (!response.ok) throw new Error('Relay unavailable.');
      const { iceConfigurationSchema } = await import('@meshdrop/protocol');
      const relay = iceConfigurationSchema.parse(await response.json());
      return { ...relay, iceServers: [...iceServers, ...relay.iceServers] };
    } catch {
      return { iceServers, relayAvailable: false, expiresAt };
    }
  }
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
