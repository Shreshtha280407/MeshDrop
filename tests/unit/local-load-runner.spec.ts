import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const { localLoadPlan } = await import(pathToFileURL(resolve('scripts/benchmarks/load.mjs')).href);
it('removes ambient provider accounts and forces the loopback test origin without mutating the parent environment', () => {
  const source = {
    PATH: '/test/tools',
    CLOUDFLARE_API_TOKEN: 'private-fixture',
    METERED_SECRET_KEY: 'private-fixture',
    TURN_SHARED_SECRET: 'private-fixture',
    OPS_REVOKE_SECRET: 'private-fixture',
    MESHDROP_SIGNAL_ORIGIN: 'https://live.example.test',
    BROWSERSTACK_ACCESS_KEY: 'private-fixture',
    GITHUB_TOKEN: 'private-fixture',
  };
  const plan = localLoadPlan('matrix', source);
  expect(plan.env.MESHDROP_SIGNAL_ORIGIN).toBe('http://127.0.0.1:8787');
  expect(plan.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe('false');
  expect(Object.values(plan.env)).not.toContain('private-fixture');
  expect(source.CLOUDFLARE_API_TOKEN).toBe('private-fixture');
  expect(plan.env.PATH).toBe(source.PATH);
});
it('never reuses an ambient dev server and fixes browser retries at zero', () => {
  const plan = localLoadPlan('browser', {});
  expect(plan.env.CI).toBe('true');
  expect(plan.steps).toEqual([
    [
      'exec',
      'playwright',
      'test',
      'tests/e2e/concurrent-transfers.spec.ts',
      '--workers',
      '1',
      '--retries',
      '0',
    ],
  ]);
});
it('rejects loaded local-secret files before running any test command', () => {
  expect(() => localLoadPlan('browser', {}, ['.dev.vars'])).toThrow('Local load refuses');
});
it.each(['production', 'https://live.example.test', 'deploy'])(
  'rejects arbitrary remote or deployment mode %s',
  (mode) => {
    expect(() => localLoadPlan(mode, {})).toThrow('Choose matrix or browser');
  },
);
