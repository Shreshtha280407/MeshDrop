import { browserHeaders } from '../../apps/web/browser-policy';

export interface PagesEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SIGNALING: { fetch(request: Request): Promise<Response> };
  PUBLIC_ORIGIN: string;
}

function unavailable(status: number): Response {
  return new Response('MeshDrop is temporarily unavailable.', {
    status,
    headers: { 'Cache-Control': 'no-store', ...browserHeaders() },
  });
}

/** Same-origin HTTPS/WSS gateway; the signaling Worker has no public route. */
export default {
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    const url = new URL(request.url);
    // Pages' immutable/branch aliases must never borrow a production room binding.
    if (url.origin !== env.PUBLIC_ORIGIN) return unavailable(403);
    if (url.protocol !== 'https:') return unavailable(403);
    if (
      url.pathname === '/v1' ||
      url.pathname.startsWith('/v1/') ||
      url.pathname === '/ops' ||
      url.pathname.startsWith('/ops/') ||
      ['/health', '/ready'].includes(url.pathname)
    ) {
      const headers = new Headers(request.headers);
      // Same-origin GET fetches may omit Origin. Never infer trust for writes or
      // WebSocket upgrades, and never replace an explicitly untrusted Origin.
      if (
        !headers.has('Origin') &&
        request.method === 'GET' &&
        !headers.has('Upgrade') &&
        !url.pathname.startsWith('/ops/')
      )
        headers.set('Origin', env.PUBLIC_ORIGIN);
      try {
        return await env.SIGNALING.fetch(new Request(request, { headers }));
      } catch {
        // No request URL, header, invitation, file name or stack in logs/errors.
        return unavailable(503);
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return unavailable(405);
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(browserHeaders())) headers.set(key, value);
    headers.set('Strict-Transport-Security', 'max-age=31536000');
    return new Response(response.body, { status: response.status, headers });
  },
};
