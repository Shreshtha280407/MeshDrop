import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { runtime } from './harness';
import { loadEvidence, parallel } from '../helpers/control-load';
import { deferred, until } from '../helpers/streaming-transfer';

const key = () => ({
  username: 'task14-ready',
  apiKey: 'k'.repeat(32),
  createdAt: Date.now() - 200000,
  readyAt: Date.now() - 80000,
  expiresAt: Date.now() + 400000,
  upperExpiresAt: Date.now() + 400000,
});
const credentials = () =>
  Response.json([
    {
      urls: 'turn:fixture.metered.ca:3478?transport=udp',
      username: 'task14-ready',
      credential: 'synthetic-turn-credential',
    },
  ]);
async function relayScript() {
  const built = await build({
    stdin: {
      contents: `
    import app,{RelayPool as Base}from './apps/signaling/src/index.ts';
    export {SessionRoom,OperationsMonitor}from './apps/signaling/src/index.ts';
    export class RelayPool extends Base {
      task14Active=0;
      async fetch(request){const path=new URL(request.url).pathname;
        if(path==='/task14-seed'){await this.ctx.storage.put('pool',await request.json());return Response.json({seeded:true});}
        if(path==='/task14-active')return Response.json({active:this.task14Active});
        if(path!=='/credentials')return super.fetch(request);
        this.task14Active++;try{return await super.fetch(request);}finally{this.task14Active--;}
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
  return built.outputFiles[0]!.text;
}
const bindings = {
  TURN_PROVIDER: 'metered',
  METERED_DOMAIN: 'synthetic.metered.live',
  METERED_SECRET_KEY: 's'.repeat(32),
  METERED_FREE_ONLY: 'true',
};

for (const usage of [0.399999, 0.4, 0.449999, 0.45, 0.5, null])
  it(`coalesces 100 concurrent mocked relay usage reads and fails safely at usage ${usage}`, async () => {
    let quotaReads = 0,
      credentialReads = 0,
      mints = 0;
    const gate = deferred();
    const worker = await runtime({
      script: await relayScript(),
      bindings,
      createLimit: 30,
      requestLimit: 300,
      outboundService: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/current_usage')) {
          quotaReads++;
          await gate.promise;
          return usage === null
            ? new Response(null, { status: 503 })
            : Response.json({ quotaInGB: 0.5, usageInGB: usage, overageInGB: 0 });
        }
        if (path.endsWith('/credentials')) {
          credentialReads++;
          return credentials();
        }
        if (path.endsWith('/credential')) mints++;
        return new Response(null, { status: 503 });
      },
    });
    // A persisted fixture is reloaded by the real actor constructor. No provider is contacted.
    const ns = await worker.getDurableObjectNamespace('RELAY_POOLS');
    await ns.get(ns.idFromName('deployment')).fetch('https://relay.internal/task14-seed', {
      method: 'POST',
      body: JSON.stringify({ keys: [key()], checkedAt: 0, allowed: false, usage: null }),
    });
    await worker.unsafeEvictDurableObject('meshdrop-p1-test', 'RelayPool', { name: 'deployment' });
    const pending: ReturnType<ReturnType<typeof ns.get>['fetch']>[] = [];
    try {
      pending.push(
        ...Array.from({ length: 100 }, () =>
          ns.get(ns.idFromName('deployment')).fetch('https://relay.internal/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomExpiresAt: Date.now() + 800000 }),
          }),
        ),
      );
      const completed = Promise.all(pending);
      void completed.catch(() => {});
      await expect
        .poll(async () => {
          const r = await ns
            .get(ns.idFromName('deployment'))
            .fetch('https://relay.internal/task14-active');
          return ((await r.json()) as { active: number }).active;
        })
        .toBe(100);
      await until(() => quotaReads > 0);
      expect(quotaReads).toBe(1);
      gate.release();
      const responses = await completed;
      for (const response of responses) {
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          relayAvailable: boolean;
          expiresAt: number;
          iceServers: unknown[];
        };
        expect(result.relayAvailable).toBe(usage !== null && usage < 0.45);
        if (result.relayAvailable) expect(result.expiresAt).toBeLessThan(Date.now() + 600000);
        else expect(result.iceServers).toEqual([]);
      }
      expect(quotaReads).toBe(1);
      expect(mints).toBe(0);
      expect(credentialReads).toBe(usage !== null && usage < 0.45 ? 100 : 0);
      await loadEvidence(`relay-usage-${usage}`, {
        scope: 'synthetic-provider-fixtures-only-no-relay-traffic',
        concurrentRequests: 100,
        quotaReads,
        newKeysMinted: mints,
        credentialReads,
        relayIssuanceAllowed: usage !== null && usage < 0.45,
      });
    } finally {
      gate.release();
      await Promise.allSettled(pending);
      await worker.dispose();
    }
  });

it('rechecks twenty room authorizations after delayed mocked provider responses and issues nothing to revoked rooms', async () => {
  const gate = deferred();
  let reads = 0;
  const worker = await runtime({
    script: await relayScript(),
    bindings,
    createLimit: 30,
    requestLimit: 300,
    outboundService: async (request) => {
      if (new URL(request.url).pathname.endsWith('/credentials')) {
        reads++;
        await gate.promise;
        return credentials();
      }
      return new Response(null, { status: 503 });
    },
  });
  const ns = await worker.getDurableObjectNamespace('RELAY_POOLS');
  await ns.get(ns.idFromName('deployment')).fetch('https://relay.internal/task14-seed', {
    method: 'POST',
    body: JSON.stringify({
      keys: [key()],
      checkedAt: Date.now(),
      allowed: true,
      usage: { quotaInGB: 0.5, usageInGB: 0, overageInGB: 0 },
    }),
  });
  await worker.unsafeEvictDurableObject('meshdrop-p1-test', 'RelayPool', { name: 'deployment' });
  // Use the real admitted-room fixture with this contained runtime, not a provider account.
  const { create, join, approve, request } = await import('./harness');
  try {
    const rooms = await parallel(Array.from({ length: 20 }), async () => {
      const r = await create(worker);
      const { guest } = await join(worker, r);
      expect((await approve(worker, r, guest.peerId)).status).toBe(200);
      return r;
    });
    const pending = rooms.map((r) =>
      request(worker, `/v1/sessions/${r.roomId}/ice-credentials`, {
        method: 'POST',
        token: r.ownerCapability,
        body: {},
      }),
    );
    await until(() => reads === 20);
    await parallel(rooms.slice(0, 10), async (r) => {
      expect(
        (
          await request(worker, `/v1/sessions/${r.roomId}`, {
            method: 'DELETE',
            token: r.ownerCapability,
          })
        ).status,
      ).toBe(200);
    });
    gate.release();
    const results = await Promise.all(pending);
    expect(results.slice(0, 10).map((r) => r.status)).toEqual(Array(10).fill(410));
    for (const result of results.slice(10)) {
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ relayAvailable: true });
    }
    await loadEvidence('relay-revocation-race', {
      scope: 'real-local-room-auth-with-synthetic-provider',
      concurrentRequests: 20,
      revoked: 10,
      revokedCredentialsIssued: 0,
      authorizedIssuance: 10,
    });
  } finally {
    gate.release();
    await worker.dispose();
  }
});
