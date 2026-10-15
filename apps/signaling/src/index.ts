import {
  DEFAULT_FRAME_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '@meshdrop/protocol';
import type { ApiError } from '@meshdrop/shared-types';

/** P0 read-only scaffold. Room APIs and DO authorization ship in P1. */
export default {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (request.method === 'GET' && path === '/health')
      return Response.json(
        {
          service: 'meshdrop-signaling',
          phase: 'P0',
          status: 'scaffold',
          sessionsAvailable: false,
        },
        { headers },
      );
    if (request.method === 'GET' && path === '/v1/protocol')
      return Response.json(
        {
          version: PROTOCOL_VERSION,
          maxControlMessageBytes: MAX_CONTROL_MESSAGE_BYTES,
          defaultFrameBytes: DEFAULT_FRAME_BYTES,
        },
        { headers },
      );
    const error: ApiError = {
      code: 'NOT_FOUND',
      message: 'Route unavailable.',
      requestId: crypto.randomUUID(),
      retryable: false,
    };
    return Response.json(error, { status: 404, headers });
  },
} satisfies ExportedHandler;
