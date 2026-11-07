import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { workflowObject } from '../fixtures/rehearsal-workflow';

type Map = Record<string, unknown>;
function enforce(w: Map) {
  const on = w.on as Map;
  assert.deepEqual(Object.keys(on), ['workflow_dispatch']);
  const inputs = (on.workflow_dispatch as Map).inputs as Map;
  assert.deepEqual((inputs.environment as Map).options, ['preview']);
  assert.equal((inputs.expected_ref as Map).default, 'refs/heads/main');
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.concurrency, {
    group: 'meshdrop-isolated-preview-canary',
    'cancel-in-progress': false,
  });
  const jobs = w.jobs as Record<string, Map>;
  assert.deepEqual(Object.keys(jobs).sort(), ['candidate', 'inspect']);
  assert.equal(jobs.inspect!.if, "${{ inputs.environment == 'preview' }}");
  assert.equal(jobs.inspect!.environment, undefined);
  assert.deepEqual(jobs.candidate!.environment, {
    name: '${{ needs.inspect.outputs.environment-name }}',
  });
  assert.equal(jobs.candidate!.needs, 'inspect');
  const pins: Record<string, string> = {
    'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
    'pnpm/action-setup': 'b906affcce14559ad1aafd4ab0e942779e9f58b1',
    'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  };
  const commands = new Set([
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm preview:canary inspect',
    'pnpm preview:canary prepare',
    'pnpm exec playwright install --with-deps chromium',
    'pnpm preview:canary dry-run "$PACKAGE_DIRECTORY"',
    'pnpm preview:canary publish "$PACKAGE_DIRECTORY"',
  ]);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-26.04');
    assert.equal(job['timeout-minutes'], name === 'inspect' ? 5 : 25);
    assert.deepEqual(
      job.permissions,
      name === 'inspect' ? { contents: 'read', actions: 'read' } : { contents: 'read' },
    );
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps as Map[]) {
      assert.equal(step['continue-on-error'], undefined);
      if (step.run) assert(commands.has(String(step.run)));
      if (step.uses) {
        const [action, pin] = String(step.uses).split('@');
        assert.equal(pin, pins[action!]);
      }
      if (String(step.uses).startsWith('actions/upload-artifact')) {
        const v = step.with as Map;
        assert.equal(v.overwrite, false);
        assert.equal(v['if-no-files-found'], 'error');
        assert.deepEqual(
          String(v.path).trim().split(/\s+/).sort(),
          [
            'package.tar',
            'manifest.json',
            'preparation.json',
            'publication.json',
            'canary.json',
            'browser.json',
            'rollback.json',
            'coverage.json',
          ]
            .map((x) => '.meshdrop-artifacts/preview-canary/public/' + x)
            .sort(),
        );
      }
    }
  }
  const text = JSON.stringify(w);
  assert.equal((text.match(/secrets\./g) ?? []).length, 1);
  const publisher = (jobs.candidate!.steps as Map[]).find((s) =>
    String(s.run).includes('canary publish'),
  )!;
  assert.equal(
    (publisher.env as Map).PREVIEW_CANARY_API_TOKEN,
    '${{ secrets.PREVIEW_CANARY_API_TOKEN }}',
  );
  assert(
    !/CLOUDFLARE_API_TOKEN|TURN_SHARED_SECRET|OPS_REVOKE_SECRET|deploy:cloud|deploy\.yml|secrets\.[A-Z_]*PROD/i.test(
      text,
    ),
  );
}
describe('isolated preview workflow', () => {
  async function workflow() {
    return workflowObject(await readFile('.github/workflows/preview-canary.yml', 'utf8'));
  }
  it('is manual, pinned, preview-only, step-secret-scoped and evidence-whitelisted', async () =>
    enforce(await workflow()));
  it.each([
    'production',
    'push',
    'pull-request',
    'environment',
    'secret',
    'deploy',
    'artifact',
    'action',
    'concurrency',
    'permissions',
  ])('rejects unsafe %s change', async (kind) => {
    const w = await workflow(),
      jobs = w.jobs as Record<string, Map>,
      steps = jobs.candidate!.steps as Map[];
    if (kind === 'production')
      ((((w.on as Map).workflow_dispatch as Map).inputs as Map).environment as Map).options = [
        'preview',
        'production',
      ];
    if (kind === 'push') w.on = { push: null };
    if (kind === 'pull-request') w.on = { pull_request: null };
    if (kind === 'environment') jobs.candidate!.environment = { name: 'production' };
    if (kind === 'secret') jobs.candidate!.env = { TOKEN: '${{ secrets.PRODUCTION_API_TOKEN }}' };
    if (kind === 'deploy') steps.push({ run: 'pnpm deploy:cloud publish production' });
    if (kind === 'artifact')
      (steps.find((s) => String(s.uses).startsWith('actions/upload-artifact'))!.with as Map).path =
        '**/.env';
    if (kind === 'action') steps[0]!.uses = 'actions/checkout@main';
    if (kind === 'concurrency') w.concurrency = { 'cancel-in-progress': true };
    if (kind === 'permissions')
      jobs.candidate!.permissions = { contents: 'write', deployments: 'write' };
    expect(() => enforce(w)).toThrow();
  });
  it('does not call existing mutation entry points or read private environment files', async () => {
    const source = await readFile('scripts/preview/cli.ts', 'utf8');
    expect(source).not.toMatch(
      /from ['"].*\/(?:auth|cloudflare|operations|pages-rollback|product-rollback)['"]|parseEnv|readFile\([^\n]*\.env/,
    );
    expect(source).toMatch(/new PreviewReadback/);
    const compact = source.replace(/\s+/g, '').split('asyncfunctionpublish()')[1]!;
    const before = compact.indexOf('constbefore=awaitprovider.observe()');
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(compact.indexOf("awaitcli(['deploy','--config'"));
  });
});
