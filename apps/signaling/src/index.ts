import {
  DEFAULT_FRAME_BYTES,
  MAX_CONTROL_MESSAGE_BYTES,
  PROTOCOL_VERSION,
} from '@meshdrop/protocol';
import { allowedOrigins } from './env';
import type { Env } from './env';
import { HttpError, errorResponse, secureResponse } from './errors';
import { throttle } from './limits';
import { createSession, roomRoute } from './routes/sessions';
import { bearer } from './auth/capabilities';
import { socketCredential } from './auth/tickets';
import { operatorAuthorized, readiness } from './operations';
import { audit } from './audit';
import { uuidSchema } from '@meshdrop/protocol';
export { SessionRoom } from './durable/SessionRoom';

/** Public control plane. No file bodies or credentials in URLs. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    let origin: string | undefined;
    let operation = 'other';
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health')
        return secureResponse(
          Response.json({
            service: 'meshdrop-signaling',
            phase: 'P9',
            status: 'alive',
            sessionsAvailable: env.ADMISSION_PAUSED !== 'true',
          }),
          requestId,
        );
      if (request.method === 'GET' && path === '/ready') {
        const ready = await readiness(env);
        return secureResponse(Response.json({ ready }, { status: ready ? 200 : 503 }), requestId);
      }
      if (request.method === 'GET' && path === '/v1/protocol')
        return secureResponse(
          Response.json({
            version: PROTOCOL_VERSION,
            maxControlMessageBytes: MAX_CONTROL_MESSAGE_BYTES,
            defaultFrameBytes: DEFAULT_FRAME_BYTES,
          }),
          requestId,
        );
      if (path.startsWith('/ops/rooms/')) {
        operation = 'revoke';
        if (url.protocol !== 'https:' || url.search || request.method !== 'POST')
          throw new HttpError(403, 'FORBIDDEN', 'Operator request denied.');
        await throttle(request, env, false);
        await operatorAuthorized(request, env);
        const match = /^\/ops\/rooms\/([^/]+)\/revoke$/.exec(path);
        if (!match || !uuidSchema.safeParse(match[1]).success)
          throw new HttpError(404, 'NOT_FOUND', 'Route unavailable.');
        const response = await env.SESSION_ROOMS.get(env.SESSION_ROOMS.idFromName(match[1]!)).fetch(
          new Request('https://room.internal/operator-revoke', {
            method: 'POST',
            headers: {
              Authorization: request.headers.get('Authorization')!,
              'X-Request-Id': requestId,
            },
          }),
        );
        audit(env, operation, response.status);
        return secureResponse(response, requestId);
      }
      const route = path === '/v1/sessions' ? null : roomRoute(path);
      operation =
        !route && path === '/v1/sessions'
          ? 'create'
          : route?.action === 'join'
            ? 'join'
            : route?.action === 'ws'
              ? 'ws'
              : route
                ? 'control'
                : 'other';
      if (path !== '/v1/sessions' && !route)
        throw new HttpError(404, 'NOT_FOUND', 'Route unavailable.');
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new HttpError(403, 'FORBIDDEN', 'HTTPS is required outside local development.');
      if (url.search)
        throw new HttpError(
          400,
          'INVALID_MESSAGE',
          'Query parameters are not accepted on session routes.',
        );
      const requestedOrigin = request.headers.get('Origin');
      if (!requestedOrigin || !allowedOrigins(env).includes(requestedOrigin))
        throw new HttpError(403, 'INVALID_ORIGIN', 'Origin is not allowed.');
      origin = requestedOrigin;
      const method = route
        ? (
            {
              status: 'GET',
              join: 'POST',
              decisions: 'POST',
              'ws-ticket': 'POST',
              'ice-credentials': 'POST',
              connection: 'POST',
              ws: 'GET',
              close: 'DELETE',
            } as Record<string, string>
          )[route.action]
        : 'POST';
      if (request.method === 'OPTIONS') {
        if (
          request.headers.get('Access-Control-Request-Method') !== method ||
          request.headers
            .get('Access-Control-Request-Headers')
            ?.toLowerCase()
            .split(',')
            .map((header) => header.trim())
            .some((header) => !['authorization', 'content-type'].includes(header))
        )
          throw new HttpError(403, 'FORBIDDEN', 'Preflight request is not allowed.');
        return secureResponse(
          new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Methods': method,
              'Access-Control-Allow-Headers': 'Authorization, Content-Type',
              'Access-Control-Max-Age': '600',
            },
          }),
          requestId,
          origin,
        );
      }
      if (request.method !== method)
        throw new HttpError(405, 'INVALID_MESSAGE', 'Method is not allowed.');
      await throttle(request, env, !route);
      if (!route && env.ADMISSION_PAUSED === 'true')
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'New rooms are temporarily paused.', true);
      if (route) {
        // Reject missing/malformed proof before resolving a stateful room actor.
        if (route.action === 'ws') socketCredential(request);
        else bearer(request);
      }
      let response: Response;
      if (!route) response = await createSession(request, env, requestId);
      else {
        const headers = new Headers(request.headers);
        headers.set('X-Request-Id', requestId);
        const internal = new Request(`https://room.internal/${route.action}`, {
          method: request.method,
          headers,
          ...(request.body ? { body: request.body } : {}),
        });
        response = await env.SESSION_ROOMS.get(env.SESSION_ROOMS.idFromName(route.roomId)).fetch(
          internal,
        );
      }
      audit(env, operation, response.status);
      return secureResponse(response, requestId, origin);
    } catch (error) {
      const response = errorResponse(error, requestId);
      audit(env, operation, response.status);
      return secureResponse(response, requestId, origin);
    }
  },
} satisfies ExportedHandler<Env>;
