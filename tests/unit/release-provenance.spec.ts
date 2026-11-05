import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptRelease,
  canonical,
  initialRecord,
  parseManifest,
  parseRecord,
  requireAccepted,
  sealManifest,
} from '../../scripts/deploy/release-record';
import type { Manifest, ReleaseRecord } from '../../scripts/deploy/release-record';
import {
  admissionIntent,
  explicitPause,
  hostedProvider,
  ReleaseJournal,
  verifyAdmission,
  writeBlockedPublication,
} from '../../scripts/deploy/release-lifecycle';
import {
  acceptedFixture,
  decisionFixture,
  identityFixture,
  manifestFixture,
  NEW_PAGES,
  NEW_WORKER,
  NOW,
  OLD_PAGES,
  OLD_WORKER,
  providerFixture,
  publishedFixture,
} from '../fixtures/release-record';
import { writeWorkflowEnvironment } from '../../scripts/deploy/workflow-environment';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meshdrop-provenance-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const now = () => new Date(NOW);

describe('canonical prepared identity and trust boundaries', () => {
  it('rejects publication or partial acceptance claims in earlier lifecycle states', () => {
    const manifest = manifestFixture();
    const published = publishedFixture(manifest);
    expect(() =>
      parseRecord({ ...initialRecord(manifest), provider: published.provider }, manifest),
    ).toThrow('PREPARED_RELEASE_CANNOT_CLAIM_PUBLICATION');
    expect(() => parseRecord({ ...published, acceptance: decisionFixture() }, manifest)).toThrow(
      'PUBLISHED_RELEASE_NOT_ACCEPTED',
    );
    expect(() => parseRecord({ ...published, failure: 'READINESS_FAILED' }, manifest)).toThrow(
      'PUBLISHED_RELEASE_NOT_ACCEPTED',
    );
  });
  it('is deterministic for identical inputs regardless of object insertion order', () => {
    const manifest = manifestFixture();
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    expect(canonical(reversed)).toBe(canonical(manifest));
    expect(parseManifest(reversed).id).toBe(manifest.id);
  });
  it('starts prepared without provider identities or acceptance', () => {
    expect(initialRecord(manifestFixture())).toMatchObject({
      state: 'PREPARED',
      scope: 'unverified',
      provider: { workerVersion: null, pagesDeployment: null, confirmed: false, observation: null },
      acceptance: null,
    });
  });
  it.each([
    'sourceCommit',
    'sourceTreeSha256',
    'configurationSha256',
    'migrationsSha256',
    'gatewaySha256',
    'protocolVersion',
  ])('rejects changed %s identity', (key) => {
    expect(() =>
      parseManifest({
        ...manifestFixture(),
        [key]: key === 'protocolVersion' ? 2 : '0'.repeat(key === 'sourceCommit' ? 40 : 64),
      }),
    ).toThrow();
  });
  it.each(['repository', 'accountId', 'environment', 'project', 'worker', 'origin'])(
    'rejects invalid release scope %s',
    (key) => {
      const payload: Record<string, unknown> = { ...manifestFixture() };
      delete payload.id;
      expect(() =>
        sealManifest({ ...payload, [key]: 'invalid' } as Omit<Manifest, 'id'>),
      ).toThrow();
    },
  );
  it.each(['OPS_REVOKE_SECRET', 'Authorization', 'inviteCapability', 'CLOUDFLARE_API_TOKEN'])(
    'rejects extra secret-bearing field %s',
    (name) => {
      expect(() => parseManifest({ ...manifestFixture(), [name]: 'private-canary' })).toThrow(
        'UNEXPECTED_RECORD_FIELDS',
      );
      expect(canonical(initialRecord(manifestFixture()))).not.toContain('private-canary');
    },
  );
  it.each(['workerVersion', 'pagesDeployment'])('rejects a published state missing %s', (field) => {
    const manifest = manifestFixture(),
      record = publishedFixture(manifest);
    expect(() =>
      parseRecord({ ...record, provider: { ...record.provider, [field]: null } }, manifest),
    ).toThrow();
  });
  it('rejects fake UUIDs and contradictory provider confirmation', () => {
    const manifest = manifestFixture(),
      record = publishedFixture(manifest);
    expect(() =>
      parseRecord(
        { ...record, provider: { ...record.provider, workerVersion: 'not-a-provider-id' } },
        manifest,
      ),
    ).toThrow();
    expect(() =>
      parseRecord({ ...record, provider: { ...record.provider, confirmed: true } }, manifest),
    ).toThrow('INVALID_PROVENANCE_CLAIM');
  });
  it('does not automatically accept publication or authenticate a fixture acceptance', () => {
    const manifest = manifestFixture(),
      record = publishedFixture(manifest);
    expect(record.acceptance).toBeNull();
    expect(() => requireAccepted(manifest, acceptedFixture(manifest))).toThrow(
      'UNVERIFIED_RELEASE_PROVENANCE',
    );
  });
  it.each(['PREPARED', 'INCOMPLETE', 'REJECTED', 'ACCEPTED'])(
    'rejects acceptance from state %s',
    (state) => {
      const manifest = manifestFixture(),
        record = publishedFixture(manifest);
      expect(() =>
        acceptRelease(
          manifest,
          { ...record, state: state as ReleaseRecord['state'] },
          decisionFixture(),
          { manifestId: manifest.id, workerVersion: OLD_WORKER, pagesDeployment: OLD_PAGES },
        ),
      ).toThrow();
    },
  );
  it('requires all acceptance evidence and exact confirmed component identities', () => {
    const manifest = manifestFixture(),
      record = publishedFixture(manifest);
    expect(() =>
      acceptRelease(
        manifest,
        record,
        {
          ...decisionFixture(),
          evidence: {} as NonNullable<ReleaseRecord['acceptance']>['evidence'],
        },
        { manifestId: manifest.id, workerVersion: OLD_WORKER, pagesDeployment: OLD_PAGES },
      ),
    ).toThrow();
    expect(() =>
      acceptRelease(manifest, record, decisionFixture(), {
        manifestId: manifest.id,
        workerVersion: NEW_WORKER,
        pagesDeployment: OLD_PAGES,
      }),
    ).toThrow('ACCEPTANCE_IDENTITY_MISMATCH');
  });
});

describe('admission state and explicit reopening', () => {
  it('writes the explicitly paused workflow state and cannot overwrite an existing private file', async () => {
    const created = vi.fn(async () => {});
    const values = {
      ADMISSION_PAUSED: 'true',
      ADMISSION_ACTION: 'preserve',
      OPS_REVOKE_SECRET: 'synthetic-private-operator',
    };
    await writeWorkflowEnvironment(directory, 'preview', values, created);
    const file = join(directory, 'infrastructure/cloudflare/preview/.env');
    const content = await readFile(file, 'utf8');
    expect(content).toContain('ADMISSION_PAUSED="true"');
    expect(created).toHaveBeenCalledTimes(1);
    await expect(
      writeWorkflowEnvironment(
        directory,
        'preview',
        { ...values, ADMISSION_PAUSED: 'false' },
        created,
      ),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(content);
  });
  it('cleans up only its own newly created environment file if ownership reporting fails', async () => {
    await expect(
      writeWorkflowEnvironment(
        directory,
        'production',
        { ADMISSION_PAUSED: 'true', ADMISSION_ACTION: 'pause' },
        async () => {
          throw new Error('output failure');
        },
      ),
    ).rejects.toThrow('output failure');
    expect(await readdir(join(directory, 'infrastructure/cloudflare/production'))).toEqual([]);
  });
  it('does not infer an open workflow state from missing variables', async () => {
    await expect(
      writeWorkflowEnvironment(directory, 'preview', {}, async () => {}),
    ).rejects.toThrow('EXPLICIT_ADMISSION_STATE_REQUIRED');
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([undefined, '', 'TRUE', '0', 'yes'])('rejects ambiguous desired state %s', (value) => {
    expect(() => explicitPause(value)).toThrow('EXPLICIT_ADMISSION_STATE_REQUIRED');
  });
  it.each([undefined, '', 'open'])('rejects ambiguous action %s', (value) => {
    expect(() => admissionIntent(value)).toThrow();
  });
  it.each([true, false])('preserves the independently observed state %s', (admissionPaused) => {
    const manifest = manifestFixture({ admissionPaused });
    expect(() =>
      verifyAdmission(manifest, identityFixture(manifest), admissionIntent('preserve'), now()),
    ).not.toThrow();
  });
  it('refuses to reopen through missing/default/preserve/pause actions', () => {
    const manifest = manifestFixture({ admissionPaused: false });
    for (const action of ['preserve', 'pause', 'reopen'] as const)
      expect(() =>
        verifyAdmission(
          manifest,
          { ...identityFixture(manifest), admissionPaused: true },
          admissionIntent(action),
          now(),
        ),
      ).toThrow();
  });
  it('binds explicit reopening to the environment, current Worker and exact prepared manifest', () => {
    const manifest = manifestFixture({ admissionPaused: false });
    const live = { ...identityFixture(manifest, OLD_WORKER), admissionPaused: true };
    expect(() =>
      verifyAdmission(
        manifest,
        live,
        admissionIntent('reopen', `REOPEN:preview:${OLD_WORKER}:${manifest.id}`),
        now(),
      ),
    ).not.toThrow();
    expect(() =>
      verifyAdmission(
        manifest,
        live,
        admissionIntent('reopen', `REOPEN:production:${OLD_WORKER}:${manifest.id}`),
        now(),
      ),
    ).toThrow();
  });
  it('rejects stale, foreign and unknown hosted observations', () => {
    const manifest = manifestFixture();
    for (const change of [
      { observedAt: '2025-01-01T00:00:00.000Z' },
      { environment: 'production' as const },
      { admissionPaused: undefined },
    ])
      expect(() =>
        verifyAdmission(
          manifest,
          { ...identityFixture(manifest), ...change } as ReturnType<typeof identityFixture>,
          admissionIntent('preserve'),
          now(),
        ),
      ).toThrow();
  });
});

describe('durable partial-publication handling with explicit simulator observations', () => {
  async function setup() {
    const manifest = manifestFixture();
    const previous = manifestFixture({ preparedAt: '2026-11-04T00:00:00.000Z' });
    const journal = await ReleaseJournal.create(join(directory, 'journal'), manifest);
    const fixture = providerFixture(manifest, previous);
    const options = {
      previous: { manifest: previous, record: acceptedFixture(previous) },
      authenticatePrevious: vi.fn(async () => true),
      admission: admissionIntent('preserve'),
      integrity: vi.fn(async () => {}),
      now,
    };
    return { manifest, previous, journal, ...fixture, options };
  }
  it('records a simulated published pair without automatically accepting or confirming it', async () => {
    const { journal, provider, options } = await setup();
    const record = await journal.publish(provider, options);
    expect(record).toMatchObject({
      state: 'PUBLISHED',
      admission: {
        action: 'preserve',
        observedPaused: true,
        desiredPaused: true,
        previousWorkerVersion: OLD_WORKER,
      },
      scope: 'offline-fixture',
      acceptance: null,
      provider: { confirmed: false, workerVersion: NEW_WORKER, pagesDeployment: NEW_PAGES },
    });
    expect(
      (await readdir(journal.directory)).filter((name) => /^\d{6}\.json$/.test(name)).length,
    ).toBeGreaterThan(5);
    expect(JSON.parse(await readFile(join(journal.directory, 'release.json'), 'utf8'))).toEqual(
      record,
    );
  });
  it('records an explicit simulator decision and rejects duplicate or conflicting acceptance', async () => {
    const { manifest, journal, provider, options } = await setup();
    await journal.publish(provider, options);
    const expected = {
      manifestId: manifest.id,
      workerVersion: NEW_WORKER,
      pagesDeployment: NEW_PAGES,
    };
    expect((await journal.accept(decisionFixture(), expected, async () => true)).state).toBe(
      'ACCEPTED',
    );
    await expect(
      journal.accept(decisionFixture('REJECT'), expected, async () => true),
    ).rejects.toThrow();
    expect(journal.current().provider.confirmed).toBe(false);
  });
  it.each([
    'publishWorker',
    'confirmWorker',
    'publishPages',
    'confirmPages',
    'readiness',
    'cleanup',
  ] as const)('never accepts failure at %s and sanitizes provider details', async (method) => {
    const { journal, provider, options, calls } = await setup();
    provider[method] = vi.fn(async () => {
      throw new Error('private-provider-token-canary');
    }) as never;
    await expect(journal.publish(provider, options)).rejects.toThrow();
    const record = journal.current();
    expect(record.state).toBe('INCOMPLETE');
    expect(record.acceptance).toBeNull();
    expect(canonical(record)).not.toContain('private-provider-token-canary');
    if (method !== 'cleanup') expect(calls).toContain('cleanup');
    if (method === 'publishPages')
      expect(record.provider).toMatchObject({ workerVersion: NEW_WORKER, pagesDeployment: null });
  });
  it('rejects missing Worker confirmation before Pages mutation', async () => {
    const { manifest, journal, provider, options, calls } = await setup();
    provider.confirmWorker = async () => ({
      workerVersion: '',
      manifestId: manifest.id,
      sourceCommit: manifest.sourceCommit,
      configurationSha256: manifest.configurationSha256,
      observedAt: NOW,
    });
    await expect(journal.publish(provider, options)).rejects.toThrow('WORKER_IDENTITY_UNCONFIRMED');
    expect(calls).not.toContain('publishPages');
  });
  it('rejects missing Pages confirmation without losing the confirmed Worker identity', async () => {
    const { manifest, journal, provider, options } = await setup();
    provider.confirmPages = async () => ({
      pagesDeployment: '',
      manifestId: manifest.id,
      sourceCommit: manifest.sourceCommit,
      configurationSha256: manifest.configurationSha256,
      observedAt: NOW,
    });
    await expect(journal.publish(provider, options)).rejects.toThrow('PAGES_IDENTITY_UNCONFIRMED');
    expect(journal.current().provider).toMatchObject({
      workerVersion: NEW_WORKER,
      pagesDeployment: null,
    });
  });
  it('records failed readiness after both identities and does not accept partial acceptance', async () => {
    const { journal, provider, options } = await setup();
    provider.readiness = async () => ({
      health: 200,
      ready: 500,
      newRoom: 503,
      admissionPaused: true,
      authorizationVerified: true,
      existingSessionVerified: true,
    });
    await expect(journal.publish(provider, options)).rejects.toThrow('RELEASE_READINESS_FAILED');
    expect(journal.current().provider).toMatchObject({
      workerVersion: NEW_WORKER,
      pagesDeployment: NEW_PAGES,
    });
    expect(journal.current().state).toBe('INCOMPLETE');
  });
  it('rejects artifact changes before any publication', async () => {
    const { journal, provider, options, calls } = await setup();
    options.integrity = vi.fn(async () => {
      throw new Error('changed bytes');
    });
    await expect(journal.publish(provider, options)).rejects.toThrow();
    expect(calls).not.toContain('publishWorker');
  });
  it('halts if a previously accepted record is missing', async () => {
    const { previous, journal, provider, options, calls } = await setup();
    options.previous.record = initialRecord(previous);
    await expect(journal.publish(provider, options)).rejects.toThrow(
      'PREVIOUS_ACCEPTED_RELEASE_REQUIRED',
    );
    expect(calls).not.toContain('publishWorker');
  });
  it('refuses self-asserted previous acceptance without independent authentication', async () => {
    const { journal, provider, options, calls } = await setup();
    options.authenticatePrevious = vi.fn(async () => false);
    await expect(journal.publish(provider, options)).rejects.toThrow(
      'PREVIOUS_ACCEPTANCE_UNVERIFIED',
    );
    expect(calls).not.toContain('publishWorker');
  });
  it('requires separate authenticated operator approval before persisting acceptance', async () => {
    const { manifest, journal, provider, options } = await setup();
    await journal.publish(provider, options);
    await expect(
      journal.accept(
        decisionFixture(),
        { manifestId: manifest.id, workerVersion: NEW_WORKER, pagesDeployment: NEW_PAGES },
        async () => false,
      ),
    ).rejects.toThrow('AUTHENTICATED_OPERATOR_APPROVAL_REQUIRED');
    expect(journal.current().state).toBe('PUBLISHED');
    expect(journal.current().acceptance).toBeNull();
    expect(await readdir(journal.directory)).not.toContain('acceptance.json');
  });
  it('halts on an operator abort after Worker publication, preserves intent and cleans up', async () => {
    const { journal, provider, options, calls } = await setup();
    const abort = new AbortController();
    provider.publishWorker = async () => {
      calls.push('publishWorker');
      abort.abort();
    };
    await expect(journal.publish(provider, { ...options, signal: abort.signal })).rejects.toThrow(
      'PUBLICATION_ABORTED',
    );
    expect(journal.current().phase).toBe('worker-intent');
    expect(calls).not.toContain('publishPages');
    expect(calls).toContain('cleanup');
  });
  it('does not overwrite an externally changed record or retry the same release', async () => {
    const { journal, provider, options } = await setup();
    await writeFile(join(journal.directory, 'release.json'), '{}');
    await expect(journal.publish(provider, options)).rejects.toThrow();
    await expect(journal.publish(provider, options)).rejects.toThrow();
    expect(await readFile(join(journal.directory, 'release.json'), 'utf8')).toBe('{}');
  });
  it('has no usable hosted adapter or silent fixture fallback', async () => {
    expect(() => hostedProvider()).toThrow('HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED');
    const manifest = manifestFixture();
    const journal = await ReleaseJournal.create(join(directory, 'blocked'), manifest);
    await expect(writeBlockedPublication(journal.directory, manifest)).rejects.toThrow(
      'HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED',
    );
    expect(journal.current()).toMatchObject({
      state: 'PREPARED',
      provider: { confirmed: false, workerVersion: null, pagesDeployment: null },
    });
  });
  it('requires write-ahead persistence before contacting a provider', async () => {
    const { journal, provider, options, calls } = await setup();
    await mkdir(join(journal.directory, '000001.json'));
    await expect(journal.publish(provider, options)).rejects.toThrow();
    expect(calls).not.toContain('publishWorker');
  });
});
