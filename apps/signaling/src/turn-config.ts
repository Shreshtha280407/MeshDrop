import { HttpError } from './http-error';

export type TurnSettings = {
  [Key in
    | 'TURN_PROVIDER'
    | 'TURN_URLS'
    | 'TURN_SHARED_SECRET'
    | 'CLOUDFLARE_TURN_KEY_ID'
    | 'CLOUDFLARE_TURN_API_TOKEN']?: string | undefined;
};

export function iceUrls(value: string | undefined, turn: boolean): string[] {
  if (!value?.trim()) return [];
  const list = value.split(',').map((url) => url.trim());
  const pattern = turn
    ? /^turns?:[a-zA-Z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/
    : /^stuns?:[a-zA-Z0-9.\-[\]:]+$/;
  if (list.length > 8 || list.some((url) => url.length > 512 || !pattern.test(url)))
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Invalid ICE server configuration.');
  return list;
}

/** Validate configuration without calling a provider or minting temporary credentials. */
export function turnProvider(env: TurnSettings): 'direct' | 'coturn' | 'cloudflare' {
  const urls = iceUrls(env.TURN_URLS, true);
  const secret = env.TURN_SHARED_SECRET?.trim() ?? '';
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim() ?? '';
  const token = env.CLOUDFLARE_TURN_API_TOKEN?.trim() ?? '';
  const provider = env.TURN_PROVIDER || (urls.length || secret ? 'coturn' : 'direct');
  const valid =
    provider === 'direct'
      ? !urls.length && !secret && !keyId && !token
      : provider === 'coturn'
        ? urls.length > 0 && secret.length >= 32 && !keyId && !token
        : provider === 'cloudflare'
          ? !urls.length &&
            !secret &&
            /^[a-f0-9]{32}$/.test(keyId) &&
            /^[A-Za-z0-9_-]{64}$/.test(token)
          : false;
  if (!valid)
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'TURN configuration is incomplete or mixed.');
  return provider as 'direct' | 'coturn' | 'cloudflare';
}
