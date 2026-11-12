import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { ControlLoad, loadEvidence, parallel } from '../helpers/control-load';
import { storage } from './harness';

it('runs 25 real local expiry/purge alarms among 50 connected rooms without affecting surviving pairs', async () => {
  const compiled = await build({
    stdin: {
      contents: `
    import app,{ SessionRoom as Base } from './apps/signaling/src/index.ts';
    export { RelayPool,OperationsMonitor } from './apps/signaling/src/index.ts';
    export class SessionRoom extends Base {
      async fetch(request) {
        const path=new URL(request.url).pathname;
        if(path==='/task14-schedule-alarm') {await this.ctx.storage.setAlarm(Date.now()+1);return Response.json({scheduled:true});}
        if(path==='/task14-inspect') return Response.json({alarm:await this.ctx.storage.getAlarm(),openSockets:this.ctx.getWebSockets().filter(ws=>ws.readyState===1).length});
        return super.fetch(request);
      }
    }
    export default app;`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:workers'],
  });
  const load = await ControlLoad.start(
    { CLOSED_TOMBSTONE_SECONDS: '1' },
    compiled.outputFiles[0]!.text,
  );
  try {
    const rooms = await parallel(Array.from({ length: 50 }), () => load.create());
    await parallel(rooms, async (r) => {
      await load.admit(r);
      await load.connect(r);
      await load.advance(r);
    });
    const expired = rooms.slice(0, 25),
      alive = rooms.slice(25),
      actors = await load.worker.getDurableObjectNamespace('SESSION_ROOMS');
    const databases = await parallel(expired, async (r) => {
      const db = await storage(load.worker, r.room.roomId);
      await db.exec('UPDATE room_meta SET expires_at = ?', Date.now() - 1);
      const response = await actors
        .get(actors.idFromName(r.room.roomId))
        .fetch('https://room.internal/task14-schedule-alarm');
      expect(response.status).toBe(200);
      return db;
    });
    await load.settleClosed(expired.flatMap((r) => [r.owner!, r.receiver!]));
    await parallel(alive, (r) => load.exchange(r));
    await expect
      .poll(
        async () => {
          const counts = await parallel(databases, (db) =>
            db.exec<{ remaining: number }>(
              'SELECT (SELECT COUNT(*) FROM room_meta)+(SELECT COUNT(*) FROM peers)+(SELECT COUNT(*) FROM invites)+(SELECT COUNT(*) FROM ticket_nonces)+(SELECT COUNT(*) FROM security_windows) AS remaining',
            ),
          );
          return counts.reduce((sum, rows) => sum + rows[0]!.remaining, 0);
        },
        { timeout: 10000 },
      )
      .toBe(0);
    await parallel(expired, async (r) => {
      const response = await actors
        .get(actors.idFromName(r.room.roomId))
        .fetch('https://room.internal/task14-inspect');
      expect(await response.json()).toEqual({ alarm: null, openSockets: 0 });
      expect((await load.fetch(r, '/status', { token: r.room.ownerCapability })).status).toBe(404);
    });
    await parallel(alive, (r) => load.exchange(r));
    await loadEvidence('expiry-cleanup-25', {
      scope: 'local-workerd-real-alarms-synthetic-expiry-timestamps',
      connectedRooms: 50,
      expiredRooms: 25,
      purgedRooms: 25,
      remainingApplicationRows: 0,
      remainingExpiredRoomAlarms: 0,
      survivingPairs: 25,
    });
  } finally {
    await load.close();
  }
  expect(load.forcedCleanup).toBe(0);
}, 90000);
