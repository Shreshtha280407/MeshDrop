import { describe, expect, it, vi } from 'vitest';
import {
  exerciseProductRollback,
  validateRelease,
  workerDeploymentClient,
} from '../../scripts/deploy/product-rollback';
import type { ActivePair, ReleasePair } from '../../scripts/deploy/product-rollback';

const latest: ReleasePair = {
  origin: 'https://meshdrop-test-preview.pages.dev',
  project: 'meshdrop-test-preview',
  workerName: 'meshdrop-test-preview-signaling',
  workerVersion: '11111111-1111-4111-8111-111111111111',
  pages: {
    id: '22222222-2222-4222-8222-222222222222',
    created_on: '2026-10-21T00:00:00Z',
    environment: 'production',
    project_name: 'meshdrop-test-preview',
    latest_stage: { status: 'success' },
  },
  assets: { module: '/assets/index-new.js', sha256: 'a'.repeat(64) },
};
const previous: ReleasePair = {
  ...latest,
  workerVersion: '33333333-3333-4333-8333-333333333333',
  pages: {
    ...latest.pages,
    id: '44444444-4444-4444-8444-444444444444',
    created_on: '2026-10-20T00:00:00Z',
  },
  assets: { module: '/assets/index-old.js', sha256: 'b'.repeat(64) },
};
function harness() {
  const state: ActivePair = {
    workerVersion: latest.workerVersion,
    pagesDeployment: latest.pages.id,
  };
  const calls: string[] = [];
  return {
    state,
    calls,
    latest,
    previous,
    active: vi.fn(async () => ({ ...state })),
    promoteWorker: vi.fn(async (version: string) => {
      calls.push(`worker:${version}`);
      state.workerVersion = version;
    }),
    promotePages: vi.fn(async (deployment: ReleasePair['pages']) => {
      calls.push(`pages:${deployment.id}`);
      state.pagesDeployment = deployment.id;
    }),
    verify: vi
      .fn<(stage: 'rollback' | 'restored', expected: ReleasePair) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}
describe('coordinated preview product rollback', () => {
  it('strips provider environment values before persisting a release/restore record', () => {
    const candidate = {
      ...previous,
      pages: { ...previous.pages, env_vars: { unexpectedSecret: 'never-store' } },
    };
    expect(validateRelease(candidate)).toEqual(previous);
    expect(JSON.stringify(validateRelease(candidate))).not.toContain('never-store');
  });
  it('verifies both previous components and restores the exact original pair', async () => {
    const h = harness();
    expect(await exerciseProductRollback(h)).toMatchObject({
      pass: true,
      restored: true,
      error: '',
    });
    expect(h.calls).toEqual([
      `worker:${previous.workerVersion}`,
      `pages:${previous.pages.id}`,
      `worker:${latest.workerVersion}`,
      `pages:${latest.pages.id}`,
    ]);
    expect(h.verify.mock.calls).toEqual([
      ['rollback', previous],
      ['restored', latest],
    ]);
    expect(h.state).toEqual({
      workerVersion: latest.workerVersion,
      pagesDeployment: latest.pages.id,
    });
  });
  it('restores the Worker when the first mutation applies but its response is lost', async () => {
    const h = harness(),
      promote = h.promoteWorker.getMockImplementation()!;
    h.promoteWorker.mockImplementationOnce(async (version) => {
      await promote(version);
      throw new Error('lost response');
    });
    expect(await exerciseProductRollback(h)).toMatchObject({ pass: false, restored: true });
    expect(h.promotePages).not.toHaveBeenCalled();
    expect(h.state.workerVersion).toBe(latest.workerVersion);
  });
  it('restores both components after a lost Pages mutation response', async () => {
    const h = harness(),
      promote = h.promotePages.getMockImplementation()!;
    h.promotePages.mockImplementationOnce(async (deployment) => {
      await promote(deployment);
      throw new Error('lost response');
    });
    expect(await exerciseProductRollback(h)).toMatchObject({ pass: false, restored: true });
    expect(h.state).toEqual({
      workerVersion: latest.workerVersion,
      pagesDeployment: latest.pages.id,
    });
  });
  it('restores after an old client, transfer, exported digest or persisted-room check fails', async () => {
    const h = harness();
    h.verify.mockRejectedValueOnce(new Error('file digest mismatch'));
    expect(await exerciseProductRollback(h)).toMatchObject({
      pass: false,
      restored: true,
      error: 'PRODUCT_ROLLBACK_GATE_FAILED',
    });
    expect(h.verify.mock.calls[1]).toEqual(['restored', latest]);
  });
  it('still attempts Pages restoration after a failed Worker restoration', async () => {
    const h = harness(),
      promote = h.promoteWorker.getMockImplementation()!;
    h.promoteWorker.mockImplementation(async (version) => {
      if (version === latest.workerVersion) throw new Error('private provider value');
      await promote(version);
    });
    const report = await exerciseProductRollback(h);
    expect(report).toMatchObject({
      pass: false,
      restored: false,
      error: 'PRODUCT_RESTORATION_REQUIRES_ATTENTION',
    });
    expect(h.state.pagesDeployment).toBe(latest.pages.id);
    expect(JSON.stringify(report)).not.toContain('private provider value');
  });
  it('does not pass when only Worker restoration succeeds', async () => {
    const h = harness(),
      promote = h.promotePages.getMockImplementation()!;
    h.promotePages.mockImplementation(async (deployment) => {
      if (deployment.id === latest.pages.id) throw new Error('failure');
      await promote(deployment);
    });
    expect(await exerciseProductRollback(h)).toMatchObject({ pass: false, restored: false });
    expect(h.state.workerVersion).toBe(latest.workerVersion);
  });
  it('accepts a lost restore response only after reading and verifying the actual original pair', async () => {
    const h = harness(),
      promote = h.promoteWorker.getMockImplementation()!;
    h.promoteWorker.mockImplementation(async (version) => {
      await promote(version);
      if (version === latest.workerVersion) throw new Error('response lost');
    });
    expect(await exerciseProductRollback(h)).toMatchObject({ pass: true, restored: true });
  });
  it('makes no changes after the preflight pair changes', async () => {
    const h = harness();
    h.state.pagesDeployment = previous.pages.id;
    expect((await exerciseProductRollback(h)).pass).toBe(false);
    expect(h.calls).toEqual([]);
  });
  it('refuses to overwrite a concurrent third release during restoration', async () => {
    const h = harness();
    h.verify.mockImplementationOnce(async () => {
      h.state.workerVersion = '55555555-5555-4555-8555-555555555555';
      throw new Error('concurrent deployment');
    });
    expect(await exerciseProductRollback(h)).toMatchObject({
      pass: false,
      restored: false,
      error: 'PRODUCT_RESTORATION_REQUIRES_ATTENTION',
    });
    expect(h.calls).toHaveLength(2);
    expect(h.state.workerVersion).toBe('55555555-5555-4555-8555-555555555555');
  });
  it('refuses foreign, production, invalid-version and unchanged targets before mutation', async () => {
    for (const invalid of [
      { ...previous, project: 'foreign-preview' },
      { ...previous, origin: 'https://meshdrop-test-production.pages.dev' },
      { ...previous, workerVersion: '../unsafe' },
      { ...previous, workerVersion: latest.workerVersion },
      { ...previous, pages: { ...previous.pages, environment: 'preview' } },
    ]) {
      const h = harness();
      await expect(
        exerciseProductRollback({ ...h, previous: invalid as ReleasePair }),
      ).rejects.toThrow();
      expect(h.calls).toEqual([]);
    }
  });
});
describe('Worker deployment provider boundary', () => {
  it('requires one 100-percent active version', async () => {
    for (const versions of [
      [],
      [{ version_id: latest.workerVersion, percentage: 50 }],
      [{ version_id: 'bad', percentage: 100 }],
    ]) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ success: true, result: { deployments: [{ versions }] } }),
        );
      await expect(
        workerDeploymentClient(
          'a'.repeat(32),
          latest.workerName,
          'private-token',
          transport,
        ).active(),
      ).rejects.toThrow('PRODUCT_SINGLE_ACTIVE_WORKER_REQUIRED');
    }
  });
  it('uses the fixed endpoint, denies redirects and does not return provider extras', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            deployments: [
              {
                versions: [{ version_id: latest.workerVersion, percentage: 100 }],
                secrets: 'do-not-record',
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));
    const client = workerDeploymentClient(
      'a'.repeat(32),
      latest.workerName,
      'private-token',
      transport,
    );
    expect(await client.active()).toBe(latest.workerVersion);
    await client.promote(previous.workerVersion);
    expect(transport.mock.calls[1]![0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/workers/scripts/${latest.workerName}/deployments`,
    );
    expect(transport.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });
  it('never exposes denied provider response details or accepts an unsafe version path', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: false, errors: ['private-token'] }, { status: 403 }),
      );
    const client = workerDeploymentClient(
      'a'.repeat(32),
      latest.workerName,
      'private-token',
      transport,
    );
    await expect(client.active()).rejects.toThrow('PRODUCT_PROVIDER_OPERATION_FAILED');
    await expect(client.promote('../unsafe')).rejects.toThrow('PRODUCT_INVALID_WORKER_VERSION');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('confirms only explicitly reviewed provider-secret changes after a 10220 denial', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            errors: [
              {
                code: 10220,
                message:
                  'The following secrets have changed: METERED_SECRET_KEY, CLOUDFLARE_ANALYTICS_API_TOKEN',
              },
            ],
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: {} }));
    const client = workerDeploymentClient(
      'a'.repeat(32),
      'meshdrop-test-signaling',
      'private-token',
      transport,
      { allowedSecretChanges: ['METERED_SECRET_KEY', 'CLOUDFLARE_ANALYTICS_API_TOKEN'] },
    );
    await client.promote(previous.workerVersion);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![0]).toMatch(/deployments\?force=true$/);
  });
  it.each([{ allowedSecretChanges: [] }, { allowedSecretChanges: ['METERED_SECRET_KEY'] }])(
    'refuses unreviewed secret changes with allowlist %j',
    async ({ allowedSecretChanges }) => {
      const transport = vi.fn().mockResolvedValue(
        Response.json(
          {
            success: false,
            errors: [
              { code: 10220, message: 'The following secrets have changed: OPS_REVOKE_SECRET' },
            ],
          },
          { status: 400 },
        ),
      );
      const client = workerDeploymentClient(
        'a'.repeat(32),
        'meshdrop-test-signaling',
        'private-token',
        transport,
        { allowedSecretChanges },
      );
      await expect(client.promote(previous.workerVersion)).rejects.toThrow(
        'PRODUCT_PROVIDER_OPERATION_FAILED',
      );
      expect(transport).toHaveBeenCalledTimes(1);
      expect(() =>
        workerDeploymentClient(
          'a'.repeat(32),
          'meshdrop-test-signaling',
          'private-token',
          transport,
          { allowedSecretChanges: ['OPS_REVOKE_SECRET'] },
        ),
      ).toThrow('PRODUCT_UNSAFE_SECRET_ROLLBACK_CONFIRMATION');
    },
  );
});
