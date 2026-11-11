import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const { assertDeviceTestIdentity } = await import(
  pathToFileURL(resolve('scripts/local-dev/device-test-identity.mjs')).href
);
const identity = {
  purpose: 'isolated-task13-test',
  sourceCommit: 'a'.repeat(40),
  sourceDiffSha256: 'b'.repeat(64),
  buildSha256: 'c'.repeat(64),
  productionApproved: false,
  productionMutations: 0,
};
it('matches a complete local build identity without granting release trust', () => {
  expect(() => assertDeviceTestIdentity(identity, { ...identity })).not.toThrow();
});
it.each([
  { purpose: 'production' },
  { productionApproved: true },
  { productionMutations: 1 },
  { sourceCommit: 'd'.repeat(40) },
  { sourceDiffSha256: 'd'.repeat(64) },
  { buildSha256: 'd'.repeat(64) },
  { buildSha256: undefined },
])('rejects substituted or incomplete current-build pins %j', (patch) => {
  expect(() => assertDeviceTestIdentity(identity, { ...identity, ...patch })).toThrow(
    'IOS_CURRENT_BUILD_IDENTITY_MISMATCH',
  );
});
it('does not accept two matching but incomplete build records', () => {
  const incomplete = { purpose: 'isolated-task13-test', productionApproved: false };
  expect(() => assertDeviceTestIdentity(incomplete, incomplete)).toThrow(
    'IOS_CURRENT_BUILD_IDENTITY_MISMATCH',
  );
});

// These commands fail before loading provider credentials, starting browsers or making requests.
it.each([
  ['https://production.example.test', '/not-read'],
  ['https://preview.pages.dev', '/not-read'],
  ['http://127.0.0.1:5173', '/not-read'],
  ['https://isolated.trycloudflare.com', ''],
])('rejects unisolated device-cloud scope %s', (origin, identity) => {
  const result = spawnSync(
    process.execPath,
    ['scripts/local-dev/verify-platforms.mjs', 'iphone-normal'],
    {
      env: { MESHDROP_TEST_URL: origin, MESHDROP_DEVICE_TEST_IDENTITY: identity },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    'Explicit disposable HTTPS origin and current-build identity file required.',
  );
});
it('requires an explicitly selected device case rather than silently testing a default public origin', () => {
  const result = spawnSync(process.execPath, ['scripts/local-dev/verify-platforms.mjs'], {
    env: {},
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Choose explicit cases:');
});
