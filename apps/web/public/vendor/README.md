# QR dependency licenses

Phase 8 replaces the standalone UMD distribution with lazy, self-hosted Vite chunks built from exact npm dependencies: `@zxing/browser` 0.2.1 and `@zxing/library` 0.23.0. Their complete resolved dependency versions and registry integrity records are in `pnpm-lock.yaml`; they are included in `pnpm audit:release`. No CDN or external QR service is used.

The adjacent wrapper MIT, core Apache 2.0 and text-encoding Unlicense/Apache license notices are retained. Upstream sources: https://github.com/zxing-js/browser, https://github.com/zxing-js/library and https://github.com/zxing-js/text-encoding. The old UMD script and its loader/SRI are removed. The offline shell caches only public generated code, never invitations or camera frames.
