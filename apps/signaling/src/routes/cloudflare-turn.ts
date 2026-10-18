import { iceConfigurationSchema } from '@meshdrop/protocol';
import type { IceConfiguration } from '@meshdrop/protocol';
import type { Env } from '../env';
import { HttpError } from '../errors';
import { readJson } from '../limits';

const TIMEOUT_MS = 5000;
const TURN_URL = /^turns?:turn\.cloudflare\.com:(3478|443|80|5349)\?transport=(udp|tcp)$/;

/** Provider keys stay in Worker secrets; only bounded, short-lived ICE credentials leave. */
export async function cloudflareTurn(
  env: Pick<Env, 'CLOUDFLARE_TURN_KEY_ID' | 'CLOUDFLARE_TURN_API_TOKEN'>,
  expiresAt: number,
  transport: typeof fetch = fetch,
): Promise<IceConfiguration> {
  try {
    // Reserve the entire API deadline so an issued credential cannot outlive
    // the room even if the provider starts its TTL at the end of that interval.
    const requestedAt = Date.now();
    const ttl = Math.floor((expiresAt - requestedAt - TIMEOUT_MS) / 1000);
    if (ttl < 1) throw new Error('No remaining credential lifetime.');
    const response = await transport(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (response.status !== 201) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Credential provider unavailable.');
    }
    // Reuse the existing byte/chunk/deadline-limited reader, including for
    // malformed/chunked upstream responses. Raw provider errors never escape.
    const body = await readJson(response);
    if (!body || typeof body !== 'object' || !('iceServers' in body))
      throw new Error('Invalid provider response.');
    const parsed = iceConfigurationSchema.parse({
      iceServers: body.iceServers,
      relayAvailable: true,
      // Refresh against the earliest possible expiry, not response arrival.
      expiresAt: requestedAt + ttl * 1000,
    });
    const servers = parsed.iceServers.filter((server) =>
      server.urls.some((url) => /^turns?:/.test(url)),
    );
    if (
      !servers.length ||
      servers.length > 7 ||
      parsed.expiresAt <= Date.now() ||
      servers.some(
        (server) =>
          !server.urls.length ||
          server.urls.some((url) => !TURN_URL.test(url)) ||
          !server.username ||
          !server.credential ||
          (env.CLOUDFLARE_TURN_API_TOKEN &&
            (server.username.includes(env.CLOUDFLARE_TURN_API_TOKEN) ||
              server.credential.includes(env.CLOUDFLARE_TURN_API_TOKEN))),
      )
    )
      throw new Error('Unsafe provider credentials.');
    return { ...parsed, iceServers: servers };
  } catch {
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'TURN credential service is unavailable.');
  }
}
