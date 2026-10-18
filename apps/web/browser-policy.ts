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
