# ZXing local browser bundle

`zxing-browser-0.2.1.min.js` is the unmodified UMD distribution from `@zxing/browser` 0.2.1. Its browser wrapper uses the adjacent MIT license. The bundled ZXing core uses Apache 2.0; its license is also included, along with the text-encoding dependency's Unlicense/Apache terms. Sources: https://github.com/zxing-js/browser, https://github.com/zxing-js/library and https://github.com/zxing-js/text-encoding. Distribution: https://registry.npmjs.org/@zxing/browser/-/browser-0.2.1.tgz. Core license obtained from the official `@zxing/library` 0.23.0 package; encoding license from the official repository. The browser UMD build does not publish a complete embedded dependency version manifest.

The npm tarball was verified against its registry integrity:

```text
sha512-92pVfVDUXbc15xu9vIEmhNyqIEASMEkDF92CwT6T+7sg2EHXJRktH9CQKoQSXe51UtbNsj+Fm09H/JBWHMs/Sw==
```

The exact 441,121-byte script is checked with SRI when loaded:

```text
sha384-HRtzk9lZgkbSgvUyQrnfC/GxiXZgwaNyD7hC9wcXlsBpDhkS80ISl73juef2FRuf
```

Vendoring this complete browser distribution keeps QR encoding and decoding local and reproducible despite the development machine's intermittent package-registry DNS. The QR loader executes it only when QR features are requested; the production offline shell also precaches the static script. No CDN, analytics or QR-upload service is used. Invitations and camera frames are never cached. Keep the licenses and update this integrity record and the loader together when upgrading.
