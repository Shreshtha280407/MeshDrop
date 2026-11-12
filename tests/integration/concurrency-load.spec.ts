import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { candidate, capability, signal, storage } from './harness';
import { ControlLoad, ROOM_COUNTS, loadEvidence, parallel, seeded } from '../helpers/control-load';

for (const count of ROOM_COUNTS)
  it(`isolates ${count} real local SQLite rooms with ${count * 2} TCP signaling sockets`, async () => {
    const load = await ControlLoad.start();
    try {
      const rooms = await parallel(Array.from({ length: count }), () => load.create());
      await parallel(rooms, (r) => load.admit(r));
      await parallel(rooms, (r) => load.connect(r));
      expect(load.sockets.filter((s) => !s.closed)).toHaveLength(count * 2);
      await parallel(rooms, (r) => load.advance(r));
      for (let turn = 0; turn < 3; turn++) await parallel(rooms, (r) => load.exchange(r));
      if (count > 1)
        await parallel(rooms, async (room, i) => {
          const foreign = rooms[(i + 1) % rooms.length]!;
          expect(
            (await load.fetch(room, '/status', { token: foreign.room.ownerCapability })).status,
          ).toBe(403);
          expect(
            (
              await load.fetch(room, '/join', {
                method: 'POST',
                token: foreign.room.inviteCapability,
                body: candidate(),
              })
            ).status,
          ).toBe(403);
          expect(
            (await load.fetch(room, '', { method: 'DELETE', token: foreign.room.ownerCapability }))
              .status,
          ).toBe(403);
          expect(
            (await load.fetch(room, '/status', { token: room.room.ownerCapability })).status,
          ).toBe(200);
        });
      for (const room of rooms) {
        const db = await storage(load.worker, room.room.roomId);
        expect(await db.exec('SELECT COUNT(*) AS count FROM peers')).toEqual([{ count: 2 }]);
        expect(
          await db.exec("SELECT COUNT(*) AS count FROM peers WHERE approval = 'approved'"),
        ).toEqual([{ count: 2 }]);
        expect(
          room.receiver!.events.filter((e) =>
            ['SDP_OFFER', 'SDP_ANSWER', 'ICE_CANDIDATE'].includes(e.type),
          ),
        ).toHaveLength(0);
      }
      expect(load.sockets.some((s) => s.closed)).toBe(false);
    } finally {
      await load.close();
    }
    expect(load.closedSockets).toBe(count * 2);
    expect(load.forcedCleanup).toBe(0);
    await loadEvidence(`rooms-${count}`, {
      ...load.metrics(),
      isolationViolations: 0,
      authorizationViolations: 0,
    });
  }, 90000);

it('races third-peer admission and repeated decisions across 50 rooms without exceeding two members', async () => {
  const load = await ControlLoad.start();
  try {
    const rooms = await parallel(Array.from({ length: 50 }), () => load.create());
    await parallel(rooms, async (room) => {
      const rivals = [candidate(), candidate()];
      const attempts = await Promise.all(
        rivals.map((guest) =>
          load.fetch(room, '/join', {
            method: 'POST',
            token: room.room.inviteCapability,
            body: guest,
          }),
        ),
      );
      expect(attempts.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = rivals[attempts.findIndex((r) => r.status === 201)]!;
      room.guest = winner;
      expect(
        (
          await load.fetch(room, '/decisions', {
            method: 'POST',
            token: winner.peerCapability,
            body: { candidatePeerId: winner.peerId, decision: 'approve' },
          })
        ).status,
      ).toBe(403);
      const decisions = await Promise.all(
        [0, 1].map(() =>
          load.fetch(room, '/decisions', {
            method: 'POST',
            token: room.room.ownerCapability,
            body: { candidatePeerId: winner.peerId, decision: 'approve' },
          }),
        ),
      );
      expect(decisions.map((r) => r.status)).toEqual([200, 200]);
      expect(
        (
          await load.fetch(room, '/decisions', {
            method: 'POST',
            token: room.room.ownerCapability,
            body: { candidatePeerId: winner.peerId, decision: 'reject' },
          })
        ).status,
      ).toBe(409);
      const db = await storage(load.worker, room.room.roomId);
      expect(await db.exec('SELECT revision FROM room_meta')).toEqual([{ revision: 2 }]);
      expect(await db.exec('SELECT COUNT(*) AS count FROM peers')).toEqual([{ count: 2 }]);
    });
    await loadEvidence('concurrent-admission-50', {
      rooms: 50,
      competingJoins: 100,
      duplicateApprovals: 100,
      membershipViolations: 0,
    });
  } finally {
    await load.close();
  }
}, 90000);

it('rejects cross-room socket routing, revocation and expiry without changing unrelated rooms', async () => {
  const load = await ControlLoad.start();
  try {
    const rooms = await parallel(Array.from({ length: 50 }), () => load.create());
    await parallel(rooms, async (r) => {
      await load.admit(r);
      await load.connect(r);
      await load.advance(r);
    });
    const attacked = rooms[0]!,
      other = rooms[1]!;
    attacked.owner!.socket.send(
      signal(other.room, attacked.room.peerId, 0, { epoch: attacked.epoch }),
    );
    expect((await attacked.owner!.next('ERROR')).payload).toMatchObject({ code: 'FORBIDDEN' });
    await load.settleClosed([attacked.owner!]);
    expect(other.receiver!.events.filter((e) => e.type === 'SDP_OFFER')).toHaveLength(0);
    await load.open(attacked, 'owner');
    await load.exchange(attacked);
    expect(
      (await load.fetch(attacked, '', { method: 'DELETE', token: attacked.room.ownerCapability }))
        .status,
    ).toBe(200);
    await load.settleClosed([attacked.owner!, attacked.receiver!]);
    const expired = rooms[2]!,
      db = await storage(load.worker, expired.room.roomId);
    await db.exec('UPDATE room_meta SET expires_at = ?', Date.now() - 1);
    expect(
      (await load.fetch(expired, '/status', { token: expired.room.ownerCapability })).status,
    ).toBe(410);
    expired.owner!.socket.send(
      signal(expired.room, expired.room.peerId, 0, { epoch: expired.epoch }),
    );
    expect((await expired.owner!.next('ERROR')).payload).toMatchObject({ code: 'ROOM_CLOSED' });
    await load.settleClosed([expired.owner!]);
    await parallel(
      rooms.filter((r) => r !== attacked && r !== expired),
      (r) => load.exchange(r),
    );
    expect((await load.fetch(other, '/status', { token: other.room.ownerCapability })).status).toBe(
      200,
    );
  } finally {
    await load.close();
  }
  expect(load.forcedCleanup).toBe(0);
  await loadEvidence('deep-isolation-50', {
    ...load.metrics(),
    crossRoomSignals: 0,
    unrelatedRoomsCompleted: 48,
  });
}, 90000);

for (const type of ['ICE_CANDIDATE', 'SDP_OFFER', 'SDP_ANSWER'] as const)
  it(`bounds a 500-message ${type} flood while ten normal rooms finish`, async () => {
    const load = await ControlLoad.start();
    let accepted: number;
    try {
      const rooms = await parallel(Array.from({ length: 11 }), () => load.create());
      await parallel(rooms, async (r) => {
        await load.admit(r);
        await load.connect(r);
        await load.advance(r);
      });
      const abusive = rooms[0]!,
        role = type === 'SDP_ANSWER' ? 'receiver' : 'owner';
      const sender = abusive[role]!,
        target = abusive[role === 'owner' ? 'receiver' : 'owner']!;
      const extra =
        type === 'ICE_CANDIDATE'
          ? {
              type: 'ICE_CANDIDATE' as const,
              payload: { candidate: '', sdpMid: null, sdpMLineIndex: null },
            }
          : type === 'SDP_OFFER'
            ? { type: 'SDP_OFFER' as const, payload: { sdp: 'synthetic-flood' } }
            : { type: 'SDP_ANSWER' as const, payload: { sdp: 'synthetic-flood' } };
      for (let i = 0; i < 500; i++)
        sender.socket.send(
          signal(abusive.room, role === 'owner' ? abusive.room.peerId : abusive.guest.peerId, i, {
            epoch: abusive.epoch,
            ...extra,
          }),
        );
      await parallel(rooms.slice(1), (r) => load.exchange(r));
      expect((await sender.next('ERROR')).payload).toMatchObject({ code: 'RATE_LIMITED' });
      await load.settleClosed([sender]);
      accepted = target.events.filter((e) => e.type === type).length;
      expect(accepted).toBe(60);
      expect(rooms.slice(1).some((r) => r.owner!.closed || r.receiver!.closed)).toBe(false);
      const db = await storage(load.worker, abusive.room.roomId);
      expect(
        await db.exec(
          'SELECT last_seq FROM peers WHERE peer_id = ?',
          role === 'owner' ? abusive.room.peerId : abusive.guest.peerId,
        ),
      ).toEqual([{ last_seq: 59 }]);
    } finally {
      await load.close();
    }
    expect(load.forcedCleanup).toBe(0);
    await loadEvidence(`flood-${type}`, {
      ...load.metrics(),
      floodAttempted: 500,
      floodForwarded: accepted,
      policyClosures: 1,
      normalRoomCompletions: 10,
    });
  }, 90000);

it('disconnects half of 50 pairs and reconnects 25 with fresh admitted epochs', async () => {
  const load = await ControlLoad.start();
  try {
    const rooms = await parallel(Array.from({ length: 50 }), () => load.create());
    await parallel(rooms, async (r) => {
      await load.admit(r);
      await load.connect(r);
      await load.advance(r);
    });
    const cut = rooms.slice(0, 25),
      survivors = rooms.slice(25);
    const old = cut.flatMap((r) => [r.owner!, r.receiver!]);
    old.forEach((s) => s.close());
    await load.settleClosed(old);
    await parallel(survivors, (r) => load.exchange(r));
    await parallel(cut, async (r) => {
      await load.connect(r);
      await load.advance(r);
      expect(r.epoch).toBe(2);
      await load.exchange(r);
    });
    expect(survivors.every((r) => r.epoch === 1 && !r.owner!.closed && !r.receiver!.closed)).toBe(
      true,
    );
    for (const room of cut) {
      room.owner!.socket.send(signal(room.room, room.room.peerId, 100, { epoch: 1 }));
      expect((await room.owner!.next('ERROR')).payload).toMatchObject({ code: 'STALE_EPOCH' });
      expect(room.receiver!.events.some((e) => e.type === 'SDP_OFFER')).toBe(false);
    }
    await parallel(survivors, (r) => load.exchange(r));
  } finally {
    await load.close();
  }
  expect(load.forcedCleanup).toBe(0);
  await loadEvidence('disconnect-reconnect-storm', {
    ...load.metrics(),
    disconnectedPairs: 25,
    freshEpochRecoveries: 25,
    survivingPairs: 25,
    staleEpochForwarded: 0,
  });
}, 90000);

it('rejects 800 malformed HTTP requests without 5xx, reflections or impact on healthy rooms', async () => {
  const load = await ControlLoad.start();
  try {
    const room = await load.create();
    await load.admit(room);
    await load.connect(room);
    await load.advance(room);
    const canary = 'task14-private-canary';
    const attacked = await load.create();
    await parallel(
      Array.from({ length: 800 }, (_, i) => i),
      async (i) => {
        const headers = { 'CF-Connecting-IP': `2001:db8:14:bad::${(i + 1).toString(16)}` };
        let response: { status: number; text(): Promise<string> };
        switch (i % 8) {
          case 0:
            response = await load.fetch(null, '/v1/sessions/not-a-uuid/status', {
              token: capability(),
              headers,
            });
            break;
          case 1:
            response = await load.fetch(attacked, '/status', { headers });
            break;
          case 2:
            response = await load.fetch(attacked, '/status', { token: canary, headers });
            break;
          case 3:
            response = await load.fetch(null, '/v1/sessions', { method: 'GET', headers });
            break;
          case 4:
            response = await load.fetch(null, '/v1/sessions', {
              method: 'POST',
              origin: 'https://invalid.example.test',
              body: {},
              headers,
            });
            break;
          case 5:
            response = await load.worker.dispatchFetch('https://api.meshdrop.test/v1/sessions', {
              method: 'POST',
              headers: {
                ...headers,
                Origin: 'http://127.0.0.1:5173',
                'Content-Type': 'application/json',
              },
              body: canary.repeat(1000),
            });
            break;
          case 6:
            response = await load.worker.dispatchFetch('https://api.meshdrop.test/v1/sessions', {
              method: 'POST',
              headers: {
                ...headers,
                Origin: 'http://127.0.0.1:5173',
                'Content-Type': 'application/json',
              },
              body: '{' + canary,
            });
            break;
          default:
            response = await load.fetch(attacked, '/join', {
              method: 'POST',
              token: attacked.room.inviteCapability,
              body: { unexpected: canary },
              headers,
            });
        }
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        const text = await response.text();
        expect(text).not.toContain(canary);
        expect(text.length).toBeLessThan(2048);
      },
    );
    await load.exchange(room);
    expect((await load.fetch(room, '/status', { token: room.room.ownerCapability })).status).toBe(
      200,
    );
    await loadEvidence('malformed-http-800', {
      scope: 'local-real-worker-http',
      attempts: 800,
      clientErrors: 800,
      serverErrors: 0,
      reflections: 0,
      healthyRoomCompletions: 1,
    });
  } finally {
    await load.close();
  }
}, 90000);

it('retains no application room schema after 50 forged admissions', async () => {
  const load = await ControlLoad.start();
  try {
    await parallel(
      Array.from({ length: 50 }, () => randomUUID()),
      async (id) => {
        expect(
          (await load.fetch(null, `/v1/sessions/${id}/status`, { token: capability() })).status,
        ).toBe(404);
        const db = await storage(load.worker, id);
        expect(
          await db.exec(
            "SELECT name FROM sqlite_master WHERE name IN ('room_meta','peers','invites','ticket_nonces','security_windows')",
          ),
        ).toHaveLength(0);
      },
    );
  } finally {
    await load.close();
  }
});

it('rejects replayed signaling and tickets across twenty simultaneous rooms', async () => {
  const load = await ControlLoad.start();
  try {
    const rooms = await parallel(Array.from({ length: 20 }), () => load.create());
    await parallel(rooms, async (r) => {
      await load.admit(r);
      await load.connect(r);
      await load.advance(r);
    });
    await parallel(rooms, async (r) => {
      const wire = signal(r.room, r.room.peerId, 0, { epoch: r.epoch });
      r.owner!.socket.send(wire);
      await r.receiver!.next('SDP_OFFER');
      r.owner!.socket.send(wire);
      expect((await r.owner!.next('ERROR')).payload).toMatchObject({ code: 'REPLAY' });
      const retired = r.owner!;
      await load.open(r, 'owner');
      await load.settleClosed([retired]);
      r.owner!.socket.send(signal(r.room, r.room.peerId, 0, { epoch: r.epoch }));
      expect((await r.owner!.next('ERROR')).payload).toMatchObject({ code: 'REPLAY' });
      r.seq.owner = 1;
      await load.exchange(r);
      const issued = await load.fetch(r, '/ws-ticket', {
        method: 'POST',
        token: r.room.ownerCapability,
        body: {},
      });
      const ticket = (await issued.json()) as { ticket: string };
      const attempts = await Promise.all(
        [0, 1].map(() =>
          load.fetch(r, '/ws', {
            headers: {
              Upgrade: 'websocket',
              'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${ticket.ticket}`,
            },
          }),
        ),
      );
      expect(attempts.map((a) => a.status).sort()).toEqual([101, 409]);
      const socket = attempts.find((a) => a.status === 101)!.webSocket!;
      socket.accept();
      socket.close(1000);
      expect(
        (
          await load.fetch(r, '/ws', {
            headers: {
              Upgrade: 'websocket',
              'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${ticket.ticket}`,
            },
          })
        ).status,
      ).toBe(409);
    });
    await loadEvidence('replay-20', {
      scope: 'local-real-worker-tcp-and-upgrade',
      rooms: 20,
      signalReplaysRejected: 40,
      ticketReplaysRejected: 40,
      replayBypasses: 0,
    });
  } finally {
    await load.close();
  }
}, 90000);

for (const seed of [7, 19, 41, 97])
  it(`runs 250 real-worker admission/revocation schedules with seed ${seed}`, async () => {
    const load = await ControlLoad.start(),
      random = seeded(seed);
    try {
      // Keep each reference room below its unchanged 180/minute HTTP budget.
      const anchors = await parallel([0, 1, 2, 3], async () => {
        const room = await load.create();
        await load.admit(room);
        return room;
      });
      // Draw every plan before asynchronous I/O so scheduling cannot change the seed.
      const plans = Array.from({ length: 250 }, () => ({
        reverse: Boolean((random() >>> 16) & 1),
        approve: Boolean((random() >>> 16) & 1),
        expire: Boolean((random() >>> 16) & 1),
      }));
      await parallel(plans, async (plan, index) => {
        const anchor = anchors[index % anchors.length]!;
        const room = await load.create(),
          rivals = [candidate(), candidate()];
        if (plan.reverse) rivals.reverse();
        const joins = await Promise.all(
          rivals.map((guest) =>
            load.fetch(room, '/join', {
              method: 'POST',
              token: room.room.inviteCapability,
              body: guest,
            }),
          ),
        );
        expect(joins.map((r) => r.status).sort()).toEqual([201, 409]);
        const winner = rivals[joins.findIndex((r) => r.status === 201)]!;
        const decision = plan.approve ? 'approve' : 'reject';
        const decisions = await Promise.all(
          [decision, decision].map((d) =>
            load.fetch(room, '/decisions', {
              method: 'POST',
              token: room.room.ownerCapability,
              body: { candidatePeerId: winner.peerId, decision: d },
            }),
          ),
        );
        expect(decisions.map((r) => r.status)).toEqual([200, 200]);
        expect(
          (await load.fetch(room, '/status', { token: anchor.room.ownerCapability })).status,
        ).toBe(403);
        expect(
          (
            await load.fetch(anchor, '', {
              method: 'DELETE',
              token: room.room.ownerCapability,
              headers: { 'CF-Connecting-IP': room.ip },
            })
          ).status,
        ).toBe(403);
        const db = await storage(load.worker, room.room.roomId);
        expect(await db.exec('SELECT COUNT(*) AS count FROM peers')).toEqual([{ count: 2 }]);
        expect(
          (
            await db.exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM peers WHERE approval='approved'",
            )
          )[0]!.count,
        ).toBeLessThanOrEqual(2);
        if (plan.expire) {
          await db.exec('UPDATE room_meta SET expires_at = ?', Date.now() - 1);
          expect(
            (await load.fetch(room, '/status', { token: room.room.ownerCapability })).status,
          ).toBe(410);
        } else {
          const closed = await Promise.all(
            [0, 1].map(() =>
              load.fetch(room, '', { method: 'DELETE', token: room.room.ownerCapability }),
            ),
          );
          expect(closed.map((r) => r.status)).toEqual([200, 200]);
        }
        expect(
          (
            await load.fetch(room, '/join', {
              method: 'POST',
              token: room.room.inviteCapability,
              body: winner,
            })
          ).status,
        ).toBe(410);
      });
      for (const anchor of anchors)
        expect(
          (
            await load.fetch(anchor, '/status', {
              token: anchor.room.ownerCapability,
              headers: { 'CF-Connecting-IP': '2001:db8:14::fffe' },
            })
          ).status,
        ).toBe(200);
      await loadEvidence(`schedules-${seed}`, {
        scope: 'real-local-worker-sqlite-http',
        seed,
        schedules: 250,
        authorizationViolations: 0,
        isolationViolations: 0,
      });
    } finally {
      await load.close();
    }
  }, 180000);
