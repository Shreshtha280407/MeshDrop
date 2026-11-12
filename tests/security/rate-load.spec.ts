import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The app workspace separately typechecks Cloudflare's Env. This dynamic import
// exercises the real throttle with a deterministic binding contract, not Cloudflare capacity.
const { throttle } = (await import(
  pathToFileURL(resolve('apps/signaling/src/limits.ts')).href
)) as {
  throttle(
    request: Request,
    env: {
      REQUEST_LIMITER?: ReturnType<typeof limiter>;
      CREATE_LIMITER?: ReturnType<typeof limiter>;
    },
    create: boolean,
  ): Promise<void>;
};
function limiter(max: number) {
  const windows = new Map<string, { at: number; count: number }>();
  return {
    windows,
    async limit({ key }: { key: string }) {
      const old = windows.get(key),
        now = Date.now();
      const value = old && now - old.at < 60000 ? old : { at: now, count: 0 };
      windows.set(key, value);
      if (value.count >= max) return { success: false };
      value.count++;
      return { success: true };
    },
  };
}
const req = (ip = '192.0.2.14') =>
  new Request('https://local.test/v1/sessions', { headers: { 'CF-Connecting-IP': ip } });
afterEach(() => vi.useRealTimers());

it('tests limit-1, limit, limit+1, far-over-limit and exact window reset against the real throttle', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  const env = { REQUEST_LIMITER: limiter(300), CREATE_LIMITER: limiter(30) };
  for (let i = 0; i < 29; i++) await throttle(req(), env, true);
  await throttle(req(), env, true);
  for (let i = 0; i < 100; i++)
    await expect(throttle(req(), env, true)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  vi.setSystemTime(new Date('2026-11-12T12:00:59.999Z'));
  await expect(throttle(req(), env, true)).rejects.toMatchObject({ status: 429 });
  vi.setSystemTime(new Date('2026-11-12T12:01:00Z'));
  await expect(throttle(req(), env, true)).resolves.toBeUndefined();
});
it('keeps identities and binding scopes independent and retains hashed keys only', async () => {
  const a = { REQUEST_LIMITER: limiter(300), CREATE_LIMITER: limiter(1) },
    b = { REQUEST_LIMITER: limiter(300), CREATE_LIMITER: limiter(1) };
  await throttle(req(), a, true);
  await expect(throttle(req(), a, true)).rejects.toMatchObject({ status: 429 });
  await expect(throttle(req('192.0.2.15'), a, true)).resolves.toBeUndefined();
  await expect(throttle(req(), b, true)).resolves.toBeUndefined();
  expect([...a.CREATE_LIMITER.windows.keys()].every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(
    true,
  );
});
it('does not bypass the request limiter when creation allowance remains', async () => {
  const env = { REQUEST_LIMITER: limiter(1), CREATE_LIMITER: limiter(30) };
  await throttle(req(), env, false);
  await expect(throttle(req(), env, true)).rejects.toMatchObject({ status: 429 });
  expect(env.CREATE_LIMITER.windows.size).toBe(0);
});
it.each(['REQUEST_LIMITER', 'CREATE_LIMITER'] as const)(
  'fails closed if %s is unavailable',
  async (missing) => {
    const env = { REQUEST_LIMITER: limiter(300), CREATE_LIMITER: limiter(30) };
    delete (env as Partial<typeof env>)[missing];
    await expect(throttle(req(), env, true)).rejects.toMatchObject({ status: 503 });
  },
);
