import { expect, it } from 'vitest';
import { request, runtime } from './harness';
import { loadEvidence, parallel } from '../helpers/control-load';

it('enforces the declared 30/minute creation boundary and rejects a further 100-request burst without identity bleed', async () => {
  const worker = await runtime({
    createLimit: 30,
    requestLimit: 300,
    outboundService: async () => new Response(null, { status: 503 }),
  });
  const create = (ip: string) =>
    request(worker, '/v1/sessions', {
      method: 'POST',
      body: {},
      headers: { 'CF-Connecting-IP': ip },
    });
  try {
    for (let n = 0; n < 29; n++) expect((await create('192.0.2.14')).status).toBe(201);
    expect((await create('192.0.2.14')).status).toBe(201);
    const over = await create('192.0.2.14');
    expect(over.status).toBe(429);
    expect(over.headers.get('Retry-After')).toBe('60');
    const storm = await parallel(Array.from({ length: 100 }), () => create('192.0.2.14'));
    expect(storm.every((r) => r.status === 429)).toBe(true);
    expect((await create('192.0.2.15')).status).toBe(201);
    await loadEvidence('creation-rate-boundary', {
      scope: 'local-native-rate-binding',
      limit: 30,
      allowed: 30,
      excessRejected: 101,
      unrelatedIdentityAllowed: 1,
    });
  } finally {
    await worker.dispose();
  }
}, 30000);
