import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
export function offlineShell(): Plugin {
  return {
    name: 'meshdrop-offline-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const publicFiles = [
        'manifest.webmanifest',
        'icon.svg',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'apple-touch-icon.png',
      ];
      const assets = [
        '/',
        ...publicFiles.map((file) => `/${file}`),
        ...Object.keys(bundle)
          .filter((file) => file.startsWith('assets/') && /\.(?:js|css|woff2|png|svg)$/.test(file))
          .map((file) => `/${file}`),
      ];
      const digest = createHash('sha256').update(JSON.stringify(assets));
      for (const file of publicFiles)
        digest.update(readFileSync(fileURLToPath(new URL(`public/${file}`, import.meta.url))));
      const version = digest.digest('hex').slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `/* MeshDrop: static UI shell only. No file data, credentials or API caching. */
const CACHE='meshdrop-shell-${version}';
const ASSETS=new Set(${JSON.stringify(assets)});
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll([...ASSETS].map(path=>new Request(path,{cache:'reload',credentials:'omit'}))))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=(await caches.keys()).filter(key=>key.startsWith('meshdrop-shell-'));const old=keys.filter(key=>key!==CACHE);for(const key of old.slice(0,-1))await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data==='ACTIVATE_SHELL_UPDATE')self.skipWaiting();});
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.search||request.headers.has('range')||request.headers.has('authorization')||!ASSETS.has(url.pathname))return;
event.respondWith((async()=>{try{const response=await fetch(request);if(response.ok){const cache=await caches.open(CACHE);await cache.put(request,response.clone());}return response;}catch{const cached=await caches.match(request,{cacheName:CACHE,ignoreVary:true});return cached||Response.error();}})());});
`,
      });
    },
  };
}
