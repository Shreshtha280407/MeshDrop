import { readFile } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  configured,
  isolation,
  runtime,
  manifestGate,
  verifyProductionEnvironmentPin,
} from '../../scripts/preview/contract';
import { PreviewReadback } from '../../scripts/preview/provider';
import { runCanary, validateCanary, pausedProbe } from '../../scripts/preview/canary';
import { previewRollbackEligibility } from '../../scripts/preview/rollback';
import { task10dWaiver } from '../../scripts/preview/waiver';
import { recheckApproval, parseApprovalClaim } from '../../scripts/deploy/release-approval';
import { hostedProvider } from '../../scripts/deploy/release-lifecycle';
import type { Manifest } from '../../scripts/deploy/release-record';
import { requireAccepted, sealManifest } from '../../scripts/deploy/release-record';
import { previewFixture } from '../fixtures/preview-canary';
import {
  fixtureTransport,
  readOnlyResponses,
  FIXTURE_TOKEN,
} from '../fixtures/cloudflare-readonly';
import { NOW } from '../fixtures/release-record';

function remake(m: Manifest, changes: Partial<Manifest>) {
  const value = { ...m, ...changes };
  const { id, ...body } = value;
  void id;
  return sealManifest(body);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('explicit preview isolation before network access', () => {
  it('accepts distinct account, project, Worker, origin and all three SQLite actors', () => {
    expect(previewFixture().pins.target.environment).toBe('preview');
  });
  it.each([
    'accountId',
    'worker',
    'project',
    'projectId',
    'origin',
    'githubEnvironmentId',
  ] as const)('rejects production %s equality', (key) => {
    const f = previewFixture();
    f.pins.target[key] = f.pins.deny[key];
    expect(() => isolation(f.pins.target, f.pins.deny)).toThrow('PRODUCTION_RESOURCE_OVERLAP');
  });
  it.each(['environment', 'admissionPaused', 'turnProvider'] as const)(
    'rejects unsafe %s',
    (key) => {
      const f = previewFixture();
      Object.assign(f.pins.target, {
        [key]: key === 'environment' ? 'production' : key === 'admissionPaused' ? false : 'coturn',
      });
      expect(() => new PreviewReadback(f.pins, FIXTURE_TOKEN)).toThrow(
        'PREVIEW_ONLY_PAUSED_DIRECT_REQUIRED',
      );
    },
  );
  it.each(['SESSION_ROOMS', 'RELAY_POOLS', 'OPERATIONS_MONITOR'] as const)(
    'rejects production namespace %s',
    (key) => {
      const f = previewFixture();
      f.pins.target.durableObjects[key].namespaceId = f.pins.deny.durableObjectNamespaces[0]!;
      expect(() => isolation(f.pins.target, f.pins.deny)).toThrow(
        'PREVIEW_NAMESPACE_ISOLATION_REQUIRED',
      );
    },
  );
  it.each(['durableObjects', 'accountId', 'origin', 'githubEnvironmentId', 'migrationTag'])(
    'rejects missing pin %s',
    (key) => {
      const f = previewFixture();
      const t: Record<string, unknown> = { ...f.pins.target };
      delete t[key];
      expect(() => isolation(t, f.pins.deny)).toThrow();
    },
  );
  it('accepts an explicitly absent production GitHub environment only when GitHub confirms absence', () => {
    const f = previewFixture();
    f.pins.deny.githubEnvironmentId = null;
    const pins = isolation(f.pins.target, f.pins.deny);
    expect(() =>
      verifyProductionEnvironmentPin(pins.deny, {
        environments: [{ id: 555, name: 'preview-canary' }],
      }),
    ).not.toThrow();
    expect(() =>
      verifyProductionEnvironmentPin(pins.deny, {
        environments: [
          { id: 555, name: 'preview-canary' },
          { id: 999, name: 'production' },
        ],
      }),
    ).toThrow('PRODUCTION_ENVIRONMENT_DENY_STATE_CHANGED');
  });
  it('requires the exact reviewed production GitHub environment ID when one exists', () => {
    const f = previewFixture();
    expect(() =>
      verifyProductionEnvironmentPin(f.pins.deny, {
        environments: [
          { id: 555, name: 'preview-canary' },
          { id: 999, name: 'production' },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      verifyProductionEnvironmentPin(f.pins.deny, {
        environments: [
          { id: 555, name: 'preview-canary' },
          { id: 998, name: 'production' },
        ],
      }),
    ).toThrow('PRODUCTION_ENVIRONMENT_DENY_STATE_CHANGED');
  });
  it('does not invent missing provider configuration', () =>
    expect(() => configured({})).toThrow('PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED'));
  it('rejects extra credentials in target metadata', () => {
    const f = previewFixture();
    expect(() => isolation({ ...f.pins.target, token: 'private-fixture' }, f.pins.deny)).toThrow();
  });
  it('rejects custom domains and unreviewed migration target', () => {
    const f = previewFixture();
    expect(() =>
      isolation({ ...f.pins.target, origin: 'https://other.invalid' }, f.pins.deny),
    ).toThrow('PREVIEW_TARGET_IDENTITY_MISMATCH');
    expect(() => isolation({ ...f.pins.target, migrationTag: 'v3' }, f.pins.deny)).toThrow(
      'PREVIEW_TARGET_IDENTITY_MISMATCH',
    );
  });
});
describe('exact runtime and frozen artifact identity', () => {
  it('binds the expected source, repository, ref, workflow, run and hosted runner', () =>
    expect(runtime(previewFixture().env).runId).toBe('333'));
  it.each([
    'GITHUB_SHA',
    'GITHUB_WORKFLOW_SHA',
    'GITHUB_REF',
    'GITHUB_WORKFLOW_REF',
    'GITHUB_REPOSITORY_ID',
    'GITHUB_REPOSITORY_OWNER_ID',
    'RUNNER_ENVIRONMENT',
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_EVENT_NAME',
  ])('rejects substituted %s', (key) => {
    const f = previewFixture();
    expect(() => runtime({ ...f.env, [key]: 'substituted' })).toThrow();
  });
  it.each([
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'TURN_SHARED_SECRET',
    'ADMISSION_PAUSED',
    'OPS_REVOKE_SECRET',
  ])('rejects inherited %s', (key) =>
    expect(() => runtime({ ...previewFixture().env, [key]: 'private-canary' })).toThrow(
      'UNEXPECTED_PROVIDER_CREDENTIAL_OR_ADMISSION_CONTROL',
    ),
  );
  it('accepts only exact manifest/source/configuration and paused preview scope', () => {
    const f = previewFixture();
    expect(
      manifestGate(
        f.manifest,
        f.pins,
        f.manifest.sourceCommit,
        f.manifest.id,
        f.config.worker,
        f.config.pages,
      ).id,
    ).toBe(f.manifest.id);
  });
  it.each(['source', 'digest', 'scope', 'admission', 'configuration'])(
    'rejects mismatched %s',
    (kind) => {
      const f = previewFixture();
      let m = f.manifest;
      if (kind === 'scope')
        m = remake(m, {
          environment: 'production',
          project: 'fixture-production',
          worker: 'fixture-production-signaling',
        });
      if (kind === 'admission') m = remake(m, { admissionPaused: false });
      const worker = structuredClone(f.config.worker);
      if (kind === 'configuration') worker.workers_dev = true;
      expect(() =>
        manifestGate(
          m,
          f.pins,
          kind === 'source' ? 'b'.repeat(40) : f.manifest.sourceCommit,
          kind === 'digest' ? '0'.repeat(64) : m.id,
          worker,
          f.config.pages,
        ),
      ).toThrow();
    },
  );
  it('fails a hosted-context CLI before any provider read when configuration is missing', () => {
    const f = previewFixture();
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/preview/cli.ts', 'inspect'],
      {
        env: { PATH: process.env.PATH!, TSX_DISABLE_CACHE: '1', ...f.env },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe('PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED');
  });
});
describe('waiver grants no production admission', () => {
  it('preserves the failed hosted run and explicit human roadmap decision', async () => {
    const record = JSON.parse(await readFile('docs/decisions/task-10d-waiver.json', 'utf8'));
    expect(task10dWaiver(record)).toMatchObject({
      task: '10D',
      decision: 'SKIPPED',
      runId: '42402338554',
      failure: 'REHEARSAL_ENVIRONMENT_PROTECTION_UNVERIFIED',
      productionApproved: false,
    });
  });
  it('is rejected by real approval parsing, one-time admission and accepted-release checks', async () => {
    const waiver = task10dWaiver();
    expect(() => parseApprovalClaim(waiver)).toThrow();
    await expect(recheckApproval(waiver as never, true)).rejects.toThrow(
      'UNTRUSTED_OR_MODIFIED_APPROVAL_CHECK',
    );
    expect(() => requireAccepted(previewFixture().manifest, waiver as never)).toThrow();
    expect(hostedProvider).toThrow('HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED');
  });
  it.each([
    'hostedTrustVerified',
    'humanAuthorizationVerified',
    'independentWitnessVerified',
    'productionApproved',
    'acceptanceEnabled',
  ])('rejects promotion of waiver field %s', (key) =>
    expect(() => task10dWaiver({ ...task10dWaiver(), [key]: true })).toThrow(),
  );
});
describe('scoped preview readback fixtures never become hosted proof', () => {
  function setup() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const f = previewFixture(),
      r = readOnlyResponses(f.e);
    const data = {
      ...r,
      version: {
        ...r.version,
        annotations: { 'workers/message': f.manifest.id },
        resources: {
          ...r.version.resources,
          bindings: [
            ...r.version.resources.bindings.filter((b) => b.type === 'durable_object_namespace'),
            ...Object.entries(f.config.worker.vars).map(([name, text]) => ({
              type: 'plain_text',
              name,
              text,
            })),
            { type: 'secret_text', name: 'OPS_REVOKE_SECRET', text: FIXTURE_TOKEN },
          ],
        },
      },
      project: {
        ...r.project,
        canonical_deployment: { ...r.project.canonical_deployment, created_on: NOW },
        production_branch: 'release',
        domains: [f.e.pagesSubdomain],
      },
    };
    const fixture = fixtureTransport(data, f.e);
    return {
      ...f,
      data,
      ...fixture,
      provider: new PreviewReadback(f.pins, FIXTURE_TOKEN, fixture.transport),
    };
  }
  it('checks provider identity but retains fixture scope, false authority and no secret output', async () => {
    const f = setup();
    const value = await f.provider.observe(f.manifest);
    expect(value.observation.scope).toBe('offline-fixture');
    expect(value.observation.providerConfirmed).toBe(false);
    expect(JSON.stringify(value)).not.toContain(FIXTURE_TOKEN);
    expect(f.calls.every((c) => c.init.method === 'GET')).toBe(true);
  });
  it.each(['project', 'namespace', 'admission', 'turn', 'secret', 'manifest', 'source', 'binding'])(
    'rejects invalid %s readback',
    async (kind) => {
      const f = setup();
      if (kind === 'project') f.data.project.id = 'foreign';
      if (kind === 'namespace')
        (
          f.data.version.resources.bindings.find((b) => b.name === 'SESSION_ROOMS')! as Record<
            string,
            unknown
          >
        ).namespace_id = 'a'.repeat(32);
      if (kind === 'admission')
        (
          f.data.version.resources.bindings.find((b) => b.name === 'ADMISSION_PAUSED')! as Record<
            string,
            unknown
          >
        ).text = 'false';
      if (kind === 'turn')
        (
          f.data.version.resources.bindings.find((b) => b.name === 'TURN_PROVIDER')! as Record<
            string,
            unknown
          >
        ).text = 'coturn';
      if (kind === 'secret')
        f.data.version.resources.bindings.push({
          name: 'TURN_SHARED_SECRET',
          type: 'secret_text',
          text: FIXTURE_TOKEN,
        });
      if (kind === 'manifest') f.data.version.annotations['workers/message'] = '0'.repeat(64);
      if (kind === 'source')
        f.data.deployment.deployment_trigger.metadata.commit_hash = '0'.repeat(40);
      if (kind === 'binding')
        f.data.version.resources.bindings.push({
          type: 'plain_text',
          name: 'OPS_ALERT_WEBHOOK_URL',
          text: 'https://untrusted.invalid',
        });
      await expect(f.provider.observe(f.manifest)).rejects.toThrow();
    },
  );
  it('never follows redirects or interprets an API failure as successful readback', async () => {
    const f = previewFixture();
    await expect(
      new PreviewReadback(
        f.pins,
        FIXTURE_TOKEN,
        async () =>
          new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid' } }),
      ).observe(),
    ).rejects.toThrow('PREVIEW_PROVIDER_READ_FAILED');
  });
});
describe('honest canary and rollback evidence', () => {
  it('records every first attempt without retrying or promoting fixture evidence', async () => {
    const f = previewFixture();
    let count = 0;
    const report = await runCanary(f.pins, async () => {
      if (++count === 7) throw new Error('private-canary');
    });
    expect(count).toBe(50);
    expect(report.firstAttemptSuccessCount).toBe(49);
    expect(report.failureCount).toBe(1);
    expect(report.retries).toBe(0);
    expect(JSON.stringify(report)).not.toContain('private-canary');
    expect(() => validateCanary(report)).toThrow();
  });
  it('rejects even 50/50 forged hosted labels and false production approval', async () => {
    const f = previewFixture(),
      r = await runCanary(f.pins, async () => {});
    expect(r.firstAttemptSuccessCount).toBe(50);
    expect(() => validateCanary({ ...r, scope: 'hosted-preview' })).toThrow();
    expect(() => validateCanary({ ...r, productionApproved: true } as never)).toThrow();
  });
  it('rejects a redirect in a public smoke before making a second request', async () => {
    const t = vi.fn<typeof fetch>(async () => new Response(null, { status: 302 }));
    await expect(pausedProbe(previewFixture().pins, t)).rejects.toThrow();
    expect(t).toHaveBeenCalledTimes(1);
  });
  it('rejects a production rollback candidate before compiling source', async () => {
    const f = previewFixture();
    await expect(
      previewRollbackEligibility(
        f.pins,
        f.manifest,
        remake(f.manifest, {
          environment: 'production',
          project: 'fixture-production',
          worker: 'fixture-production-signaling',
        }),
      ),
    ).rejects.toThrow('PREVIEW_ROLLBACK_SCOPE_MISMATCH');
  });
  it('rejects the actual historical P8 actor baseline rather than substituting it', async () => {
    const f = previewFixture();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const current = remake(f.manifest, { sourceCommit: sha });
    await expect(
      previewRollbackEligibility(
        f.pins,
        current,
        remake(current, { sourceCommit: 'e108e7a1f59bc37f41ba703240e08f176d47b33c' }),
      ),
    ).rejects.toThrow('PREVIEW_ROLLBACK_INCOMPATIBLE');
  });
  it.each(['protocolVersion', 'configurationSha256', 'migrationsSha256'] as const)(
    'rejects incompatible rollback %s',
    async (key) => {
      const f = previewFixture();
      const target = remake(f.manifest, { [key]: key === 'protocolVersion' ? 2 : '0'.repeat(64) });
      await expect(previewRollbackEligibility(f.pins, f.manifest, target)).rejects.toThrow(
        'PREVIEW_ROLLBACK_INCOMPATIBLE',
      );
    },
  );
  it('permits content comparison of identical current source without claiming provider or rollback proof', async () => {
    const f = previewFixture(),
      sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const current = remake(f.manifest, { sourceCommit: sha }),
      previous = remake(current, { preparedAt: '2026-11-04T00:00:00.000Z' });
    expect(await previewRollbackEligibility(f.pins, current, previous)).toMatchObject({
      contentCompatible: true,
      providerIdentitiesVerified: false,
      drillPerformed: false,
      productionApproved: false,
    });
  });
});
