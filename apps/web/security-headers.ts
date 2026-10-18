import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { browserHeaders } from './browser-policy';
export { browserHeaders } from './browser-policy';

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
