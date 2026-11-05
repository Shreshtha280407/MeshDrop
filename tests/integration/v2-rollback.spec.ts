import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { sessionStatusSchema } from '@meshdrop/protocol';
import { inspectCommit } from '../../scripts/deploy/rollback-compatibility';
import { disposeLocalRuntime } from '../../scripts/deploy/local-rollback';
import { API, approve, capability, create, join as admit, request, runtime } from './harness';

// Read actual disposable SQLite files, including KV blobs hidden from the SQL
// inspection API. No production paths or state are opened, and no rows are logged.
async function persisted(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.sqlite') && entry.name !== 'metadata.sqlite') {
        const database = new DatabaseSync(file, { readOnly: true });
        try {
          const tables = database
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all();
          const rows = tables.map(({ name }) => {
            const query = database.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`);
            query.setReadBigInts(true);
            return query
              .all()
              .map((row) =>
                JSON.stringify(row, (_, value: unknown) =>
                  typeof value === 'bigint' ? `bigint:${value}` : value,
                ),
              )
              .sort();
          });
          result[relative(directory, file)] = createHash('sha256')
            .update(JSON.stringify({ tables, rows }))
            .digest('hex');
        } finally {
          database.close();
        }
      }
    }
  }
  await visit(directory);
  expect(Object.keys(result).length).toBeGreaterThanOrEqual(4);
  return result;
}

it('retains all v2 actor SQL/KV state, authorization and drain through a real historical version and back', async () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const current = await inspectCommit(head);
  const previous = await inspectCommit('b103d568d7d2bed62957f4c129dc238a5b7752f6');
  // Persistence compatibility is separate from stricter release-tooling eligibility.
  expect(current.workerScript).toBe(previous.workerScript);
  expect(current.gatewayScript).toBe(previous.gatewayScript);
  expect(current.bindings).toEqual(previous.bindings);
  expect(current.migrations).toEqual(previous.migrations);
  expect(current.protocol).toBe(previous.protocol);
  const directory = await mkdtemp(join(tmpdir(), 'meshdrop-v2-state-'));
  const operator = capability();
  let worker: Miniflare | undefined, initialization: { error: unknown } | undefined;
  let started = 0,
    disposed = 0;
  const addresses: URL[] = [];
  const providerCalls: string[] = [];
  async function accountUsage() {
    const response = await request(worker!, '/ops/metrics', { token: operator });
    expect(response.status).toBe(200);
    return ((await response.json()) as { accountWorkerUsage: unknown }).accountWorkerUsage;
  }
  async function stop() {
    if (worker) {
      await disposeLocalRuntime(worker, initialization);
      worker = undefined;
      disposed++;
    }
  }
  async function start(script: string, paused = false) {
    initialization = undefined;
    worker = await runtime({
      persist: directory,
      script,
      bindings: {
        OPS_REVOKE_SECRET: operator,
        ADMISSION_PAUSED: String(paused),
        TURN_PROVIDER: 'metered',
        METERED_DOMAIN: 'synthetic.metered.live',
        METERED_SECRET_KEY: 's'.repeat(32),
        METERED_FREE_ONLY: 'true',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_ANALYTICS_API_TOKEN: 's'.repeat(40),
      },
      outboundService: async (req) => {
        const url = new URL(req.url);
        const endpoint = url.origin + url.pathname;
        providerCalls.push(endpoint);
        if (endpoint === 'https://api.cloudflare.com/client/v4/graphql')
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    workersInvocationsAdaptive: [{ sum: { requests: 42, errors: 0 } }],
                    pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 0, errors: 0 } }],
                    durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 7 } }],
                  },
                ],
              },
            },
          });
        if (endpoint === 'https://synthetic.metered.live/api/v1/turn/current_usage')
          return Response.json({ quotaInGB: 0.5, usageInGB: 0.1, overageInGB: 0 });
        if (endpoint === 'https://synthetic.metered.live/api/v1/turn/credential')
          return Response.json({
            username: 'synthetic-rollback-key',
            apiKey: 'a'.repeat(32),
            expiryInSeconds: 600,
          });
        return new Response('Outbound request blocked in local test.', { status: 503 });
      },
    });
    started++;
    try {
      addresses.push(await worker.ready);
    } catch (error) {
      initialization = { error };
      throw error;
    }
    expect((await worker.dispatchFetch(`${API}/health`)).status).toBe(200);
    return worker;
  }
  try {
    await start(current.workerScript);
    const room = await create(worker!);
    const { guest } = await admit(worker!, room);
    expect((await approve(worker!, room, guest.peerId)).status).toBe(200);
    expect(
      (await request(worker!, '/ops/relay/warm', { method: 'POST', token: operator, body: {} }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(worker!, '/ops/alerts/evaluate', {
          method: 'POST',
          token: operator,
          body: {},
        })
      ).status,
    ).toBe(200);
    const alert = {
      id: 'delivery_test:1',
      kind: 'delivery_test',
      environment: 'preview',
      observedAt: Date.now(),
      value: 1,
      threshold: 1,
    };
    expect(
      (
        await request(worker!, '/ops/alerts/receive', {
          method: 'POST',
          token: operator,
          body: alert,
        })
      ).status,
    ).toBe(200);
    const owner = sessionStatusSchema.parse(
      await (
        await request(worker!, `/v1/sessions/${room.roomId}/status`, {
          token: room.ownerCapability,
        })
      ).json(),
    );
    const relay = await (await request(worker!, '/ops/relay', { token: operator })).json();
    expect(relay).toMatchObject({
      provider: 'metered',
      ready: false,
      checkedAt: expect.any(Number),
      nextReadyAt: expect.any(Number),
      usage: { usageInGB: 0.1 },
    });
    const account = await accountUsage();
    expect(account).toMatchObject({
      available: true,
      measured: { requestsToday: 42, durableRequestsToday: 7 },
    });
    await stop();
    let state = await persisted(directory);
    for (const [script, paused] of [
      [previous.workerScript, false],
      [current.workerScript, false],
      [current.workerScript, true],
    ] as const) {
      await start(script, paused);
      // Exact SQL schema/rows, including real RelayPool/monitor KV blobs, before reads.
      expect(await persisted(directory)).toEqual(state);
      for (const [token, peerId, role] of [
        [room.ownerCapability, room.peerId, 'owner'],
        [guest.peerCapability, guest.peerId, 'receiver'],
      ] as const) {
        const response = await request(worker!, `/v1/sessions/${room.roomId}/status`, { token });
        expect(response.status).toBe(200);
        expect(sessionStatusSchema.parse(await response.json())).toMatchObject({
          roomId: room.roomId,
          peerId,
          role,
          state: 'approved',
          approval: 'approved',
          epoch: owner.epoch,
          expiresAt: owner.expiresAt,
        });
      }
      expect(await (await request(worker!, '/ops/relay', { token: operator })).json()).toEqual(
        relay,
      );
      expect(await accountUsage()).toEqual(account);
      expect(await (await request(worker!, '/ops/alerts', { token: operator })).json()).toEqual({
        alerts: [alert],
      });
      const calls = providerCalls.length;
      for (const token of [undefined, room.ownerCapability, capability()]) {
        for (const path of ['/ops/metrics', '/ops/alerts', '/ops/relay'])
          expect([401, 403]).toContain(
            (await request(worker!, path, token ? { token } : {})).status,
          );
      }
      expect(providerCalls).toHaveLength(calls);
      expect(
        (await request(worker!, `/v1/sessions/${room.roomId}/status`, { token: capability() }))
          .status,
      ).toBe(403);
      expect((await worker!.dispatchFetch(`${API}/ready`)).status).toBe(paused ? 503 : 200);
      if (paused) {
        expect((await request(worker!, '/v1/sessions', { method: 'POST', body: {} })).status).toBe(
          503,
        );
        expect(
          (
            await request(worker!, `/v1/sessions/${room.roomId}`, {
              method: 'DELETE',
              token: guest.peerCapability,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await request(worker!, `/v1/sessions/${room.roomId}`, {
              method: 'DELETE',
              token: room.ownerCapability,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await request(worker!, `/v1/sessions/${room.roomId}/status`, {
              token: room.ownerCapability,
            })
          ).status,
        ).toBe(410);
      }
      await stop();
      state = await persisted(directory);
    }
    expect(providerCalls).toHaveLength(3);
  } finally {
    try {
      await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  expect({ started, disposed }).toEqual({ started: 4, disposed: 4 });
  for (const url of addresses)
    await expect(
      fetch(new URL('/health', url), { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
}, 30000);
