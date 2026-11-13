import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { secretFindings } = await import(
  pathToFileURL(resolve('scripts/security/secret-policy.mjs')).href
);
it.each([
  'CLOUDFLARE_API_TOKEN',
  'METERED_SECRET_KEY',
  'TURN_SHARED_SECRET',
  'BROWSERSTACK_ACCESS_KEY',
  'OPS_REVOKE_SECRET',
  'REHEARSAL_DB_PASSWORD',
  'REHEARSAL_FAULT_DB_READER_PASSWORD',
  'PREVIEW_CANARY_API_TOKEN',
])('flags an opaque literal %s without echoing it', (key) => {
  const secret = 'x'.repeat(41);
  const found = secretFindings(`${key}: ${JSON.stringify(secret)}`);
  expect(found).toContain('possible literal provider/operator credential');
  expect(JSON.stringify(found).includes(secret)).toBe(false);
});
it('flags concrete invitations, percent-encoded query capabilities and password URLs', () => {
  const secret = 'y'.repeat(43),
    room = '123e4567-e89b-42d3-a456-426614174000';
  expect(secretFindings(`https://app.example.test/#room=${room}&invite=${secret}`)).toContain(
    'possible literal invitation capability',
  );
  expect(secretFindings(`https://app.example.test/path?token=${'%79'.repeat(43)}`)).toContain(
    'possible secret in URL query',
  );
  expect(secretFindings('postgresql://reader:' + secret + '@db.example.test/evidence')).toContain(
    'possible credential-bearing URL',
  );
});
it('retains known-key/private-key detections using only runtime-assembled synthetic samples', () => {
  for (const text of [
    'gh' + 'p_' + 'a'.repeat(40),
    'AK' + 'IA' + 'A'.repeat(16),
    '-----BEGIN ' + 'PRIVATE KEY-----',
  ])
    expect(secretFindings(text).length).toBeGreaterThan(0);
});
it('allows explicit synthetic fixtures, empty examples and runtime references', () => {
  for (const text of [
    "CLOUDFLARE_API_TOKEN: 'synthetic-token-for-local-fixtures-only'",
    'OPS_REVOKE_SECRET=',
    'TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET',
    'https://host.example.test/?token=${secret}',
    'https://host.example.test/?token=YOUR_REVIEWED_TOKEN',
  ])
    expect(secretFindings(text)).toEqual([]);
});
