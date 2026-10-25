import { iceConfigurationSchema } from '@meshdrop/protocol';
import type { IceConfiguration } from '@meshdrop/protocol';
import type { Env } from '../env';
import { HttpError } from '../errors';
import { readJson } from '../limits';
import { turnProvider } from '../turn-config';

export const METERED_LIFETIME_MS = 600000;
export const METERED_PROPAGATION_MS = 120000;
export const METERED_ROTATION_MS = 300000;
export type MeteredEnv = Pick<Env, 'METERED_DOMAIN' | 'METERED_SECRET_KEY' | 'METERED_FREE_ONLY'>;
export interface MeteredKey {
  username: string;
  apiKey: string;
  createdAt: number;
  readyAt: number;
  expiresAt: number;
  upperExpiresAt: number;
}
export interface MeteredUsage {
  quotaInGB: number;
  usageInGB: number;
  overageInGB: number;
}
const unavailable = () =>
  new HttpError(
    503,
    'SERVICE_UNAVAILABLE',
    'Free relay is unavailable. Direct connectivity remains available.',
    true,
  );

async function providerRequest(
  env: MeteredEnv,
  path: '/current_usage' | '/credential' | '/credentials',
  credentialKey?: string,
  transport: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<unknown> {
  try {
    turnProvider({
      TURN_PROVIDER: 'metered',
      METERED_DOMAIN: env.METERED_DOMAIN,
      METERED_SECRET_KEY: env.METERED_SECRET_KEY,
      METERED_FREE_ONLY: env.METERED_FREE_ONLY,
    });
    const url = new URL(`https://${env.METERED_DOMAIN}/api/v1/turn${path}`);
    url.searchParams.set(
      credentialKey ? 'apiKey' : 'secretKey',
      credentialKey ?? env.METERED_SECRET_KEY!,
    );
    const response = await transport(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      ...(path === '/credential'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expiryInSeconds: METERED_LIFETIME_MS / 1000,
              label: 'meshdrop-expiring-pool',
            }),
          }
        : {}),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw unavailable();
    }
    return await readJson(response);
  } catch {
    throw unavailable();
  }
}

export function freeRelayUsage(value: unknown): MeteredUsage {
  if (!value || typeof value !== 'object') throw unavailable();
  const data = value as MeteredUsage;
  if (
    data.quotaInGB !== 0.5 ||
    !Number.isFinite(data.usageInGB) ||
    data.usageInGB < 0 ||
    !Number.isFinite(data.overageInGB) ||
    data.overageInGB !== 0
  )
    throw unavailable();
  return { quotaInGB: data.quotaInGB, usageInGB: data.usageInGB, overageInGB: data.overageInGB };
}
export async function meteredUsage(
  env: MeteredEnv,
  transport: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<MeteredUsage> {
  return freeRelayUsage(await providerRequest(env, '/current_usage', undefined, transport));
}
export async function createMeteredKey(
  env: MeteredEnv,
  transport: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<MeteredKey> {
  const createdAt = Date.now();
  const value = await providerRequest(env, '/credential', undefined, transport);
  if (!value || typeof value !== 'object') throw unavailable();
  const data = value as Record<string, unknown>;
  if (
    typeof data.username !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(data.username) ||
    typeof data.apiKey !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(data.apiKey) ||
    data.expiryInSeconds !== METERED_LIFETIME_MS / 1000 ||
    data.username.includes(env.METERED_SECRET_KEY!) ||
    data.apiKey.includes(env.METERED_SECRET_KEY!)
  )
    throw unavailable();
  const receivedAt = Date.now();
  return {
    username: data.username,
    apiKey: data.apiKey,
    createdAt,
    readyAt: receivedAt + METERED_PROPAGATION_MS,
    expiresAt: createdAt + METERED_LIFETIME_MS,
    upperExpiresAt: receivedAt + METERED_LIFETIME_MS,
  };
}
/** Never hand out a newly minted, expired or room-outliving credential. */
export function readyMeteredKey(
  keys: MeteredKey[],
  roomExpiresAt: number,
  now = Date.now(),
): MeteredKey | undefined {
  return keys
    .filter(
      (key) =>
        key.readyAt <= now &&
        key.expiresAt > now + 15000 &&
        key.upperExpiresAt <= roomExpiresAt &&
        key.upperExpiresAt <= now + METERED_LIFETIME_MS,
    )
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
}
export async function meteredIce(
  env: MeteredEnv,
  key: MeteredKey,
  transport: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<IceConfiguration> {
  const value = await providerRequest(env, '/credentials', key.apiKey, transport);
  if (!Array.isArray(value) || !value.length || value.length > 8) throw unavailable();
  try {
    const servers = value
      .map((item) => ({
        urls: typeof item?.urls === 'string' ? [item.urls] : item?.urls,
        ...(item?.username ? { username: item.username } : {}),
        ...(item?.credential ? { credential: item.credential } : {}),
      }))
      .filter((item) =>
        item.urls?.some((url: unknown) => typeof url === 'string' && /^turns?:/.test(url)),
      );
    const result = iceConfigurationSchema.parse({
      iceServers: servers,
      relayAvailable: true,
      expiresAt: key.expiresAt,
    });
    if (
      !result.iceServers.length ||
      result.expiresAt <= Date.now() ||
      result.iceServers.some(
        (server) =>
          server.username !== key.username ||
          !server.credential ||
          [server.username, server.credential].some(
            (value) => value.includes(env.METERED_SECRET_KEY!) || value.includes(key.apiKey),
          ) ||
          server.urls.some(
            (url) =>
              !/^turns?:[a-z0-9.-]+\.metered\.ca:(80|443|3478|5349)(?:\?transport=(udp|tcp))?$/.test(
                url,
              ),
          ),
      )
    )
      throw unavailable();
    return result;
  } catch {
    throw unavailable();
  }
}
