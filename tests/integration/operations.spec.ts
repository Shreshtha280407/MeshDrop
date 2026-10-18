import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { API, capability, connect, create, request, runtime, storage } from './harness';

describe('P9 operational controls', () => {
  let worker: Miniflare | undefined;
  afterEach(async () => {
    await worker?.dispose();
  });
  it('drains new rooms while keeping liveness and rejecting readiness', async () => {
    worker = await runtime({ bindings: { ADMISSION_PAUSED: 'true' } });
    expect((await worker.dispatchFetch(`${API}/health`)).status).toBe(200);
    expect((await worker.dispatchFetch(`${API}/ready`)).status).toBe(503);
    expect((await request(worker, '/v1/sessions', { method: 'POST', body: {} })).status).toBe(503);
  });
  it('checks deployment secrets and complete relay config without creating an actor', async () => {
    worker = await runtime({
      bindings: {
        ENVIRONMENT: 'production',
        ALLOWED_ORIGINS: 'https://meshdrop.test',
        OPS_REVOKE_SECRET: capability(),
      },
    });
    expect((await worker.dispatchFetch(`${API}/ready`)).status).toBe(200);
    await worker.dispose();
    worker = await runtime({ bindings: { TURN_URLS: 'turn:relay.example.com:3478' } });
    expect((await worker.dispatchFetch(`${API}/ready`)).status).toBe(503);
  });
  it('requires a separate operator proof and closes sockets and tickets on revocation', async () => {
    const operator = capability();
    worker = await runtime({ bindings: { OPS_REVOKE_SECRET: operator } });
    const room = await create(worker);
    const socket = await connect(worker, room.roomId, room.ownerCapability);
    try {
      for (const token of [undefined, capability(), room.ownerCapability]) {
        const response = await request(worker, `/ops/rooms/${room.roomId}/revoke`, {
          method: 'POST',
          ...(token ? { token } : {}),
        });
        expect([401, 403]).toContain(response.status);
      }
      expect(
        (
          await request(worker, `/ops/rooms/${room.roomId}/revoke?cap=forbidden`, {
            method: 'POST',
            token: operator,
          })
        ).status,
      ).toBe(403);
      const revoke = await request(worker, `/ops/rooms/${room.roomId}/revoke`, {
        method: 'POST',
        token: operator,
      });
      expect(revoke.status).toBe(200);
      expect(await revoke.json()).toEqual({ state: 'closed' });
      await expect.poll(() => socket.closed).toBe(true);
      expect(
        (
          await request(worker, `/v1/sessions/${room.roomId}/ws-ticket`, {
            method: 'POST',
            token: room.ownerCapability,
            body: {},
          })
        ).status,
      ).toBe(410);
      const db = await storage(worker, room.roomId);
      const count = await db.exec('SELECT count(*) AS count FROM ticket_nonces');
      expect(count[0]?.count).toBe(0);
    } finally {
      socket.close();
    }
  });
  it('leaves operator access disabled without its secret', async () => {
    worker = await runtime();
    expect(
      (
        await request(worker, `/ops/rooms/${crypto.randomUUID()}/revoke`, {
          method: 'POST',
          token: capability(),
        })
      ).status,
    ).toBe(503);
  });
});
