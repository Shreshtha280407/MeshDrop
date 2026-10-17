import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineShell } from './pwa';

export default defineConfig({
  plugins: [react(), offlineShell()],
  optimizeDeps: {
    include: [
      '@meshdrop/transfer-core > @noble/hashes/sha2.js',
      '@meshdrop/storage > @noble/hashes/sha2.js',
      '@meshdrop/storage > zod',
      '@meshdrop/network-intelligence > zod',
    ],
  },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: process.env.MESHDROP_SIGNAL_ORIGIN ?? 'http://127.0.0.1:8787',
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            if (!request.headers.origin)
              outgoing.setHeader('Origin', `http://${request.headers.host ?? '127.0.0.1:5173'}`);
          });
        },
      },
    },
  },
});
