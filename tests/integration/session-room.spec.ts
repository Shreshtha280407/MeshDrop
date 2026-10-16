import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { sessionStatusSchema } from '@meshdrop/protocol';
import {
  Inbox,
  ORIGIN,
  approve,
  candidate,
  capability,
  connect,
  create,
  join,
  request,
  runtime,
  signal,
  storage,
  ticket,
  upgrade,
} from './harness';

describe('SQLite room admission and isolated signaling', () => {
  let worker: Miniflare;
  beforeAll(async () => {
    worker = await runtime();
  });
  afterAll(async () => {
    await worker.dispose();
  });
  it('creates, approves and forwards signaling between exactly two peers', async () => {
    const room = await create(worker);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const { guest } = await join(worker, room);
    expect((await owner.next('PEER_PENDING')).payload).toEqual({ candidatePeerId: guest.peerId });
    expect((await approve(worker, room, guest.peerId)).status).toBe(200);
    await owner.next('PEER_APPROVED');
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    try {
      owner.socket.send(signal(room, room.peerId));
      const forwarded = await receiver.next('SDP_OFFER');
      expect(forwarded.peerId).toBe(room.peerId);
      receiver.socket.send(
        signal(room, guest.peerId, 0, { type: 'SDP_ANSWER', payload: { sdp: 'synthetic-answer' } }),
      );
      expect((await owner.next('SDP_ANSWER')).peerId).toBe(guest.peerId);
      receiver.socket.send(
        signal(room, guest.peerId, 1, {
          type: 'ICE_CANDIDATE',
          payload: { candidate: '', sdpMid: null, sdpMLineIndex: null },
        }),
      );
      expect((await owner.next('ICE_CANDIDATE')).roomId).toBe(room.roomId);
      const third = await request(worker, `/v1/sessions/${room.roomId}/join`, {
        method: 'POST',
        token: room.inviteCapability,
        body: candidate(),
      });
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({ code: 'INVITE_USED' });
    } finally {
      owner.close();
      receiver.close();
    }
  });
  it('denies pending candidate sockets/decisions and hides the owner identity', async () => {
    const room = await create(worker);
    const { guest, status } = await join(worker, room);
    expect(status.approval).toBe('pending');
    expect(status).not.toHaveProperty('candidatePeerId');
    const path = `/v1/sessions/${room.roomId}`;
    expect(
      (
        await request(worker, `${path}/ws-ticket`, {
          method: 'POST',
          token: guest.peerCapability,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(worker, `${path}/decisions`, {
          method: 'POST',
          token: guest.peerCapability,
          body: { candidatePeerId: guest.peerId, decision: 'approve' },
        })
      ).status,
    ).toBe(403);
    expect(
      JSON.stringify(
        await (await request(worker, `${path}/status`, { token: guest.peerCapability })).json(),
      ),
    ).not.toContain(room.peerId);
    expect((await request(worker, `${path}/status`, { token: room.inviteCapability })).status).toBe(
      403,
    );
    expect(
      (await request(worker, path, { method: 'DELETE', token: guest.peerCapability })).status,
    ).toBe(403);
  });
  it('is idempotent for the same join and same owner decision', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    expect(
      (
        await request(worker, `/v1/sessions/${room.roomId}/join`, {
          method: 'POST',
          token: room.inviteCapability,
          body: guest,
        })
      ).status,
    ).toBe(200);
    await approve(worker, room, guest.peerId);
    const repeated = await approve(worker, room, guest.peerId);
    expect(sessionStatusSchema.parse(await repeated.json()).revision).toBe(2);
    const different = await request(worker, `/v1/sessions/${room.roomId}/decisions`, {
      method: 'POST',
      token: room.ownerCapability,
      body: { candidatePeerId: guest.peerId, decision: 'reject' },
    });
    expect(different.status).toBe(409);
  });
  it('rejects a candidate and revokes the consumed invitation', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    const response = await request(worker, `/v1/sessions/${room.roomId}/decisions`, {
      method: 'POST',
      token: room.ownerCapability,
      body: { candidatePeerId: guest.peerId, decision: 'reject' },
    });
    expect(sessionStatusSchema.parse(await response.json()).state).toBe('created');
    const guestStatus = await request(worker, `/v1/sessions/${room.roomId}/status`, {
      token: guest.peerCapability,
    });
    expect(sessionStatusSchema.parse(await guestStatus.json()).approval).toBe('rejected');
    expect(
      (
        await request(worker, `/v1/sessions/${room.roomId}/join`, {
          method: 'POST',
          token: room.inviteCapability,
          body: candidate(),
        })
      ).status,
    ).toBe(410);
  });
  it('stores only verifiers, never credentials, file data or SDP', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const issued = await ticket(worker, room.roomId, room.ownerCapability);
    const sql = await storage(worker, room.roomId);
    const rows = [];
    for (const table of ['room_meta', 'invites', 'peers', 'ticket_nonces'])
      rows.push(await sql.exec(`SELECT * FROM ${table}`));
    const serialized = JSON.stringify(rows);
    for (const token of [
      room.ownerCapability,
      room.inviteCapability,
      guest.peerCapability,
      issued.ticket,
    ])
      expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('sdp');
    expect(serialized).not.toContain('filename');
  });
  it('denies missing, invalid and cross-room capabilities', async () => {
    const first = await create(worker);
    const second = await create(worker);
    const path = `/v1/sessions/${second.roomId}/status`;
    expect((await request(worker, path)).status).toBe(401);
    expect((await request(worker, path, { token: capability() })).status).toBe(403);
    expect((await request(worker, path, { token: first.ownerCapability })).status).toBe(403);
  });
  it('denies cross-room message routing and spoofed peer identity', async () => {
    const room = await create(worker);
    const other = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    try {
      owner.socket.send(signal(other, room.peerId));
      expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'FORBIDDEN' });
      expect(receiver.events.some((event) => event.type === 'SDP_OFFER')).toBe(false);
      const replacement = await connect(worker, room.roomId, room.ownerCapability);
      replacement.socket.send(signal(room, guest.peerId));
      expect((await replacement.next('ERROR')).payload).toMatchObject({ code: 'FORBIDDEN' });
      replacement.close();
    } finally {
      owner.close();
      receiver.close();
    }
  });
  it('rejects replayed message IDs and old sequence numbers across new sockets', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const payload = signal(room, room.peerId);
    owner.socket.send(payload);
    await receiver.next('SDP_OFFER');
    owner.socket.send(payload);
    expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'REPLAY' });
    const replacement = await connect(worker, room.roomId, room.ownerCapability);
    try {
      replacement.socket.send(signal(room, room.peerId, 0));
      expect((await replacement.next('ERROR')).payload).toMatchObject({ code: 'REPLAY' });
      replacement.socket.send(signal(room, room.peerId, 1));
      expect((await receiver.next('SDP_OFFER')).seq).toBe(1);
    } finally {
      owner.close();
      replacement.close();
      receiver.close();
    }
  });
  it('preserves authorization and sequence checks through actual hibernation eviction', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    try {
      owner.socket.send(signal(room, room.peerId));
      await receiver.next('SDP_OFFER');
      await worker.unsafeEvictDurableObject('meshdrop-p1-test', 'SessionRoom', {
        name: room.roomId,
        webSockets: 'hibernate',
      });
      owner.socket.send(signal(room, room.peerId, 1));
      expect((await receiver.next('SDP_OFFER')).seq).toBe(1);
      owner.socket.send(signal(room, room.peerId, 0));
      expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'REPLAY' });
    } finally {
      owner.close();
      receiver.close();
    }
  });
  it('consumes tickets once and binds them to room revision and origin', async () => {
    const room = await create(worker);
    const issued = await ticket(worker, room.roomId, room.ownerCapability);
    expect(
      (await upgrade(worker, room.roomId, issued.ticket, 'http://localhost:5173')).status,
    ).toBe(403);
    const response = await upgrade(worker, room.roomId, issued.ticket);
    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('meshdrop.v1');
    const socket = new Inbox(response.webSocket!);
    const replay = await upgrade(worker, room.roomId, issued.ticket);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'TICKET_USED' });
    const stale = await ticket(worker, room.roomId, room.ownerCapability);
    await join(worker, room);
    expect((await upgrade(worker, room.roomId, stale.ticket)).status).toBe(409);
    expect((await upgrade(worker, room.roomId, capability(), ORIGIN)).status).toBe(401);
    socket.close();
  });

  it('restores approved membership and consumed tickets after a full runtime restart', async () => {
    const persistPath = await mkdtemp(joinPath(tmpdir(), 'meshdrop-p1-restart-'));
    let persisted = await runtime({ persist: persistPath });
    try {
      const room = await create(persisted);
      const { guest } = await join(persisted, room);
      await approve(persisted, room, guest.peerId);
      const issued = await ticket(persisted, room.roomId, room.ownerCapability);
      const upgraded = await upgrade(persisted, room.roomId, issued.ticket);
      const old = new Inbox(upgraded.webSocket!);
      old.close();
      await persisted.dispose();
      persisted = await runtime({ persist: persistPath });
      const response = await request(persisted, `/v1/sessions/${room.roomId}/status`, {
        token: guest.peerCapability,
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(sessionStatusSchema.parse(await response.json())).toMatchObject({
        role: 'receiver',
        approval: 'approved',
        state: 'approved',
      });
      expect(await (await upgrade(persisted, room.roomId, issued.ticket)).json()).toMatchObject({
        code: 'TICKET_USED',
      });
      const restored = await connect(persisted, room.roomId, room.ownerCapability);
      restored.close();
    } finally {
      await persisted.dispose();
      await rm(persistPath, { recursive: true, force: true });
    }
  });
  it('rejects stale epochs and client-forged server events', async () => {
    const room = await create(worker);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    owner.socket.send(signal(room, room.peerId, 0, { epoch: 1 }));
    expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'STALE_EPOCH' });
    const second = await connect(worker, room.roomId, room.ownerCapability);
    second.socket.send(
      signal(room, room.peerId, 0, { type: 'ROOM_CLOSED', payload: { reason: 'owner-closed' } }),
    );
    expect((await second.next('ERROR')).payload).toMatchObject({ code: 'FORBIDDEN' });
    owner.close();
    second.close();
  });
  it('caps oversized/binary/malformed frames and closes repeated violators', async () => {
    const room = await create(worker);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    owner.socket.send('x'.repeat(65537));
    expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
    owner.socket.send(new Uint8Array([1, 2]));
    expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'INVALID_MESSAGE' });
    owner.socket.send('invalid-secret-body');
    const error = await owner.next('ERROR');
    expect(JSON.stringify(error)).not.toContain('invalid-secret-body');
    await expect
      .poll(() => ({ closed: owner.closed, readyState: owner.socket.readyState }))
      .toMatchObject({ closed: true });
  });
  it('enforces per-peer socket limits even when messages are individually valid', async () => {
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const receiver = await connect(worker, room.roomId, guest.peerCapability);
    for (let index = 0; index < 61; index++) owner.socket.send(signal(room, room.peerId, index));
    expect((await owner.next('ERROR')).payload).toMatchObject({ code: 'RATE_LIMITED' });
    owner.close();
    receiver.close();
  });
  it('replaces stale sockets and revocation closes live peers and invalidates tickets', async () => {
    const room = await create(worker);
    const owner = await connect(worker, room.roomId, room.ownerCapability);
    const replacement = await connect(worker, room.roomId, room.ownerCapability);
    await expect.poll(() => owner.closed).toBe(true);
    const issued = await ticket(worker, room.roomId, room.ownerCapability);
    const path = `/v1/sessions/${room.roomId}`;
    expect(
      (await request(worker, path, { method: 'DELETE', token: room.ownerCapability })).status,
    ).toBe(200);
    await replacement.next('ROOM_CLOSED');
    expect((await upgrade(worker, room.roomId, issued.ticket)).status).toBe(410);
    expect((await request(worker, `${path}/status`, { token: room.ownerCapability })).status).toBe(
      410,
    );
    expect(
      (await request(worker, path, { method: 'DELETE', token: room.ownerCapability })).status,
    ).toBe(200);
    owner.close();
    replacement.close();
  });
  it('denies expired invitations and tickets using persisted expiry checks', async () => {
    const room = await create(worker);
    const issued = await ticket(worker, room.roomId, room.ownerCapability);
    const sql = await storage(worker, room.roomId);
    await sql.exec('UPDATE invites SET expires_at = ?', Date.now() - 1);
    const expiredInvite = await request(worker, `/v1/sessions/${room.roomId}/join`, {
      method: 'POST',
      token: room.inviteCapability,
      body: candidate(),
    });
    expect(await expiredInvite.json()).toMatchObject({ code: 'INVITE_EXPIRED' });
    await sql.exec('UPDATE ticket_nonces SET expires_at = ?', Date.now() - 1);
    expect(await (await upgrade(worker, room.roomId, issued.ticket)).json()).toMatchObject({
      code: 'TICKET_EXPIRED',
    });
  });
  it('runs real expiry alarms, closes sockets, and purges the tombstone', async () => {
    const expiring = await runtime({
      bindings: { ROOM_TTL_SECONDS: '1', CLOSED_TOMBSTONE_SECONDS: '1' },
    });
    try {
      const room = await create(expiring);
      const owner = await connect(expiring, room.roomId, room.ownerCapability);
      await owner.next('ROOM_CLOSED');
      await expect
        .poll(() => ({ closed: owner.closed, readyState: owner.socket.readyState }))
        .toMatchObject({ closed: true });
      const sql = await storage(expiring, room.roomId);
      await expect.poll(async () => (await sql.exec('SELECT * FROM room_meta')).length).toBe(0);
      expect(await sql.exec('SELECT * FROM peers')).toHaveLength(0);
      expect(await sql.exec('SELECT * FROM invites')).toHaveLength(0);
      expect(await sql.exec('SELECT * FROM ticket_nonces')).toHaveLength(0);
    } finally {
      await expiring.dispose();
    }
  });
});
