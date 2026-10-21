import { describe, expect, it, vi } from 'vitest';
import {
  exercisePagesRollback,
  pagesClient,
  previousDeployment,
} from '../../scripts/deploy/pages-rollback';
import type { PagesDeployment } from '../../scripts/deploy/pages-rollback';

const latest: PagesDeployment = {
  id: '11111111-1111-4111-8111-111111111111',
  created_on: '2026-10-19T00:00:00Z',
  project_name: 'meshdrop-test-preview',
  environment: 'production',
  latest_stage: { status: 'success' },
};
const previous: PagesDeployment = {
  ...latest,
  id: '22222222-2222-4222-8222-222222222222',
  created_on: '2026-10-18T00:00:00Z',
};
function harness() {
  let current = latest;
  return {
    latest,
    previous,
    active: vi.fn(async () => current),
    promote: vi.fn(async (target: PagesDeployment) => {
      current = target;
    }),
    verify: vi.fn<(stage: 'rollback' | 'restored') => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('P9 preview Pages rollback recovery', () => {
  it('selects the closest older successful production build of the same project', () => {
    const older = { ...previous, created_on: '2026-10-17T00:00:00Z' };
    expect(
      previousDeployment(latest, [
        older,
        { ...previous, environment: 'preview' },
        { ...previous, latest_stage: { status: 'failure' } },
        { ...previous, project_name: 'foreign-production' },
        { ...previous, created_on: '2026-10-20T00:00:00Z' },
        { ...previous, id: '../unsafe' },
        previous,
        latest,
      ]),
    ).toEqual(previous);
    expect(() =>
      previousDeployment(latest, [latest, older, { ...previous, created_on: 'bad' }]),
    ).not.toThrow();
    expect(() =>
      previousDeployment(latest, [latest, { ...previous, environment: 'preview' }]),
    ).toThrow('PAGES_PREVIOUS_PRODUCTION_REQUIRED');
  });
  it('verifies the rollback and restores the exact original deployment', async () => {
    const options = harness();
    const report = await exercisePagesRollback(options);
    expect(report).toMatchObject({ pass: true, restored: true, error: '' });
    expect(options.promote.mock.calls.map(([target]) => target.id)).toEqual([
      previous.id,
      latest.id,
    ]);
    expect(options.verify.mock.calls).toEqual([['rollback'], ['restored']]);
    expect((await options.active()).id).toBe(latest.id);
  });
  it('restores after the rollback applied but its response was lost', async () => {
    const options = harness();
    const promote = options.promote.getMockImplementation()!;
    options.promote.mockImplementationOnce(async (target) => {
      await promote(target);
      throw new Error('network response lost');
    });
    const report = await exercisePagesRollback(options);
    expect(report).toMatchObject({
      pass: false,
      restored: true,
      error: 'PAGES_ROLLBACK_GATE_FAILED',
    });
    expect((await options.active()).id).toBe(latest.id);
  });
  it('restores after a broken gateway or wrong asset fingerprint', async () => {
    const options = harness();
    options.verify.mockRejectedValueOnce(new Error('client or gateway failed'));
    const report = await exercisePagesRollback(options);
    expect(report.pass).toBe(false);
    expect(report.restored).toBe(true);
    expect(options.verify.mock.calls).toEqual([['rollback'], ['restored']]);
  });
  it('reports failed restoration and never reports a successful gate', async () => {
    const options = harness();
    const promote = options.promote.getMockImplementation()!;
    options.promote.mockImplementation(async (target) => {
      if (target.id === latest.id) throw new Error('provider-secret-in-error');
      await promote(target);
    });
    const report = await exercisePagesRollback(options);
    expect(report).toMatchObject({
      pass: false,
      restored: false,
      error: 'PAGES_RESTORATION_REQUIRES_ATTENTION',
    });
    expect(JSON.stringify(report)).not.toContain('provider-secret');
  });
  it('makes no mutation if the active deployment changed after preflight', async () => {
    const options = harness();
    options.active.mockResolvedValueOnce(previous);
    expect((await exercisePagesRollback(options)).pass).toBe(false);
    expect(options.promote).not.toHaveBeenCalled();
  });
  it('does not overwrite a concurrent release during restoration', async () => {
    const options = harness();
    const other = { ...latest, id: '33333333-3333-4333-8333-333333333333' };
    options.active
      .mockResolvedValueOnce(latest)
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(other);
    const report = await exercisePagesRollback(options);
    expect(report.error).toBe('PAGES_RESTORATION_REQUIRES_ATTENTION');
    expect(options.promote).toHaveBeenCalledTimes(1);
  });
  it('fails before mutation when no safe previous target exists', async () => {
    const options = { ...harness(), previous: latest };
    await expect(exercisePagesRollback(options)).rejects.toThrow(
      'PAGES_PREVIOUS_PRODUCTION_REQUIRED',
    );
    expect(options.promote).not.toHaveBeenCalled();
  });
});

describe('Pages provider boundary', () => {
  it('uses only the fixed account endpoint, refuses redirects and strips provider extras', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { canonical_deployment: { ...latest, env_vars: { secret: 'do-not-record' } } },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: previous }));
    const client = pagesClient('a'.repeat(32), latest.project_name, 'private-token', transport);
    expect(await client.active()).toEqual(latest);
    await client.promote(previous);
    expect(transport.mock.calls[1]![0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/pages/projects/${latest.project_name}/deployments/${previous.id}/rollback`,
    );
    expect(transport.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });
  it('rejects preview, foreign and failed targets before sending a request', async () => {
    const transport = vi.fn<typeof fetch>();
    const client = pagesClient('a'.repeat(32), latest.project_name, 'private-token', transport);
    await expect(
      client.promote({ ...previous, project_name: 'foreign-project' }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not leak provider errors or trust a denied response body', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          success: false,
          errors: [{ message: 'private-token' }],
          result: { canonical_deployment: latest },
        },
        { status: 403 },
      ),
    );
    const client = pagesClient('a'.repeat(32), latest.project_name, 'private-token', transport);
    await expect(client.active()).rejects.toThrow('PAGES_PROVIDER_OPERATION_FAILED');
  });
});
