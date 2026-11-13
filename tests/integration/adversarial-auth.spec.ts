import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { sessionCreatedSchema } from '@meshdrop/protocol';
import {
  API,
  ORIGIN,
  approve,
  candidate,
  capability,
  connect,
  join,
  request,
  runtime,
  signal,
  storage,
  ticket,
} from './harness';

let worker: Miniflare;
const operator = capability();
let providerCalls = 0;
let serial = 0;
async function create(instance: Miniflare, headers: Record<string, string> = {}) {
  const response = await request(instance, '/v1/sessions', {
    method: 'POST',
    body: {},
    headers: { 'CF-Connecting-IP': `2001:db8:15::${(++serial).toString(16)}`, ...headers },
  });
  expect(response.status).toBe(201);
  return sessionCreatedSchema.parse(await response.json());
}
beforeAll(async () => {
  worker = await runtime({
    createLimit: 30,
    requestLimit: 300,
    bindings: {
      OPS_REVOKE_SECRET: operator,
      TURN_PROVIDER: 'coturn',
      TURN_URLS: 'turn:relay.example.test:3478',
      TURN_SHARED_SECRET: 'synthetic-provider-secret'.padEnd(40, 'x'),
      TURN_TTL_SECONDS: '60',
    },
    outboundService: async () => {
      providerCalls++;
      return new Response(null, { status: 503 });
    },
  });
});
afterAll(async () => {
  await worker.dispose();
});
const origins = [undefined, 'null', 'https://foreign.example.test', 'not-an-origin', ORIGIN + '/'];
for (const action of [
  'create',
  'join',
  'decisions',
  'close',
  'ice-credentials',
  'connection',
  'ws-ticket',
])
  it.each(origins)(
    `rejects ${action} mutations with invalid/missing Origin %s without state change`,
    async (origin) => {
      const ip = `2001:db8:15::${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
      const headers = { 'CF-Connecting-IP': ip };
      const room = await create(worker, headers);
      const { guest } = await join(worker, room);
      await approve(worker, room, guest.peerId);
      const before = await (
        await request(worker, `/v1/sessions/${room.roomId}/status`, { token: room.ownerCapability })
      ).json();
      const path =
        action === 'create'
          ? '/v1/sessions'
          : `/v1/sessions/${room.roomId}${action === 'close' ? '' : '/' + action}`;
      const body =
        action === 'join'
          ? candidate()
          : action === 'decisions'
            ? { candidatePeerId: guest.peerId, decision: 'approve' }
            : action === 'connection'
              ? { expectedEpoch: 0, mode: 'new-connection' }
              : {};
      const response = await worker.dispatchFetch(API + path, {
        method: action === 'close' ? 'DELETE' : 'POST',
        headers: {
          ...headers,
          ...(origin === undefined ? {} : { Origin: origin }),
          Authorization: `Bearer ${action === 'join' ? room.inviteCapability : room.ownerCapability}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(
        await (
          await request(worker, `/v1/sessions/${room.roomId}/status`, {
            token: room.ownerCapability,
          })
        ).json(),
      ).toEqual(before);
    },
  );
it('separates operator authority from room-owner, invitation and approved-peer capabilities', async () => {
  const room = await create(worker, { 'CF-Connecting-IP': '2001:db8:15::a' }),
    { guest } = await join(worker, room);
  await approve(worker, room, guest.peerId);
  for (const token of [room.ownerCapability, room.inviteCapability, guest.peerCapability]) {
    for (const path of [
      '/ops/metrics',
      '/ops/alerts',
      '/ops/relay',
      '/ops/relay/warm',
      `/ops/rooms/${room.roomId}/revoke`,
    ]) {
      const mutation = path.endsWith('/warm') || path.endsWith('/revoke');
      expect(
        (
          await request(worker, path, {
            method: mutation ? 'POST' : 'GET',
            token,
            ...(mutation ? { body: {} } : {}),
          })
        ).status,
      ).toBe(403);
    }
  }
  expect(
    (await request(worker, `/v1/sessions/${room.roomId}/status`, { token: operator })).status,
  ).toBe(403);
  expect((await request(worker, '/ops/metrics', { token: operator })).status).toBe(200);
  expect(
    (await request(worker, `/v1/sessions/${room.roomId}/status`, { token: room.ownerCapability }))
      .status,
  ).toBe(200);
});
it('issues bounded temporary relay credentials only to live approved members and never returns the long-term secret', async () => {
  const room = await create(worker, { 'CF-Connecting-IP': '2001:db8:15::b' }),
    { guest } = await join(worker, room);
  const url = `/v1/sessions/${room.roomId}/ice-credentials`;
  expect(
    (await request(worker, url, { method: 'POST', token: guest.peerCapability, body: {} })).status,
  ).toBe(403);
  await approve(worker, room, guest.peerId);
  for (const token of [room.ownerCapability, guest.peerCapability]) {
    const response = await request(worker, url, { method: 'POST', token, body: {} });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.includes('synthetic-provider-secret')).toBe(false);
    const config = JSON.parse(text);
    expect(config.relayAvailable).toBe(true);
    expect(config.expiresAt).toBeLessThanOrEqual(Math.min(room.expiresAt, Date.now() + 60000));
    expect(config.iceServers[0].username).toMatch(/^\d+:[a-f0-9-]{36}$/);
    const credentialExpiry = Number(config.iceServers[0].username.split(':')[0]) * 1000;
    expect(credentialExpiry).toBeLessThanOrEqual(room.expiresAt);
    expect(credentialExpiry).toBeLessThanOrEqual(Date.now() + 60000);
  }
  await request(worker, `/v1/sessions/${room.roomId}`, {
    method: 'DELETE',
    token: room.ownerCapability,
  });
  expect(
    (await request(worker, url, { method: 'POST', token: guest.peerCapability, body: {} })).status,
  ).toBe(410);
  expect(providerCalls).toBe(0);
});
it.each(['expired', 'revision', 'epoch', 'room', 'origin'])(
  'rejects a genuine ticket after %s substitution without consuming unrelated room authority',
  async (mode) => {
    const room = await create(worker, { 'CF-Connecting-IP': `2001:db8:15::${mode.length + 100}` }),
      { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const proof = await ticket(worker, room.roomId, room.ownerCapability),
      db = await storage(worker, room.roomId);
    if (mode === 'expired')
      await db.exec('UPDATE ticket_nonces SET expires_at = ?', Date.now() - 1);
    if (mode === 'revision') await db.exec('UPDATE room_meta SET revision = revision+1');
    if (mode === 'epoch') await db.exec('UPDATE room_meta SET epoch = epoch+1');
    const other =
      mode === 'room' ? await create(worker, { 'CF-Connecting-IP': '2001:db8:15::c' }) : room;
    const response = await request(worker, `/v1/sessions/${other.roomId}/ws`, {
      ...(mode === 'origin' ? { origin: 'https://foreign.example.test' } : {}),
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${proof.ticket}`,
      },
    });
    expect(response.status).toBe(
      mode === 'expired' ? 410 : mode === 'origin' ? 403 : mode === 'room' ? 401 : 409,
    );
    expect(await response.json()).toMatchObject({
      code:
        mode === 'expired'
          ? 'TICKET_EXPIRED'
          : mode === 'origin'
            ? 'INVALID_ORIGIN'
            : mode === 'room'
              ? 'UNAUTHORIZED'
              : 'STALE_EPOCH',
    });
    expect(response.status).not.toBe(101);
  },
);
it('revoked sockets cannot regain admission or revive a closed room using a stale envelope', async () => {
  const room = await create(worker, { 'CF-Connecting-IP': '2001:db8:15::d' }),
    { guest } = await join(worker, room);
  await approve(worker, room, guest.peerId);
  const owner = await connect(worker, room.roomId, room.ownerCapability),
    peer = await connect(worker, room.roomId, guest.peerCapability);
  try {
    await request(worker, `/v1/sessions/${room.roomId}`, {
      method: 'DELETE',
      token: room.ownerCapability,
    });
    await expect.poll(() => owner.closed && peer.closed).toBe(true);
    const response = await request(worker, `/v1/sessions/${room.roomId}/ws-ticket`, {
      method: 'POST',
      token: guest.peerCapability,
      body: {},
    });
    expect(response.status).toBe(410);
    // Already queued messages cannot revive the closed room; no fresh socket or membership.
    try {
      owner.socket.send(signal(room, room.peerId));
    } catch {
      /* A closed transport may reject send immediately. */
    }
    expect(
      (await request(worker, `/v1/sessions/${room.roomId}/status`, { token: room.ownerCapability }))
        .status,
    ).toBe(410);
  } finally {
    owner.close();
    peer.close();
  }
});
