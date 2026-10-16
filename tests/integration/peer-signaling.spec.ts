import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { createHmac } from 'node:crypto';
import { connectionEpochSchema, iceConfigurationSchema } from '@meshdrop/protocol';
import {
  approve,
  connect,
  create,
  join,
  request,
  runtime,
  signal,
  ticket,
  upgrade,
} from './harness';

describe('P2 authenticated connectivity control', () => {
  let worker: Miniflare;
  beforeAll(async () => {
    worker = await runtime();
  });
  afterAll(async () => {
    await worker.dispose();
  });
  it('keeps ICE configuration private until approval and returns explicit LAN-only defaults', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    const path = `/v1/sessions/${room.roomId}/ice-credentials`;
    expect((await request(worker, path, { method: 'POST', body: {} })).status).toBe(401);
    expect(
      (await request(worker, path, { method: 'POST', token: guest.peerCapability, body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await request(worker, path, { method: 'POST', token: room.ownerCapability, body: {} }))
        .status,
    ).toBe(403);
    await approve(worker, room, guest.peerId);
    const result = await request(worker, path, {
      method: 'POST',
      token: guest.peerCapability,
      body: {},
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(iceConfigurationSchema.parse(await result.json())).toMatchObject({
      iceServers: [],
      relayAvailable: false,
    });
    await request(worker, `/v1/sessions/${room.roomId}`, {
      method: 'DELETE',
      token: room.ownerCapability,
    });
    expect(
      (await request(worker, path, { method: 'POST', token: guest.peerCapability, body: {} }))
        .status,
    ).toBe(410);
  });
  it('requires two admitted sockets and owner CAS, broadcasts epochs and invalidates old tickets/messages', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const path = `/v1/sessions/${room.roomId}/connection`;
    const advance = (token: string, expectedEpoch = 0, mode = 'new-connection') =>
      request(worker, path, { method: 'POST', token, body: { expectedEpoch, mode } });
    expect((await advance(guest.peerCapability)).status).toBe(403);
    expect((await advance(room.ownerCapability)).status).toBe(409);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    try {
      expect((await owner.next('PEER_READY')).payload).toMatchObject({
        receiverPeerId: guest.peerId,
      });
      await receiver.next('PEER_READY');
      const stale = await ticket(worker, room.roomId, guest.peerCapability);
      expect((await advance(room.ownerCapability, 0, 'ice-restart')).status).toBe(409);
      const [a, b] = await Promise.all([
        advance(room.ownerCapability),
        advance(room.ownerCapability),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const result = connectionEpochSchema.parse(await (a.ok ? a : b).json());
      expect(result).toMatchObject({
        epoch: 1,
        mode: 'new-connection',
        ownerPeerId: room.peerId,
        receiverPeerId: guest.peerId,
      });
      expect((await owner.next('CONNECTION_EPOCH')).payload).toEqual(result);
      expect((await receiver.next('CONNECTION_EPOCH')).payload).toEqual(result);
      expect((await upgrade(worker, room.roomId, stale.ticket)).status).toBe(401);
      owner.socket.send(signal(room, room.peerId, 0, { epoch: 1 }));
      expect((await receiver.next('SDP_OFFER')).epoch).toBe(1);
      const restarted = await advance(room.ownerCapability, 1, 'ice-restart');
      expect(await restarted.json()).toMatchObject({ epoch: 2, mode: 'ice-restart' });
      await owner.next('CONNECTION_EPOCH');
      await receiver.next('CONNECTION_EPOCH');
      owner.socket.send(signal(room, room.peerId, 1, { epoch: 1 }));
      expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'STALE_EPOCH' });
    } finally {
      owner.close();
      receiver.close();
    }
  });
});

it('mints bounded coturn REST credentials independently verifiable by HMAC, without returning the shared secret', async () => {
  const secret = 'synthetic-test-secret-for-coturn-only';
  const worker = await runtime({
    bindings: {
      STUN_URLS: 'stun:stun.example.test:3478',
      TURN_URLS:
        'turn:relay.example.test:3478?transport=udp,turns:relay.example.test:5349?transport=tcp',
      TURN_SHARED_SECRET: secret,
    },
  });
  try {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const response = await request(worker, `/v1/sessions/${room.roomId}/ice-credentials`, {
      method: 'POST',
      token: guest.peerCapability,
      body: {},
    });
    const raw = await response.text();
    const configuration = iceConfigurationSchema.parse(JSON.parse(raw));
    expect(configuration.relayAvailable).toBe(true);
    const turn = configuration.iceServers[1]!;
    expect(turn.credential).toBe(
      createHmac('sha1', secret).update(turn.username!).digest('base64'),
    );
    expect(Number(turn.username!.split(':')[0]) * 1000).toBe(configuration.expiresAt);
    expect(configuration.expiresAt).toBeLessThanOrEqual(Date.now() + 300000);
    expect(configuration.expiresAt).toBeLessThanOrEqual(room.expiresAt);
    expect(raw).not.toContain(secret);
  } finally {
    await worker.dispose();
  }
});
it.each([
  { TURN_URLS: 'turn:relay.example.test:3478' },
  { TURN_URLS: 'turn:relay.example.test:3478', TURN_SHARED_SECRET: 'too-short' },
  { STUN_URLS: 'https://user:password@invalid.test' },
])('fails closed for incomplete or unsafe ICE configuration %j', async (bindings) => {
  const worker = await runtime({ bindings });
  try {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const response = await request(worker, `/v1/sessions/${room.roomId}/ice-credentials`, {
      method: 'POST',
      token: room.ownerCapability,
      body: {},
    });
    expect(response.status).toBe(503);
  } finally {
    await worker.dispose();
  }
});
