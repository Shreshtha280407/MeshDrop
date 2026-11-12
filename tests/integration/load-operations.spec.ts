import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { API, capability, request, runtime } from './harness';
import { loadEvidence, parallel } from '../helpers/control-load';

async function monitorFixture(
  config: { deliver?: boolean; singleOrigin?: boolean; relay?: boolean } = {},
) {
  const operator = capability();
  // Read-only alarm inspection exists only in this local test bundle, never the application.
  const built = await build({
    stdin: {
      contents: `
    import app, { OperationsMonitor as Base } from './apps/signaling/src/index.ts';
    export { SessionRoom, RelayPool } from './apps/signaling/src/index.ts';
    export class OperationsMonitor extends Base {
      async fetch(request) {
        if (new URL(request.url).pathname === '/task14-alarm') return Response.json({ alarm: await this.ctx.storage.getAlarm() });
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
  const worker: Awaited<ReturnType<typeof runtime>> = await runtime({
    script: built.outputFiles[0]!.text,
    createLimit: 30,
    requestLimit: 300,
    bindings: {
      OPS_REVOKE_SECRET: operator,
      ...(config.singleOrigin ? { ALLOWED_ORIGINS: API } : {}),
      ...(config.relay
        ? {
            TURN_PROVIDER: 'metered',
            METERED_DOMAIN: 'synthetic.metered.live',
            METERED_SECRET_KEY: 's'.repeat(32),
            METERED_FREE_ONLY: 'true',
          }
        : {}),
    },
    // Every outbound request is contained. No actual provider/webhook is contacted.
    outboundService: async (req) => {
      if (config.deliver && req.url === `${API}/ops/alerts/receive`)
        return worker.dispatchFetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: await req.text(),
        });
      if (config.relay && new URL(req.url).pathname.endsWith('/current_usage'))
        return Response.json({ quotaInGB: 0.5, usageInGB: 0.4, overageInGB: 0 });
      return new Response(null, { status: 503 });
    },
  });
  await request(worker, '/ops/metrics', { token: operator });
  const db = await worker.unsafeGetDurableObjectStorage('meshdrop-p1-test', 'OperationsMonitor', {
    name: 'counters',
  });
  return { worker, operator, db };
}

it('rejects new alert work explicitly when the pending queue is full without deleting existing evidence', async () => {
  const { worker, operator, db } = await monitorFixture();
  try {
    for (let i = 0; i < 128; i++)
      await db.exec(
        'INSERT INTO outbox VALUES(?,?,?)',
        `delivery_test:${i}`,
        JSON.stringify({
          id: `delivery_test:${i}`,
          kind: 'delivery_test',
          environment: 'preview',
          observedAt: Date.now(),
          value: 1,
          threshold: 1,
        }),
        Date.now(),
      );
    const before = await db.exec('SELECT * FROM outbox ORDER BY id');
    const response = await request(worker, '/ops/alerts/test', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await db.exec('SELECT * FROM outbox ORDER BY id')).toEqual(before);
  } finally {
    await worker.dispose();
  }
});

async function fill(db: Awaited<ReturnType<typeof monitorFixture>>['db'], count = 128) {
  for (let i = 0; i < count; i++)
    await db.exec(
      'INSERT INTO outbox VALUES(?,?,?)',
      `delivery_test:${i}`,
      JSON.stringify({
        id: `delivery_test:${i}`,
        kind: 'delivery_test',
        environment: 'preview',
        observedAt: Date.now(),
        value: 1,
        threshold: 1,
      }),
      Date.now(),
    );
}

it('a full queue still drains and recovers instead of permanently blocking monitoring', async () => {
  const { worker, operator, db } = await monitorFixture({ singleOrigin: true, deliver: true });
  try {
    await fill(db);
    await db.exec(
      'INSERT INTO buckets VALUES(?,?,?)',
      Math.floor(Date.now() / 60000),
      'failed_joins',
      10,
    );
    const response = await request(worker, '/ops/alerts/evaluate', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(response.status).toBe(429);
    expect(await db.exec('SELECT COUNT(*) AS count FROM outbox')).toEqual([{ count: 123 }]);
    const recovery = await request(worker, '/ops/alerts/evaluate', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(recovery.status).toBe(200);
    expect(
      (await db.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox'))[0]!.count,
    ).toBeLessThan(123);
    const journal = await worker.unsafeGetDurableObjectStorage(
      'meshdrop-p1-test',
      'OperationsMonitor',
      { name: 'journal' },
    );
    expect(
      (await journal.exec<{ count: number }>('SELECT COUNT(*) AS count FROM journal'))[0]!.count,
    ).toBeGreaterThan(0);
  } finally {
    await worker.dispose();
  }
});

it('does not hide relay-warning queue overload as an unknown provider response', async () => {
  const { worker, operator, db } = await monitorFixture({ relay: true });
  try {
    expect(
      (await request(worker, '/ops/relay/warm', { method: 'POST', token: operator, body: {} }))
        .status,
    ).toBe(200);
    await fill(db);
    const response = await request(worker, '/ops/alerts/evaluate', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await db.exec('SELECT COUNT(*) AS count FROM outbox')).toEqual([{ count: 128 }]);
  } finally {
    await worker.dispose();
  }
});

it('preserves a legacy overflow queue while rejecting further admission', async () => {
  const { worker, operator, db } = await monitorFixture();
  try {
    await fill(db, 130);
    expect(
      (await request(worker, '/ops/alerts/test', { method: 'POST', token: operator, body: {} }))
        .status,
    ).toBe(429);
    expect(await db.exec('SELECT COUNT(*) AS count FROM outbox')).toEqual([{ count: 130 }]);
  } finally {
    await worker.dispose();
  }
});

it('aggregates a thousand private events, rejects extra fields and deduplicates delivered alerts', async () => {
  const { worker, operator, db } = await monitorFixture({ singleOrigin: true, deliver: true });
  try {
    await db.exec(
      'INSERT INTO buckets VALUES(?,?,?)',
      Math.floor(Date.now() / 60000) - 2000,
      'requests',
      999,
    );
    const ns = await worker.getDurableObjectNamespace('OPERATIONS_MONITOR'),
      actor = ns.get(ns.idFromName('counters'));
    await parallel(
      Array.from({ length: 1000 }, (_, i) => i),
      async (i) => {
        const body =
          i % 4 < 2
            ? { operation: 'join', status: 403 }
            : i % 4 === 2
              ? { operation: 'control', status: 500 }
              : { operation: 'create', status: 201 };
        const result = await actor.fetch('https://monitor.internal/record', {
          method: 'POST',
          headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(result.status).toBe(200);
      },
    );
    const summary = await request(worker, '/ops/metrics', { token: operator });
    expect(await summary.json()).toMatchObject({
      requestsToday: 1000,
      failedJoinsLastFiveMinutes: 500,
      serverErrorsLastFiveMinutes: 250,
    });
    expect((await db.exec('SELECT * FROM buckets')).length).toBeLessThanOrEqual(6);
    const forbidden = await actor.fetch('https://monitor.internal/record', {
      method: 'POST',
      headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'join', status: 403, capability: 'task14-private-canary' }),
    });
    expect(forbidden.status).toBe(400);
    expect(
      (await request(worker, '/ops/alerts/evaluate', { method: 'POST', token: operator, body: {} }))
        .status,
    ).toBe(200);
    const alerts = (await (await request(worker, '/ops/alerts', { token: operator })).json()) as {
      alerts: unknown[];
    };
    expect(alerts.alerts).toHaveLength(2);
    await parallel(Array.from({ length: 20 }), async () => {
      expect(
        (
          await request(worker, '/ops/alerts/receive', {
            method: 'POST',
            token: operator,
            body: alerts.alerts[0],
          })
        ).status,
      ).toBe(200);
    });
    const repeated = await request(worker, '/ops/alerts', { token: operator }),
      text = await repeated.text();
    expect((JSON.parse(text) as { alerts: unknown[] }).alerts).toHaveLength(2);
    expect(text).not.toContain(operator);
    expect(text).not.toContain('task14-private-canary');
    await loadEvidence('monitoring-1000', {
      scope: 'local-real-aggregation-and-private-journal',
      events: 1000,
      failedJoins: 500,
      serverErrors: 250,
      alerts: 2,
      replayedDeliveries: 20,
      duplicatesStored: 0,
      sensitiveFieldsAccepted: 0,
    });
  } finally {
    await worker.dispose();
  }
}, 30000);

it('bounds the private journal to 128 entries and its response to twenty under a 200-alert burst', async () => {
  const { worker, operator } = await monitorFixture();
  try {
    await parallel(
      Array.from({ length: 200 }, (_, i) => i),
      async (i) => {
        expect(
          (
            await request(worker, '/ops/alerts/receive', {
              method: 'POST',
              token: operator,
              body: {
                id: `delivery_test:${i}`,
                kind: 'delivery_test',
                environment: 'preview',
                observedAt: Date.now(),
                value: 1,
                threshold: 1,
              },
            })
          ).status,
        ).toBe(200);
      },
    );
    const db = await worker.unsafeGetDurableObjectStorage('meshdrop-p1-test', 'OperationsMonitor', {
      name: 'journal',
    });
    expect(await db.exec('SELECT COUNT(*) AS count FROM journal')).toEqual([{ count: 128 }]);
    const response = await request(worker, '/ops/alerts', { token: operator });
    expect(((await response.json()) as { alerts: unknown[] }).alerts).toHaveLength(20);
  } finally {
    await worker.dispose();
  }
}, 30000);

it('expires old pending evidence even when webhook configuration cannot deliver', async () => {
  const { worker, operator, db } = await monitorFixture();
  try {
    for (let i = 0; i < 128; i++)
      await db.exec(
        'INSERT INTO outbox VALUES(?,?,?)',
        `delivery_test:${i}`,
        '{}',
        Date.now() - 86400001,
      );
    const response = await request(worker, '/ops/alerts/test', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pendingDeliveries: 1 });
    expect(await db.exec('SELECT * FROM outbox')).toHaveLength(1);
  } finally {
    await worker.dispose();
  }
});

it('arms a local retry alarm for a failed diagnostic alert without relying on unrelated traffic', async () => {
  const { worker, operator } = await monitorFixture();
  try {
    const response = await request(worker, '/ops/alerts/test', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pendingDeliveries: 1 });
    const actors = await worker.getDurableObjectNamespace('OPERATIONS_MONITOR');
    const inspected = await actors
      .get(actors.idFromName('counters'))
      .fetch('https://monitor.internal/task14-alarm');
    expect(((await inspected.json()) as { alarm: number | null }).alarm).not.toBeNull();
  } finally {
    await worker.dispose();
  }
});
