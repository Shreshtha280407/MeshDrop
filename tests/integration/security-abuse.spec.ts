import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { Miniflare } from 'miniflare';
import {
  approve,
  capability,
  connect,
  create,
  join,
  request,
  runtime,
  signal,
  storage,
  ticket,
} from './harness';

let worker: Miniflare;
beforeAll(async () => {
  worker = await runtime();
});
afterAll(async () => {
  await worker.dispose();
});

it('retains abuse budgets and migrates a pre-P8 closed room after runtime eviction', async () => {
  const path = await mkdtemp(joinPath(tmpdir(), 'meshdrop-p8-'));
  let instance = await runtime({ persist: path });
  try {
    const room = await create(instance),
      legacy = await create(instance);
    for (let index = 0; index < 24; index++)
      await ticket(instance, room.roomId, room.ownerCapability);
    await request(instance, `/v1/sessions/${legacy.roomId}`, {
      method: 'DELETE',
      token: legacy.ownerCapability,
    });
    const old = await storage(instance, legacy.roomId);
    await old.exec('DROP TABLE security_windows');
    await instance.dispose();
    instance = await runtime({ persist: path });
    expect(
      (
        await request(instance, `/v1/sessions/${room.roomId}/ws-ticket`, {
          method: 'POST',
          token: room.ownerCapability,
          body: {},
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await request(instance, `/v1/sessions/${legacy.roomId}/status`, {
          token: legacy.ownerCapability,
        })
      ).status,
    ).toBe(410);
    const migrated = await storage(instance, legacy.roomId);
    expect(
      await migrated.exec("SELECT name FROM sqlite_master WHERE name = 'security_windows'"),
    ).toHaveLength(1);
  } finally {
    await instance.dispose();
    await rm(path, { recursive: true, force: true });
  }
});

it('does not create a persistent schema for a forged room identifier', async () => {
  const id = randomUUID();
  expect((await request(worker, `/v1/sessions/${id}/status`, { token: capability() })).status).toBe(
    404,
  );
  const sql = await storage(worker, id);
  expect(
    await sql.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room_meta','peers','invites','ticket_nonces','security_windows')",
    ),
  ).toHaveLength(0);
});
it('caps room HTTP work across rotating client addresses and permits a later window', async () => {
  const room = await create(worker);
  for (let i = 0; i < 180; i++) {
    const result = await request(worker, `/v1/sessions/${room.roomId}/status`, {
      token: capability(),
      headers: { 'CF-Connecting-IP': `192.0.2.${(i % 254) + 1}` },
    });
    expect(result.status).toBe(403);
  }
  const limited = await request(worker, `/v1/sessions/${room.roomId}/status`, {
    token: room.ownerCapability,
  });
  expect(limited.status).toBe(429);
  expect(limited.headers.get('Retry-After')).toBe('60');
  const sql = await storage(worker, room.roomId);
  await sql.exec(
    "UPDATE security_windows SET started_at = ? WHERE name = 'http'",
    Date.now() - 60001,
  );
  expect(
    (await request(worker, `/v1/sessions/${room.roomId}/status`, { token: room.ownerCapability }))
      .status,
  ).toBe(200);
  expect((await sql.exec('SELECT * FROM security_windows')).length).toBeLessThanOrEqual(4);
});
it('bounds ticket minting, retained nonces and socket admission attempts', async () => {
  const room = await create(worker);
  for (let i = 0; i < 24; i++) await ticket(worker, room.roomId, room.ownerCapability);
  const result = await request(worker, `/v1/sessions/${room.roomId}/ws-ticket`, {
    method: 'POST',
    token: room.ownerCapability,
    body: {},
  });
  expect(result.status).toBe(429);
  const sql = await storage(worker, room.roomId);
  expect(await sql.exec('SELECT * FROM ticket_nonces')).toHaveLength(1);
  // Simulate delayed cleanup while many consumed tickets still exist.
  const capped = await create(worker),
    rows = await storage(worker, capped.roomId);
  for (let index = 0; index < 64; index++)
    await rows.exec(
      'INSERT INTO ticket_nonces VALUES (?, ?, ?, 0, 0, ?, ?)',
      index.toString(16).padStart(64, '0'),
      capped.peerId,
      Date.now() + 60000,
      'http://127.0.0.1:5173',
      Date.now(),
    );
  const mint = () =>
    request(worker, `/v1/sessions/${capped.roomId}/ws-ticket`, {
      method: 'POST',
      token: capped.ownerCapability,
      body: {},
    });
  expect((await mint()).status).toBe(429);
  expect(await rows.exec('SELECT * FROM ticket_nonces')).toHaveLength(64);
  await rows.exec(
    'UPDATE ticket_nonces SET expires_at = ? WHERE verifier = ?',
    Date.now() - 60001,
    '0'.repeat(64),
  );
  expect((await mint()).status).toBe(200);
  expect(await rows.exec('SELECT * FROM ticket_nonces')).toHaveLength(64);
  for (let index = 0; index < 25; index++) {
    const response = await request(worker, `/v1/sessions/${capped.roomId}/ws`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${capability()}`,
      },
    });
    expect(response.status).toBe(index < 24 ? 401 : 429);
  }
});
it('rejects receiver offer impersonation without forwarding it', async () => {
  const room = await create(worker),
    { guest } = await join(worker, room);
  await approve(worker, room, guest.peerId);
  const owner = await connect(worker, room.roomId, room.ownerCapability),
    receiver = await connect(worker, room.roomId, guest.peerCapability);
  try {
    receiver.socket.send(signal(room, guest.peerId));
    expect((await receiver.next('ERROR')).payload).toMatchObject({ code: 'FORBIDDEN' });
    await expect.poll(() => receiver.closed).toBe(true);
    expect(owner.events.filter((event) => event.type === 'SDP_OFFER')).toHaveLength(0);
  } finally {
    owner.close();
    receiver.close();
  }
});
it('caps authorized connection-epoch churn and preserves the final epoch', async () => {
  const room = await create(worker),
    { guest } = await join(worker, room);
  await approve(worker, room, guest.peerId);
  const owner = await connect(worker, room.roomId, room.ownerCapability),
    receiver = await connect(worker, room.roomId, guest.peerCapability);
  try {
    for (let epoch = 0; epoch < 13; epoch++) {
      const result = await request(worker, `/v1/sessions/${room.roomId}/connection`, {
        method: 'POST',
        token: room.ownerCapability,
        body: { expectedEpoch: epoch, mode: 'new-connection' },
      });
      expect(result.status).toBe(epoch < 12 ? 200 : 429);
    }
    const sql = await storage(worker, room.roomId);
    expect(await sql.exec('SELECT epoch FROM room_meta')).toEqual([{ epoch: 12 }]);
  } finally {
    owner.close();
    receiver.close();
  }
});
it.each(['{not-json-private-canary', 'x'.repeat(65537)])(
  'rejects malformed or oversized signaling without reflecting its contents',
  async (payload) => {
    const room = await create(worker),
      { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const owner = await connect(worker, room.roomId, room.ownerCapability),
      receiver = await connect(worker, room.roomId, guest.peerCapability);
    try {
      owner.socket.send(payload);
      const error = await owner.next('ERROR');
      expect(JSON.stringify(error)).not.toContain(payload);
      expect(receiver.events.filter((event) => event.type === 'SDP_OFFER')).toHaveLength(0);
    } finally {
      owner.close();
      receiver.close();
    }
  },
);
