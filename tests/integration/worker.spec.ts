import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { randomUUID } from 'node:crypto';
import { DEFAULT_FRAME_BYTES, PROTOCOL_VERSION } from '@meshdrop/protocol';
import { API, ORIGIN, request, runtime } from './harness';

describe('P1 Worker routing and HTTP boundary', () => {
  let worker: Miniflare;
  beforeAll(async () => {
    worker = await runtime();
  });
  afterAll(async () => {
    await worker.dispose();
  });
  it('reports the control plane without claiming file transfer', async () => {
    const response = await worker.dispatchFetch(`${API}/health`);
    expect(await response.json()).toMatchObject({ phase: 'P3', sessionsAvailable: true });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-Id')).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('shares browser protocol constants', async () => {
    const response = await worker.dispatchFetch(`${API}/v1/protocol`);
    expect(await response.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      defaultFrameBytes: DEFAULT_FRAME_BYTES,
    });
  });
  it.each(['/upload', '/initialize', '/unknown'])('has no public route %s', async (path) => {
    expect((await request(worker, path, { method: 'POST', body: {} })).status).toBe(404);
  });
  it.each(['https://evil.test', 'null', `${ORIGIN}.evil.test`, '*'])(
    'rejects untrusted origin %s',
    async (origin) => {
      const response = await request(worker, '/v1/sessions', { method: 'POST', body: {}, origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'INVALID_ORIGIN',
        requestId: expect.any(String),
      });
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    },
  );
  it('rejects missing origins and credentials in URL queries', async () => {
    const missing = await worker.dispatchFetch(`${API}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(403);
    const query = await request(worker, '/v1/sessions?token=do-not-echo', {
      method: 'POST',
      body: {},
    });
    expect(query.status).toBe(400);
    expect(await query.text()).not.toContain('do-not-echo');
  });
  it('rejects plaintext session access outside loopback development', async () => {
    const response = await worker.dispatchFetch('http://api.meshdrop.test/v1/sessions', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
  it('allows exact preflights and rejects unexpected headers/methods', async () => {
    const response = await request(worker, '/v1/sessions', {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(
      (
        await request(worker, '/v1/sessions', {
          method: 'OPTIONS',
          headers: {
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'x-role',
          },
        })
      ).status,
    ).toBe(403);
    expect((await request(worker, '/v1/sessions')).status).toBe(405);
  });
  it('rejects invalid identifiers, unknown creation fields, and bad JSON', async () => {
    expect((await request(worker, '/v1/sessions/not-a-uuid/status')).status).toBe(400);
    expect(
      (await request(worker, '/v1/sessions', { method: 'POST', body: { role: 'owner' } })).status,
    ).toBe(400);
    const malformed = await worker.dispatchFetch(`${API}/v1/sessions`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: 'secret-invalid-body',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('secret-invalid-body');
  });
  it('checks HTTP body caps and content type', async () => {
    expect(
      (await request(worker, '/v1/sessions', { method: 'POST', body: { huge: 'x'.repeat(9000) } }))
        .status,
    ).toBe(413);
    expect(
      (
        await worker.dispatchFetch(`${API}/v1/sessions`, {
          method: 'POST',
          headers: { Origin: ORIGIN },
          body: '{}',
        })
      ).status,
    ).toBe(415);
  });
  it('throttles creations before allocating more actors', async () => {
    const limited = await runtime({ createLimit: 1 });
    try {
      expect((await request(limited, '/v1/sessions', { method: 'POST', body: {} })).status).toBe(
        201,
      );
      const denied = await request(limited, '/v1/sessions', { method: 'POST', body: {} });
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
      expect(await limited.listDurableObjectIds('SessionRoom')).toHaveLength(1);
    } finally {
      await limited.dispose();
    }
  });
  it('rejects missing proof before allocating an unknown room actor', async () => {
    const before = await worker.listDurableObjectIds('SessionRoom');
    const roomId = randomUUID();
    expect((await request(worker, `/v1/sessions/${roomId}/status`)).status).toBe(401);
    expect(
      (await request(worker, `/v1/sessions/${roomId}/ws`, { headers: { Upgrade: 'websocket' } }))
        .status,
    ).toBe(401);
    expect(await worker.listDurableObjectIds('SessionRoom')).toHaveLength(before.length);
  });
});
