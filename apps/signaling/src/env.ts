export interface Env {
  SESSION_ROOMS: DurableObjectNamespace;
  REQUEST_LIMITER: RateLimit;
  CREATE_LIMITER: RateLimit;
  ALLOWED_ORIGINS: string;
  STUN_URLS?: string;
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  TURN_PROVIDER?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  ROOM_TTL_SECONDS?: string;
  INVITE_TTL_SECONDS?: string;
  WS_TICKET_TTL_SECONDS?: string;
  CLOSED_TOMBSTONE_SECONDS?: string;
  ENVIRONMENT?: string;
  ADMISSION_PAUSED?: string;
  AUDIT_LOGS?: string;
  OPS_REVOKE_SECRET?: string;
}
export function duration(value: string | undefined, fallback: number, maximum: number): number {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > maximum)
    throw new Error('Invalid server duration configuration.');
  return seconds * 1000;
}
export function allowedOrigins(env: Env): readonly string[] {
  if (!env.ALLOWED_ORIGINS) return [];
  return env.ALLOWED_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter((value) => {
      try {
        const url = new URL(value);
        return (
          url.origin === value &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    });
}
