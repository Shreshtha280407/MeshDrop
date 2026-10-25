import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { API, approve, capability, create, join, request, runtime } from './harness';

describe('free operations and relay admission', () => {
  let worker: Miniflare | undefined;
  afterEach(async () => {
    await worker?.dispose();
  });
  it.each([false, true])(
    'delivers real failed-join alerts over HTTPS with lost acknowledgement=%s',
    async (loseAck) => {
      const operator = capability();
      let lose = loseAck;
      worker = await runtime({
        bindings: { OPS_REVOKE_SECRET: operator, ALLOWED_ORIGINS: API },
        outboundService: async (req) => {
          if (req.url !== `${API}/ops/alerts/receive`) return new Response(null, { status: 502 });
          const delivered = await worker!.dispatchFetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: await req.text(),
          });
          if (lose) {
            lose = false;
            return new Response(null, { status: 503 });
          }
          return delivered;
        },
      });
      const created = await request(worker, '/v1/sessions', {
        method: 'POST',
        origin: API,
        body: {},
      });
      expect(created.status).toBe(201);
      const room = (await created.json()) as { roomId: string };
      for (let n = 0; n < 10; n++)
        expect(
          (
            await request(worker, `/v1/sessions/${room.roomId}/join`, {
              method: 'POST',
              origin: API,
              token: capability(),
              body: { peerId: crypto.randomUUID(), peerCapability: capability() },
            })
          ).status,
        ).toBe(403);
      await expect
        .poll(async () => {
          const response = await request(worker!, '/ops/metrics', { token: operator });
          return ((await response.json()) as { failedJoinsLastFiveMinutes: number })
            .failedJoinsLastFiveMinutes;
        })
        .toBe(10);
      const evaluated = await request(worker, '/ops/alerts/evaluate', {
        method: 'POST',
        token: operator,
        body: {},
      });
      expect(((await evaluated.json()) as { pendingDeliveries: number }).pendingDeliveries).toBe(
        loseAck ? 1 : 0,
      );
      if (loseAck)
        await request(worker, '/ops/alerts/evaluate', {
          method: 'POST',
          token: operator,
          body: {},
        });
      const journal = await request(worker, '/ops/alerts', { token: operator });
      const alerts = ((await journal.json()) as { alerts: { kind: string; value: number }[] })
        .alerts;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'failed_joins', value: 10 });
      expect(JSON.stringify(alerts)).not.toContain(room.roomId);
      expect(JSON.stringify(alerts)).not.toContain(operator);
    },
  );
  it('denies operator metrics and relay warmup to room owners and anonymous clients', async () => {
    worker = await runtime({ bindings: { OPS_REVOKE_SECRET: capability() } });
    const room = await create(worker);
    for (const token of [undefined, room.ownerCapability])
      for (const path of ['/ops/metrics', '/ops/alerts', '/ops/relay'])
        expect([401, 403]).toContain((await request(worker, path, token ? { token } : {})).status);
  });
  it('rejects unauthenticated and unapproved callers before touching a relay provider', async () => {
    let providerRequests = 0;
    worker = await runtime({
      bindings: {
        TURN_PROVIDER: 'metered',
        METERED_DOMAIN: 'synthetic.metered.live',
        METERED_SECRET_KEY: 's'.repeat(32),
        METERED_FREE_ONLY: 'true',
      },
      outboundService: async () => {
        providerRequests++;
        return new Response(null, { status: 500 });
      },
    });
    const room = await create(worker);
    expect(
      (
        await request(worker, `/v1/sessions/${room.roomId}/ice-credentials`, {
          method: 'POST',
          body: {},
        })
      ).status,
    ).toBe(401);
    expect(providerRequests).toBe(0);
  });
  it('retains direct ICE while a newly issued free relay key propagates', async () => {
    const operator = capability();
    let created = 0;
    const calls: string[] = [];
    worker = await runtime({
      bindings: {
        OPS_REVOKE_SECRET: operator,
        TURN_PROVIDER: 'metered',
        METERED_DOMAIN: 'synthetic.metered.live',
        METERED_SECRET_KEY: 's'.repeat(32),
        METERED_FREE_ONLY: 'true',
      },
      outboundService: async (req) => {
        const path = new URL(req.url).pathname;
        calls.push(path);
        if (path.endsWith('/current_usage'))
          return Response.json({ quotaInGB: 0.5, usageInGB: 0, overageInGB: 0 });
        if (path.endsWith('/credential')) {
          created++;
          return Response.json({
            username: 'synthetic-user',
            apiKey: 'a'.repeat(32),
            expiryInSeconds: 600,
          });
        }
        return new Response(null, { status: 500 });
      },
    });
    const warm = await request(worker, '/ops/relay/warm', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(warm.status).toBe(200);
    expect(calls).toEqual(['/api/v1/turn/current_usage', '/api/v1/turn/credential']);
    const state = (await warm.json()) as { ready: boolean; nextReadyAt: number };
    expect(state).toMatchObject({
      provider: 'metered',
      checkedAt: expect.any(Number),
      usage: { quotaInGB: 0.5 },
      nextReadyAt: expect.any(Number),
    });
    expect(state.ready).toBe(false);
    expect(state.nextReadyAt).toBeGreaterThan(Date.now() + 115000);
    expect(created).toBe(1);
    expect(JSON.stringify(state)).not.toMatch(/apiKey|username|password/);
    await request(worker, '/ops/relay/warm', { method: 'POST', token: operator, body: {} });
    expect(created).toBe(1);
    const room = await create(worker);
    const { guest } = await join(worker, room);
    await approve(worker, room, guest.peerId);
    const ice = await request(worker, `/v1/sessions/${room.roomId}/ice-credentials`, {
      method: 'POST',
      token: room.ownerCapability,
      body: {},
    });
    expect(ice.status).toBe(200);
    expect(await ice.json()).toMatchObject({
      relayAvailable: false,
      iceServers: expect.any(Array),
    });
    expect(calls).not.toContain('/api/v1/turn/credentials');
  });
  it.each([0.4, 0.45, 0.5])(
    'delivers a relay quota alert at %s GB and reserves the final ten percent',
    async (usage) => {
      const operator = capability();
      let created = 0;
      worker = await runtime({
        bindings: {
          OPS_REVOKE_SECRET: operator,
          ALLOWED_ORIGINS: API,
          TURN_PROVIDER: 'metered',
          METERED_DOMAIN: 'synthetic.metered.live',
          METERED_SECRET_KEY: 's'.repeat(32),
          METERED_FREE_ONLY: 'true',
        },
        outboundService: async (req) => {
          if (req.url === `${API}/ops/alerts/receive`)
            return worker!.dispatchFetch(req.url, {
              method: 'POST',
              headers: req.headers,
              body: await req.text(),
            });
          if (new URL(req.url).pathname.endsWith('/current_usage'))
            return Response.json({ quotaInGB: 0.5, usageInGB: usage, overageInGB: 0 });
          if (new URL(req.url).pathname.endsWith('/credential')) {
            created++;
            return Response.json({
              username: 'synthetic-user',
              apiKey: 'a'.repeat(32),
              expiryInSeconds: 600,
            });
          }
          return new Response(null, { status: 502 });
        },
      });
      await request(worker, '/ops/relay/warm', { method: 'POST', token: operator, body: {} });
      expect(created).toBe(usage < 0.45 ? 1 : 0);
      await request(worker, '/ops/alerts/evaluate', { method: 'POST', token: operator, body: {} });
      const journal = await request(worker, '/ops/alerts', { token: operator });
      expect(await journal.json()).toMatchObject({
        alerts: [{ kind: 'relay_quota', value: usage, threshold: 0.4 }],
      });
    },
  );
  it('rejects changed paid quotas before creating any relay credential', async () => {
    let created = 0;
    const operator = capability();
    worker = await runtime({
      bindings: {
        OPS_REVOKE_SECRET: operator,
        TURN_PROVIDER: 'metered',
        METERED_DOMAIN: 'synthetic.metered.live',
        METERED_SECRET_KEY: 's'.repeat(32),
        METERED_FREE_ONLY: 'true',
      },
      outboundService: async (req) => {
        if (new URL(req.url).pathname.endsWith('/credential')) created++;
        return Response.json({ quotaInGB: 50, usageInGB: 0, overageInGB: 0 });
      },
    });
    const response = await request(worker, '/ops/relay/warm', {
      method: 'POST',
      token: operator,
      body: {},
    });
    expect(((await response.json()) as { ready: boolean }).ready).toBe(false);
    expect(created).toBe(0);
  });
  it('stores idempotent webhook delivery without accepting file or identity metadata', async () => {
    const operator = capability();
    worker = await runtime({ bindings: { OPS_REVOKE_SECRET: operator } });
    const body = {
      id: 'failed_joins:123',
      kind: 'failed_joins',
      environment: 'preview',
      observedAt: Date.now(),
      value: 10,
      threshold: 10,
    };
    for (let n = 0; n < 2; n++)
      expect(
        (await request(worker, '/ops/alerts/receive', { method: 'POST', token: operator, body }))
          .status,
      ).toBe(200);
    const response = await request(worker, '/ops/alerts', { token: operator });
    expect(await response.json()).toEqual({ alerts: [body] });
    expect(
      (
        await request(worker, '/ops/alerts/receive', {
          method: 'POST',
          token: operator,
          body: { ...body, environment: 'production' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(worker, '/ops/alerts/receive', {
          method: 'POST',
          token: operator,
          body: { ...body, filename: 'private-file' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await worker.dispatchFetch(`${API}/ops/alerts?cap=forbidden`, {
          headers: { Authorization: `Bearer ${operator}` },
        })
      ).status,
    ).toBe(403);
  });
  it.each([false, true])(
    'uses provider-wide request evidence, unavailable=%s',
    async (unavailable) => {
      const operator = capability();
      let reads = 0;
      worker = await runtime({
        bindings: {
          OPS_REVOKE_SECRET: operator,
          ALLOWED_ORIGINS: API,
          CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
          CLOUDFLARE_ANALYTICS_API_TOKEN: 's'.repeat(40),
        },
        outboundService: async (req) => {
          if (req.url === 'https://api.cloudflare.com/client/v4/graphql') {
            reads++;
            expect(req.headers.get('Authorization')).toBe(`Bearer ${'s'.repeat(40)}`);
            if (unavailable)
              return Response.json({ errors: [{ message: 'private provider denial' }] });
            return Response.json({
              data: {
                viewer: {
                  accounts: [
                    {
                      workersInvocationsAdaptive: [{ sum: { requests: 40001, errors: 0 } }],
                      pagesFunctionsInvocationsAdaptiveGroups: [
                        { sum: { requests: 40000, errors: 0 } },
                      ],
                      durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 0 } }],
                    },
                  ],
                },
              },
            });
          }
          if (req.url === `${API}/ops/alerts/receive`)
            return worker!.dispatchFetch(req.url, {
              method: 'POST',
              headers: req.headers,
              body: await req.text(),
            });
          return new Response(null, { status: 502 });
        },
      });
      for (let n = 0; n < 2; n++) {
        const response = await request(worker, '/ops/alerts/evaluate', {
          method: 'POST',
          token: operator,
          body: {},
        });
        expect(await response.json()).toMatchObject({
          accountWorkerUsage: {
            available: !unavailable,
            measured: unavailable ? null : { requestsToday: 80001 },
          },
        });
      }
      expect(reads).toBe(1);
      const response = await request(worker, '/ops/alerts', { token: operator });
      expect(await response.json()).toMatchObject({
        alerts: unavailable
          ? []
          : [{ kind: 'account_worker_request_budget', value: 80001, threshold: 80000 }],
      });
    },
  );
});
