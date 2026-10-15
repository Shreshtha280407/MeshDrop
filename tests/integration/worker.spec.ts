import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { DEFAULT_FRAME_BYTES, PROTOCOL_VERSION } from '@meshdrop/protocol';

describe('P0 Worker running in workerd', () => {
  let worker: Miniflare;
  beforeAll(async () => {
    const output = await build({
      entryPoints: ['apps/signaling/src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
    });
    const script = output.outputFiles?.[0]?.text;
    if (!script) throw new Error('Worker bundle was not created.');
    worker = new Miniflare({ modules: true, script, compatibilityDate: '2026-07-01', cf: false });
  });
  afterAll(async () => {
    await worker?.dispose();
  });
  it('reports a scaffold without claiming functional sessions', async () => {
    const response = await worker.dispatchFetch('http://local.test/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      phase: 'P0',
      status: 'scaffold',
      sessionsAvailable: false,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('shares the browser protocol constants', async () => {
    const response = await worker.dispatchFetch('http://local.test/v1/protocol');
    expect(await response.json()).toMatchObject({
      version: PROTOCOL_VERSION,
      defaultFrameBytes: DEFAULT_FRAME_BYTES,
    });
  });
  it('rejects session creation and file uploads until implemented', async () => {
    for (const path of ['/v1/sessions', '/upload', '/unknown']) {
      const response = await worker.dispatchFetch(`http://local.test${path}`, {
        method: 'POST',
        body: 'synthetic data',
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'NOT_FOUND',
        requestId: expect.any(String),
        retryable: false,
      });
    }
  });
  it('does not accept unsupported methods on public read-only routes', async () => {
    const response = await worker.dispatchFetch('http://local.test/health', { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
