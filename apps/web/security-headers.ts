import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function browserHeaders(development = false): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
      `style-src 'self'${development ? " 'unsafe-inline'" : ''}`,
      "img-src 'self' blob: data:",
      "media-src 'self' blob:",
      "worker-src 'self'",
      `connect-src 'self'${development ? ' ws://127.0.0.1:5173 ws://localhost:5173' : ''}`,
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(self), web-share=(self)',
  };
}

/** Preview exercises the same policy emitted for the eventual static host. */
export function securityHeaders(): Plugin {
  const install =
    (development: boolean) =>
    (_request: IncomingMessage, response: ServerResponse, next: () => void) => {
      for (const [name, value] of Object.entries(browserHeaders(development)))
        response.setHeader(name, value);
      next();
    };
  return {
    name: 'meshdrop-security-headers',
    configureServer(server) {
      server.middlewares.use(install(true));
    },
    configurePreviewServer(server) {
      server.middlewares.use(install(false));
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source:
          '/*\n' +
          Object.entries({ ...browserHeaders(), 'Strict-Transport-Security': 'max-age=31536000' })
            .map(([key, value]) => `  ${key}: ${value}`)
            .join('\n') +
          '\n',
      });
    },
  };
}
