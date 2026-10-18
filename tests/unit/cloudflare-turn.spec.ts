import { describe, expect, it, vi } from 'vitest';
import { cloudflareTurn } from '../../apps/signaling/src/routes/cloudflare-turn';
import { turnProvider } from '../../apps/signaling/src/turn-config';
import { readiness } from '../../apps/signaling/src/operations';
import type { Env } from '../../apps/signaling/src/env';

const credentials = {
  CLOUDFLARE_TURN_KEY_ID: '1'.repeat(32),
  CLOUDFLARE_TURN_API_TOKEN: '2'.repeat(64),
};
const response = (overrides = {}) => ({
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'synthetic-temporary-username',
      credential: 'synthetic-temporary-credential',
      ...overrides,
    },
  ],
});

describe('Cloudflare TURN credential boundary', () => {
  it('sends only a bounded TTL to the fixed provider and advertises conservative expiry', async () => {
    const expires = Date.now() + 300000;
    const transport = vi.fn(async () => Response.json(response(), { status: 201 }));
    const result = await cloudflareTurn(credentials, expires, transport);
    const [url, options] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${credentials.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
    );
    const body = JSON.parse(String(options.body));
    expect(Object.keys(body)).toEqual(['ttl']);
    expect(body.ttl).toBeGreaterThan(280);
    expect(body.ttl).toBeLessThanOrEqual(295);
    expect(options.redirect).toBe('error');
    expect(result.expiresAt).toBeLessThanOrEqual(expires - 5000);
    expect(result.iceServers).toHaveLength(1);
    expect(result.relayAvailable).toBe(true);
    expect(JSON.stringify(result)).not.toContain(credentials.CLOUDFLARE_TURN_API_TOKEN);
  });
  it.each([
    { urls: ['turn:attacker.invalid:3478?transport=udp'] },
    { urls: ['turns:turn.cloudflare.com:53?transport=tcp'] },
    { credential: `leak-${credentials.CLOUDFLARE_TURN_API_TOKEN}` },
    { username: '' },
    { credential: 'x'.repeat(257) },
  ])('rejects invalid or secret-bearing provider data without exposing it', async (overrides) => {
    const transport = vi.fn(async () => Response.json(response(overrides), { status: 201 }));
    await expect(cloudflareTurn(credentials, Date.now() + 300000, transport)).rejects.toMatchObject(
      { status: 503, message: 'TURN credential service is unavailable.' },
    );
  });
  it('bounds an oversized upstream body and redacts provider failures', async () => {
    for (const value of [
      new Response(credentials.CLOUDFLARE_TURN_API_TOKEN, { status: 403 }),
      new Response('x'.repeat(8193), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      await expect(
        cloudflareTurn(credentials, Date.now() + 300000, async () => value),
      ).rejects.toMatchObject({ status: 503, message: 'TURN credential service is unavailable.' });
    }
  });
  it('does not mint credentials when the room is too close to expiry', async () => {
    const transport = vi.fn();
    await expect(cloudflareTurn(credentials, Date.now() + 4000, transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects mixed providers and incomplete keys', () => {
    expect(turnProvider({ TURN_PROVIDER: 'cloudflare', ...credentials })).toBe('cloudflare');
    for (const value of [
      { TURN_PROVIDER: 'cloudflare' },
      { TURN_PROVIDER: 'direct', ...credentials },
      { TURN_PROVIDER: 'cloudflare', ...credentials, TURN_SHARED_SECRET: 'x'.repeat(32) },
    ])
      expect(() => turnProvider(value)).toThrow();
  });
  it('checks readiness without calling the provider or consuming credential quota', async () => {
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
    try {
      expect(
        await readiness({
          ALLOWED_ORIGINS: 'http://localhost:5173',
          TURN_PROVIDER: 'cloudflare',
          ...credentials,
        } as Env),
      ).toBe(true);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });
});
