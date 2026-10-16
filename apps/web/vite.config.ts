import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      '@meshdrop/transfer-core > @noble/hashes/sha2.js',
      '@meshdrop/storage > @noble/hashes/sha2.js',
      '@meshdrop/storage > zod',
    ],
  },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8787',
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, request) => {
            if (!request.headers.origin) outgoing.setHeader('Origin', 'http://127.0.0.1:5173');
          });
        },
      },
    },
  },
});
