import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMeteredKey,
  freeRelayUsage,
  meteredIce,
  meteredUsage,
  readyMeteredKey,
} from '../../apps/signaling/src/routes/metered-turn';
import type { MeteredKey } from '../../apps/signaling/src/routes/metered-turn';
import { turnProvider } from '../../apps/signaling/src/turn-config';
const env = {
  METERED_DOMAIN: 'meshdrop-test.metered.live',
  METERED_SECRET_KEY: 's'.repeat(32),
  METERED_FREE_ONLY: 'true',
};
const key: MeteredKey = {
  username: 'synthetic-user',
  apiKey: 'a'.repeat(32),
  createdAt: 1000000,
  readyAt: 1120000,
  expiresAt: 1600000,
  upperExpiresAt: 1605000,
};
afterEach(() => vi.useRealTimers());
describe('free relay credential and cost boundaries', () => {
  it('requires explicit free-only acknowledgement, an exact provider host and no mixed provider', () => {
    expect(turnProvider({ ...env, TURN_PROVIDER: 'metered' })).toBe('metered');
    for (const override of [
      { METERED_FREE_ONLY: '' },
      { METERED_DOMAIN: 'evil.test' },
      { METERED_DOMAIN: 'x.metered.live@evil.test' },
      { TURN_URLS: 'turn:other.test:3478' },
      { TURN_PROVIDER: 'direct' },
    ])
      expect(() => turnProvider({ ...env, TURN_PROVIDER: 'metered', ...override })).toThrow();
  });
  it.each([
    { quotaInGB: 50, usageInGB: 0, overageInGB: 0 },
    { quotaInGB: 0.5, usageInGB: 0, overageInGB: 1 },
    { quotaInGB: 0.5, usageInGB: -1, overageInGB: 0 },
    { quotaInGB: 0.5, usageInGB: NaN, overageInGB: 0 },
    { quotaInGB: 0.5, usageInGB: 0, overageInGB: -1 },
    { quotaInGB: 0.5 },
  ])('refuses paid/changed/invalid quota evidence %j', (value) =>
    expect(() => freeRelayUsage(value)).toThrow(),
  );
  it('keeps only the recognized free-usage fields', () => {
    expect(
      freeRelayUsage({ quotaInGB: 0.5, usageInGB: 0.1, overageInGB: 0, privateKey: 'ignored' }),
    ).toEqual({ quotaInGB: 0.5, usageInGB: 0.1, overageInGB: 0 });
  });
  it('never selects an unpropagated, expired or room-outliving key', () => {
    expect(readyMeteredKey([key], 2000000, 1119999)).toBeUndefined();
    expect(readyMeteredKey([key], 2000000, 1120000)).toEqual(key);
    expect(readyMeteredKey([key], 1604999, 1200000)).toBeUndefined();
    expect(readyMeteredKey([key], 2000000, 1585000)).toBeUndefined();
  });
  it('uses overlapping, already-propagated credentials across rotation', () => {
    const next = {
      ...key,
      createdAt: 1300000,
      readyAt: 1420000,
      expiresAt: 1900000,
      upperExpiresAt: 1905000,
    };
    expect(readyMeteredKey([key, next], 2200000, 1400000)).toEqual(key);
    expect(readyMeteredKey([key, next], 2200000, 1420000)).toEqual(next);
  });
  it('creates only a ten-minute key on the fixed provider with a full propagation delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const transport = vi.fn(async () => {
      vi.setSystemTime(1003000);
      return Response.json({
        username: 'synthetic-user',
        apiKey: 'a'.repeat(32),
        password: 'not-returned',
        expiryInSeconds: 600,
      });
    });
    const actual = await createMeteredKey(env, transport);
    expect(actual).toEqual({ ...key, readyAt: 1123000, upperExpiresAt: 1603000 });
    const [url, options] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).origin).toBe('https://meshdrop-test.metered.live');
    expect(options.redirect).toBe('manual');
    expect(JSON.parse(String(options.body))).toEqual({
      expiryInSeconds: 600,
      label: 'meshdrop-expiring-pool',
    });
    expect(JSON.stringify(actual)).not.toContain('not-returned');
  });
  it('rejects long-lived credentials and redacts provider errors', async () => {
    const bad = [
      Response.json({ username: 'synthetic-user', apiKey: 'a'.repeat(32), expiryInSeconds: 3600 }),
      new Response(env.METERED_SECRET_KEY, { status: 403 }),
    ];
    for (const response of bad)
      await expect(createMeteredKey(env, async () => response)).rejects.toMatchObject({
        status: 503,
        message: expect.not.stringContaining(env.METERED_SECRET_KEY),
      });
  });
  it('validates real ICE shapes while excluding credential-scoped and master API keys', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1200000);
    const response = () => [
      { urls: 'stun:stun.relay.metered.ca:80' },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username: key.username,
        credential: 'synthetic-password',
      },
    ];
    const result = await meteredIce(env, key, async () => Response.json(response()));
    expect(result.iceServers).toHaveLength(1);
    expect(result.expiresAt).toBe(key.expiresAt);
    for (const override of [
      { urls: 'turn:evil.test:443' },
      { username: 'wrong-user' },
      { credential: env.METERED_SECRET_KEY },
      { credential: key.apiKey },
    ])
      await expect(
        meteredIce(env, key, async () => Response.json([{ ...response()[1], ...override }])),
      ).rejects.toThrow();
  });
  it('bounds provider input before parsing and never follows redirects', async () => {
    await expect(
      meteredUsage(
        env,
        async () =>
          new Response('x'.repeat(8193), { headers: { 'Content-Type': 'application/json' } }),
      ),
    ).rejects.toThrow();
    const transport = vi.fn(async () =>
      Response.json({ quotaInGB: 0.5, usageInGB: 0, overageInGB: 0 }),
    );
    await meteredUsage(env, transport);
    expect((transport.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe(
      'manual',
    );
  });
});
