import type { ErrorCode } from '@meshdrop/protocol';
import type { ApiError } from '@meshdrop/shared-types';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
export function errorResponse(error: unknown, requestId: string): Response {
  const known =
    error instanceof HttpError
      ? error
      : new HttpError(500, 'INTERNAL_ERROR', 'Request could not be completed.', true);
  const body: ApiError = {
    code: known.code,
    message: known.message,
    requestId,
    retryable: known.retryable,
  };
  return Response.json(body, {
    status: known.status,
    headers: known.status === 429 ? { 'Retry-After': '60' } : {},
  });
}
export function secureResponse(response: Response, requestId: string, origin?: string): Response {
  // Clone mutable headers while explicitly retaining a WebSocket upgrade.
  response = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    ...(response.webSocket ? { webSocket: response.webSocket } : {}),
  });
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}
