import { describe, expect, it, vi } from 'vitest';
import gateway from '../../infrastructure/cloudflare/pages-worker';
import { deploymentConfig } from '../../scripts/deploy/config';
import { audit } from '../../apps/signaling/src/audit';
import { ensureWorkersSubdomain } from '../../scripts/deploy/bootstrap';

const values = { PAGES_PROJECT: 'meshdrop-test-preview', OPS_REVOKE_SECRET: 'a'.repeat(43) };
describe('P9 deployment isolation and gateway boundary', () => {
  it('preserves an existing account subdomain without mutation', async () => {
    const transport = vi.fn(async () =>
      Response.json({ success: true, result: { subdomain: 'existing-account' } }),
    );
    expect(
      await ensureWorkersSubdomain('a'.repeat(32), 'meshdrop-test', 'test-token', transport),
    ).toBe('existing-account');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('initializes only an explicitly missing account subdomain', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { subdomain: 'meshdrop-test' } }),
      );
    expect(
      await ensureWorkersSubdomain('a'.repeat(32), 'meshdrop-test', 'test-token', transport),
    ).toBe('meshdrop-test');
    expect(transport.mock.calls[1]![1].method).toBe('PUT');
  });
  it('does not initialize an account after a permission failure', async () => {
    const transport = vi.fn(async () =>
      Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 403 }),
    );
    await expect(
      ensureWorkersSubdomain('a'.repeat(32), 'meshdrop-test', 'test-token', transport),
    ).rejects.toThrow('lookup failed');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('isolates room actors, rate limit namespaces and origins across environments', () => {
    const preview = deploymentConfig('preview', values, '/tmp/meshdrop');
    const production = deploymentConfig(
      'production',
      { ...values, PAGES_PROJECT: 'meshdrop-test-production' },
      '/tmp/meshdrop',
    );
    expect(preview.workerName).not.toBe(production.workerName);
    expect(preview.worker.ratelimits[0]!.namespace_id).not.toBe(
      production.worker.ratelimits[0]!.namespace_id,
    );
    expect(preview.pages.services[0]!.service).toBe(preview.workerName);
    expect(preview.worker.vars.ALLOWED_ORIGINS).toBe(preview.origin);
    expect(preview.worker.workers_dev).toBe(false);
    expect(JSON.stringify(preview.worker)).not.toContain(values.OPS_REVOKE_SECRET);
    expect(preview.worker.observability.logs.invocation_logs).toBe(false);
    expect(() => deploymentConfig('production', values, '/tmp/meshdrop')).toThrow();
  });
  it.each([
    { PUBLIC_ORIGIN: 'http://example.com' },
    { PUBLIC_ORIGIN: 'https://example.com/path' },
    { OPS_REVOKE_SECRET: 'short' },
    { TURN_URLS: 'turn:relay.example.com:3478' },
    { TURN_SHARED_SECRET: 'x'.repeat(32) },
  ])('rejects unsafe configuration %j', (override) => {
    expect(() =>
      deploymentConfig('preview', { ...values, ...override }, '/tmp/meshdrop'),
    ).toThrow();
  });
  it('adds browser policy to function-served assets and never proxies static requests', async () => {
    const upstream = vi.fn();
    const response = await gateway.fetch(new Request('https://meshdrop.test/'), {
      PUBLIC_ORIGIN: 'https://meshdrop.test',
      SIGNALING: { fetch: upstream },
      ASSETS: { fetch: async () => new Response('<html>MeshDrop</html>') },
    });
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('refuses branch aliases, keeps explicit origins, and infers Origin only for safe GET', async () => {
    const seen: Request[] = [];
    const env = {
      PUBLIC_ORIGIN: 'https://meshdrop.test',
      SIGNALING: {
        fetch: async (request: Request) => {
          seen.push(request);
          return new Response('{}');
        },
      },
      ASSETS: { fetch: async () => new Response('asset') },
    };
    expect(
      (await gateway.fetch(new Request('https://branch.meshdrop.test/v1/sessions'), env)).status,
    ).toBe(403);
    for (const init of [
      undefined,
      { method: 'POST' },
      { headers: { Origin: 'https://evil.test' } },
      { headers: { Upgrade: 'websocket' } },
    ])
      await gateway.fetch(new Request('https://meshdrop.test/v1/sessions', init), env);
    expect(seen.map((request) => request.headers.get('Origin'))).toEqual([
      'https://meshdrop.test',
      null,
      'https://evil.test',
      null,
    ]);
    expect(
      (
        await gateway.fetch(new Request('https://meshdrop.test/v1/sessions'), {
          ...env,
          SIGNALING: {
            fetch: async () => {
              throw new Error('private-capability');
            },
          },
        })
      ).status,
    ).toBe(503);
  });
  it('logs only fixed classifications without client-derived values', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      audit({ AUDIT_LOGS: 'true', ENVIRONMENT: 'production' }, '/private-room?cap=secret', 403);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
        event: 'meshdrop.control',
        environment: 'production',
        operation: 'other',
        status: 403,
      });
    } finally {
      log.mockRestore();
    }
  });
});
