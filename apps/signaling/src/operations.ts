import { bearer } from './auth/capabilities';
import { allowedOrigins, duration } from './env';
import type { Env } from './env';
import { HttpError } from './errors';
import { iceUrls, turnProvider } from './turn-config';

export async function operatorAuthorized(request: Request, env: Env): Promise<void> {
  if (!env.OPS_REVOKE_SECRET || !/^[A-Za-z0-9_-]{43}$/.test(env.OPS_REVOKE_SECRET))
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Operator access is disabled.');
  const supplied = bearer(request);
  const digest = (value: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(supplied), digest(env.OPS_REVOKE_SECRET)]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  if (difference) throw new HttpError(403, 'FORBIDDEN', 'Operator access denied.');
}

export async function readiness(env: Env): Promise<boolean> {
  try {
    const origins = allowedOrigins(env);
    if (!origins.length) return false;
    if (env.ENVIRONMENT && env.ENVIRONMENT !== 'development') {
      if (origins.length !== 1 || !origins[0]!.startsWith('https://')) return false;
      if (!/^[A-Za-z0-9_-]{43}$/.test(env.OPS_REVOKE_SECRET ?? '')) return false;
    }
    duration(env.ROOM_TTL_SECONDS, 900, 3600);
    duration(env.INVITE_TTL_SECONDS, 300, 3600);
    duration(env.WS_TICKET_TTL_SECONDS, 30, 60);
    duration(env.TURN_TTL_SECONDS, 300, 600);
    iceUrls(env.STUN_URLS, false);
    turnProvider(env);
    return env.ADMISSION_PAUSED !== 'true';
  } catch {
    return false;
  }
}
