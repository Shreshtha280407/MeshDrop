import { HttpError } from './errors';
import { verifier } from './auth/capabilities';
import type { Env } from './env';

export const MAX_HTTP_BODY_BYTES = 8192;
export const MAX_PEER_MESSAGES_PER_WINDOW = 60;
export const MESSAGE_WINDOW_MS = 10000;
export const MAX_SOCKET_VIOLATIONS = 3;
export const SOCKET_IDLE_MS = 120000;
export const HOUSEKEEPING_MS = 30000;

export async function throttle(request: Request, env: Env, create: boolean): Promise<void> {
  if (!env.REQUEST_LIMITER || !env.CREATE_LIMITER)
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Admission limits are unavailable.', true);
  // CF supplies this header at the public edge. Never log or persist raw addresses.
  const key = await verifier(
    'rate',
    String(Math.floor(Date.now() / 86400000)),
    request.headers.get('CF-Connecting-IP') ?? 'local-development',
  );
  if (
    !(await env.REQUEST_LIMITER.limit({ key })).success ||
    (create && !(await env.CREATE_LIMITER.limit({ key })).success)
  )
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Try again later.', true);
}
export async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new HttpError(415, 'INVALID_MESSAGE', 'Expected application/json.');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_HTTP_BODY_BYTES))
    throw new HttpError(413, 'MESSAGE_TOO_LARGE', 'Request body exceeds byte limit.');
  if (!request.body) throw new HttpError(400, 'INVALID_MESSAGE', 'A JSON object is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HTTP_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'MESSAGE_TOO_LARGE', 'Request body exceeds byte limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid JSON request.');
  }
}
