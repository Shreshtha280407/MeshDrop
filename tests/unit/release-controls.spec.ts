import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkApproval,
  hostedApprovalAuthority,
  parseApprovalClaim,
  recheckApproval,
} from '../../scripts/deploy/release-approval';
import type { ApprovalClaim } from '../../scripts/deploy/release-approval';
import {
  hostedRecoveryStore,
  inspectRecovery,
  RecoveryLog,
  recoveryScope,
} from '../../scripts/deploy/recovery-evidence';
import { requireHostedObservation } from '../../scripts/deploy/cloudflare-readonly';
import type { RecoveryStore } from '../../scripts/deploy/recovery-evidence';
import { ReleaseJournal, hostedProvider } from '../../scripts/deploy/release-lifecycle';
import {
  fingerprint,
  initialRecord,
  requireAccepted,
  acceptRelease,
} from '../../scripts/deploy/release-record';
import type { ReleaseRecord } from '../../scripts/deploy/release-record';
import {
  controlsFixture,
  FixtureApprovalAuthority,
  FixtureRecoveryStore,
} from '../fixtures/release-controls';
import {
  decisionFixture,
  manifestFixture,
  publishedFixture,
  NEW_WORKER,
  providerFixture,
  acceptedFixture,
} from '../fixtures/release-record';

let directory: string;
const stores = new Set<FixtureRecoveryStore>();
const store = (name = 'recovery.sqlite') => {
  const result = new FixtureRecoveryStore(join(directory, name));
  stores.add(result);
  return result;
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meshdrop-release-controls-'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real provider requests forbidden.'));
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  for (const item of stores) item.close();
  stores.clear();
  await rm(directory, { recursive: true, force: true });
});
async function checked(f: Awaited<ReturnType<typeof controlsFixture>>) {
  return checkApproval(f.claim, f.authority.bundle(f.claim), f.authority, f.context);
}

describe('bound approval verification, without a hosted authority', () => {
  it.each(['publication', 'acceptance'] as const)(
    'verifies a %s payload through real offline signatures without approving a release',
    async (purpose) => {
      const f = await controlsFixture(purpose),
        check = await checked(f);
      expect(check).toMatchObject({
        scope: 'offline-fixture',
        digest: fingerprint(f.claim),
        productionApproved: false,
        releaseAccepted: false,
        publicationEnabled: false,
      });
      expect(await recheckApproval(check)).toEqual(f.claim);
      expect(f.authority.calls).toHaveLength(2);
    },
  );
  it('requires a trusted authority rather than a username or workflow input', async () => {
    const f = await controlsFixture();
    await expect(checkApproval(f.claim, new Uint8Array([1]), undefined, f.context)).rejects.toThrow(
      'TRUSTED_APPROVAL_AUTHORITY_REQUIRED',
    );
    expect(() => parseApprovalClaim({ ...f.claim, operator: 'admin' })).toThrow(
      'UNEXPECTED_APPROVAL_FIELDS',
    );
    expect(hostedApprovalAuthority).toThrow('HOSTED_APPROVAL_AUTHORITY_NOT_CONFIGURED');
  });
  const wrongBindings: { name: string; patch: Partial<ApprovalClaim> }[] = [
    {
      name: 'repository',
      patch: { repository: 'https://github.com/attacker/project' as ApprovalClaim['repository'] },
    },
    { name: 'environment', patch: { environment: 'production' } },
    { name: 'source commit', patch: { sourceCommit: 'b'.repeat(40) } },
    { name: 'manifest', patch: { manifestId: '0'.repeat(64) } },
    { name: 'Worker version', patch: { workerVersion: NEW_WORKER } },
    { name: 'Pages deployment', patch: { pagesDeployment: NEW_WORKER } },
    { name: 'provider observation', patch: { providerObservationId: '0'.repeat(64) } },
    { name: 'release record', patch: { recordSha256: '0'.repeat(64) } },
    { name: 'run', patch: { runId: '999' } },
    { name: 'rerun', patch: { runAttempt: 2 } },
    { name: 'attempt', patch: { attemptId: '50000000-0000-4000-8000-000000000001' } },
    { name: 'operator', patch: { approverId: '999' } },
    { name: 'initiator', patch: { requestedById: '999' } },
    { name: 'purpose', patch: { purpose: 'acceptance', decision: 'ACCEPT' } },
    { name: 'admission intent', patch: { admissionAction: 'reopen' } },
    { name: 'admission observation', patch: { observedAdmissionPaused: false } },
  ];
  it.each(wrongBindings)(
    'rejects a correctly signed approval for a different $name',
    async ({ patch }) => {
      const f = await controlsFixture();
      Object.assign(f.claim, patch);
      await expect(checked(f)).rejects.toThrow();
    },
  );
  it('rejects self approval even if the actor appears in an allowed role', async () => {
    const f = await controlsFixture();
    f.context.policy.publicationApprovers = [f.context.requestedById];
    f.claim.approverId = f.context.requestedById;
    await expect(checked(f)).rejects.toThrow('APPROVER_NOT_AUTHORIZED');
  });
  it('requires a distinct acceptance reviewer from the publication reviewer', async () => {
    const f = await controlsFixture('acceptance');
    f.context.policy.acceptanceApprovers = ['202'];
    f.claim.approverId = '202';
    await expect(checked(f)).rejects.toThrow('APPROVER_NOT_AUTHORIZED');
  });
  it('does not confuse the authenticated review identity with a payload actor', async () => {
    const f = await controlsFixture();
    await expect(
      checkApproval(f.claim, f.authority.bundle(f.claim, '204'), f.authority, f.context),
    ).rejects.toThrow('UNTRUSTED_APPROVAL_AUTHORITY_EVIDENCE');
  });
  it('rejects substituted signing/reviewer keys', async () => {
    const f = await controlsFixture(),
      forged = new FixtureApprovalAuthority(f.context.policy, f.context.now);
    await expect(
      checkApproval(f.claim, forged.bundle(f.claim), f.authority, f.context),
    ).rejects.toThrow('APPROVAL_AUTHENTICATION_FAILED');
  });
  it('sanitizes failed authentication and rejects malformed authority evidence', async () => {
    const f = await controlsFixture();
    vi.spyOn(f.authority, 'verify').mockRejectedValueOnce(new Error('private-token-canary'));
    await expect(checked(f)).rejects.toThrow(/^APPROVAL_AUTHENTICATION_FAILED$/);
    vi.spyOn(f.authority, 'verify').mockResolvedValueOnce(undefined as never);
    await expect(checked(f)).rejects.toThrow('UNTRUSTED_APPROVAL_AUTHORITY_EVIDENCE');
  });
  it('rejects modified approval bytes and evidence references', async () => {
    const f = await controlsFixture(),
      bundle = f.authority.bundle(f.claim);
    f.claim.evidence['prepared-artifacts'] = '9'.repeat(64);
    await expect(checkApproval(f.claim, bundle, f.authority, f.context)).rejects.toThrow(
      'APPROVAL_AUTHENTICATION_FAILED',
    );
  });
  it.each([
    { name: 'issuer', value: { issuer: 'https://attacker.invalid' } },
    { name: 'repository ID', value: { repositoryId: '999' } },
    { name: 'owner ID', value: { repositoryOwnerId: '999' } },
    {
      name: 'signer workflow',
      value: { signerWorkflow: 'untrusted/workflow/.github/workflows/approval.yml' },
    },
    { name: 'signer commit', value: { signerCommit: 'e'.repeat(40) } },
    { name: 'source claim', value: { sourceCommit: 'e'.repeat(40) } },
    { name: 'environment claim', value: { environment: 'production' as const } },
    { name: 'run identity', value: { runId: '999' } },
    { name: 'human review', value: { reviewId: '' } },
    { name: 'decision', value: { decision: 'REJECT' as const } },
  ])('rejects untrusted attestation/review $name', async ({ value }) => {
    const f = await controlsFixture();
    f.authority.override = value;
    await expect(checked(f)).rejects.toThrow('UNTRUSTED_APPROVAL_AUTHORITY_EVIDENCE');
  });
  it('rejects replayed verifier output through a fresh challenge', async () => {
    const f = await controlsFixture();
    f.authority.override = { challenge: crypto.randomUUID() };
    await expect(checked(f)).rejects.toThrow('STALE_AUTHORITY_VERIFICATION');
  });
  it('rejects expired and excessively long-lived approvals', async () => {
    const f = await controlsFixture();
    f.setTime(new Date(Date.parse(f.claim.expiresAt) + 1));
    await expect(checked(f)).rejects.toThrow('APPROVAL_EXPIRED_OR_NOT_YET_VALID');
    f.claim.expiresAt = new Date(Date.parse(f.claim.issuedAt) + 600001).toISOString();
    expect(() => parseApprovalClaim(f.claim)).toThrow('INVALID_APPROVAL_VALIDITY');
  });
  it('rejects approval that expires during provider readback', async () => {
    const f = await controlsFixture();
    f.claim.expiresAt = new Date(Date.parse(f.claim.issuedAt) + 1000).toISOString();
    const observe = f.readback.observe.bind(f.readback);
    vi.spyOn(f.readback, 'observe').mockImplementationOnce(async () => {
      const observation = await observe();
      f.setTime(new Date(Date.parse(f.claim.expiresAt) + 1));
      return observation;
    });
    await expect(checked(f)).rejects.toThrow('APPROVAL_EXPIRED_OR_NOT_YET_VALID');
  });
  it('rejects incomplete evidence and unexpected secret fields', async () => {
    const f = await controlsFixture();
    delete f.claim.evidence['prepared-artifacts'];
    expect(() => parseApprovalClaim(f.claim)).toThrow('INCOMPLETE_APPROVAL_EVIDENCE');
    expect(() => parseApprovalClaim({ ...f.claim, token: 'private-token-canary' })).toThrow(
      'UNEXPECTED_APPROVAL_FIELDS',
    );
  });
  it('rechecks revocation before use rather than caching the initial decision', async () => {
    const f = await controlsFixture(),
      check = await checked(f);
    f.authority.revoked.add(f.claim.approvalId);
    await expect(recheckApproval(check, true)).rejects.toThrow('APPROVAL_REVOKED');
  });
  it('rechecks provider changes after approval', async () => {
    const f = await controlsFixture(),
      check = await checked(f);
    f.responses.active.deployments[0]!.versions[0]!.version_id = NEW_WORKER;
    await expect(recheckApproval(check, true)).rejects.toThrow('CONFLICTING_WORKER_VERSIONS');
  });
  it('rejects stale provider observations and stale revocation checks', async () => {
    const f = await controlsFixture();
    f.setTime(new Date(f.context.now().getTime() + 61000));
    await expect(checked(f)).rejects.toThrow('STALE_HOSTED_PREFLIGHT');
    f.setTime(new Date(f.claim.issuedAt));
    f.authority.override = {
      checkedAt: new Date(Date.parse(f.claim.issuedAt) - 6000).toISOString(),
    };
    await expect(checked(f)).rejects.toThrow('STALE_AUTHORITY_VERIFICATION');
  });
  it('does not promote modified or serialized checks or provider fixtures', async () => {
    const f = await controlsFixture(),
      check = await checked(f),
      observation = await f.readback.observe();
    await expect(recheckApproval(structuredClone(check))).rejects.toThrow(
      'UNTRUSTED_OR_MODIFIED_APPROVAL_CHECK',
    );
    check.scope = 'hosted-candidate';
    await expect(recheckApproval(check)).rejects.toThrow('UNTRUSTED_OR_MODIFIED_APPROVAL_CHECK');
    expect(() => requireHostedObservation(observation, f.context.now())).toThrow(
      'AUTHENTICATED_READBACK_REQUIRED',
    );
    expect(() =>
      requireHostedObservation(
        { ...observation, scope: 'cloudflare-api', providerConfirmed: true },
        f.context.now(),
      ),
    ).toThrow('UNTRUSTED_OR_MODIFIED_OBSERVATION');
  });
  it('requires an approving reviewer to explicitly authorize reopening paused admission', async () => {
    const f = await controlsFixture();
    f.context.manifest = manifestFixture({ admissionPaused: false });
    f.context.record = initialRecord(f.context.manifest);
    Object.assign(f.claim, {
      manifestId: f.context.manifest.id,
      recordSha256: fingerprint(f.context.record),
    });
    await expect(checked(f)).rejects.toThrow('ADMISSION_PRESERVATION_FAILED');
    f.context.admission = { action: 'reopen', confirmation: '' };
    f.claim.admissionAction = 'reopen';
    await expect(checked(f)).rejects.toThrow('EXPLICIT_REOPEN_CONFIRMATION_REQUIRED');
    f.context.admission.confirmation = `REOPEN:preview:${f.claim.workerVersion}:${f.context.manifest.id}`;
    expect((await checked(f)).publicationEnabled).toBe(false);
  });
  it('rejects incomplete/rejected publication snapshots for acceptance', async () => {
    const f = await controlsFixture('acceptance');
    f.context.record = {
      ...f.record,
      state: 'INCOMPLETE',
      phase: 'readiness',
      failure: 'RELEASE_READINESS_FAILED',
    };
    f.claim.recordSha256 = fingerprint(f.context.record);
    await expect(checked(f)).rejects.toThrow('RELEASE_NOT_APPROVABLE');
  });
});

describe('CAS recovery evidence and runner interruption', () => {
  async function setup() {
    const f = await controlsFixture(),
      database = store();
    const log = new RecoveryLog(database, f.manifest, f.context.attemptId);
    await log.checkpoint(f.record);
    return { ...f, database, log };
  }
  async function published() {
    const f = await setup();
    const publication = await checked(f);
    await f.log.consume(publication);
    const snapshot = publishedFixture(f.manifest);
    let record: ReleaseRecord = {
      ...f.record,
      scope: 'offline-fixture',
      state: 'INCOMPLETE',
      admission: snapshot.admission,
    };
    for (const phase of [
      'preflight',
      'worker-intent',
      'worker-confirmed',
      'pages-intent',
      'pages-confirmed',
      'readiness',
      'published',
    ] as const) {
      record = { ...record, phase, sequence: record.sequence + 1 };
      if (phase === 'worker-confirmed') record.provider = snapshot.provider;
      if (phase === 'published') record.state = 'PUBLISHED';
      await f.log.checkpoint(record);
    }
    const acceptance = await controlsFixture('acceptance');
    acceptance.context.record = record;
    acceptance.context.attemptId = f.context.attemptId;
    acceptance.claim.recordSha256 = fingerprint(record);
    acceptance.claim.attemptId = f.context.attemptId;
    return { ...f, record, acceptance, publication };
  }
  it('retains the consumed reviewer identity independently of a mutable proof object', async () => {
    const f = await published();
    f.publication.claim.approverId = '999';
    f.acceptance.claim.approverId = f.claim.approverId;
    f.acceptance.context.policy.acceptanceApprovers = [f.claim.approverId];
    f.acceptance.context.publicationApproverId = '999';
    await expect(f.log.consume(await checked(f.acceptance))).rejects.toThrow(
      'ACCEPTANCE_APPROVAL_REQUIRED',
    );
  });
  it('requires a second verified reviewer before recording offline acceptance evidence', async () => {
    const f = await published();
    const decision = {
      operator: `github-user-${f.acceptance.claim.approverId}`,
      decidedAt: f.acceptance.claim.issuedAt,
      decision: 'ACCEPT' as const,
      evidence: f.acceptance.claim.evidence,
    };
    const next = acceptRelease(f.manifest, f.record, decision, {
      manifestId: f.manifest.id,
      workerVersion: f.acceptance.claim.workerVersion,
      pagesDeployment: f.acceptance.claim.pagesDeployment,
    });
    await expect(f.log.checkpoint(next)).rejects.toThrow('ACCEPTANCE_APPROVAL_REQUIRED');
    await f.log.consume(await checked(f.acceptance));
    await f.log.checkpoint(next);
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(
      inspectRecovery(f.manifest, f.context.attemptId, snapshot.events, snapshot.head),
    ).toMatchObject({
      record: { state: 'ACCEPTED', scope: 'offline-fixture' },
      authenticated: false,
      offRunDurable: false,
      releaseAccepted: false,
      productionApproved: false,
    });
    expect(() => requireAccepted(f.manifest, next)).toThrow();
  });
  it.each(['operator', 'evidence'] as const)(
    'rejects changed acceptance %s after verification',
    async (field) => {
      const f = await published();
      await f.log.consume(await checked(f.acceptance));
      const decision = {
        operator: `github-user-${f.acceptance.claim.approverId}`,
        decidedAt: f.acceptance.claim.issuedAt,
        decision: 'ACCEPT' as const,
        evidence: { ...f.acceptance.claim.evidence } as NonNullable<
          ReleaseRecord['acceptance']
        >['evidence'],
      };
      if (field === 'operator') decision.operator = 'github-user-304';
      if (field === 'evidence') {
        decision.evidence['artifact-identity'] = '0'.repeat(64);
      }
      const next = acceptRelease(f.manifest, f.record, decision, {
        manifestId: f.manifest.id,
        workerVersion: f.acceptance.claim.workerVersion,
        pagesDeployment: f.acceptance.claim.pagesDeployment,
      });
      await expect(f.log.checkpoint(next)).rejects.toThrow('ACCEPTANCE_EVIDENCE_MISMATCH');
    },
  );
  it('records a signed approval once and detects replay after reopening storage', async () => {
    const f = await setup(),
      check = await checked(f);
    await f.log.consume(check);
    await expect(f.log.consume(check)).rejects.toThrow('APPROVAL_ALREADY_CONSUMED');
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(
      inspectRecovery(f.manifest, f.context.attemptId, snapshot.events, snapshot.head),
    ).toMatchObject({
      integrityVerified: true,
      authenticated: false,
      offRunDurable: false,
      releaseAccepted: false,
      productionApproved: false,
    });
    // A newly verified same approval cannot be consumed through another cursor.
    const again = await checked(f);
    await expect(f.log.consume(again)).rejects.toThrow('PUBLICATION_APPROVAL_ALREADY_RECORDED');
  });
  it('rejects duplicate attempts and competing manifests in the same environment', async () => {
    const f = await setup();
    const duplicate = new RecoveryLog(f.database, f.manifest, f.context.attemptId);
    await expect(duplicate.checkpoint(f.record)).rejects.toThrow(
      'RECOVERY_APPEND_FAILED_RECONCILE',
    );
    const other = manifestFixture({ preparedAt: '2026-11-05T00:00:01.000Z' });
    await expect(
      new RecoveryLog(f.database, other, crypto.randomUUID()).checkpoint(initialRecord(other)),
    ).rejects.toThrow('RECOVERY_APPEND_FAILED_RECONCILE');
  });
  it('lets exactly one independent SQLite writer reserve an environment', async () => {
    const f = await controlsFixture(),
      a = store(),
      b = store();
    const outcomes = await Promise.allSettled([
      new RecoveryLog(a, f.manifest, crypto.randomUUID()).checkpoint(f.record),
      new RecoveryLog(b, f.manifest, crypto.randomUUID()).checkpoint(f.record),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
  });
  it('keeps consumed approval IDs unique across independent SQLite connections', async () => {
    const f = await setup();
    await f.log.consume(await checked(f));
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    const event = structuredClone(snapshot.events[1]!);
    // Even a second cursor attempting the same approval at the next valid CAS
    // head cannot bypass the storage-level replay ledger.
    event.sequence += 1;
    event.previousHash = snapshot.head.hash;
    await expect(store().append(event, snapshot.head)).rejects.toThrow();
    expect((await f.database.read(recoveryScope(f.manifest), f.context.attemptId)).head).toEqual(
      snapshot.head,
    );
  });
  it('keeps preview and production ownership separate', async () => {
    const database = store(),
      preview = manifestFixture(),
      production = manifestFixture({
        environment: 'production',
        project: 'meshdrop-fixture-production',
        worker: 'meshdrop-fixture-production-signaling',
      });
    await new RecoveryLog(database, preview, crypto.randomUUID()).checkpoint(
      initialRecord(preview),
    );
    await new RecoveryLog(database, production, crypto.randomUUID()).checkpoint(
      initialRecord(production),
    );
    expect(database.db.prepare('SELECT count(*) AS n FROM owners').get()).toMatchObject({ n: 2 });
  });
  it('prevents checkpoint races within an attempt', async () => {
    const f = await setup();
    const next: ReleaseRecord = {
      ...f.record,
      state: 'INCOMPLETE',
      phase: 'preflight',
      sequence: 1,
    };
    const outcomes = await Promise.allSettled([f.log.checkpoint(next), f.log.checkpoint(next)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
  it.each(['offline-fixture', 'external-authenticated'] as const)(
    'rejects self-asserted hosted snapshots even with a %s store label',
    async (scope) => {
      const f = await controlsFixture(),
        database = store();
      const port: RecoveryStore = {
        scope,
        append: database.append.bind(database),
        read: database.read.bind(database),
      };
      const log = new RecoveryLog(port, f.manifest, f.context.attemptId);
      await log.checkpoint(f.record);
      const snapshot = publishedFixture(f.manifest);
      const forged: ReleaseRecord = {
        ...snapshot,
        scope: 'hosted-observation',
        state: 'INCOMPLETE',
        phase: 'preflight',
        provider: { ...snapshot.provider, confirmed: true },
      };
      await expect(log.checkpoint(forged)).rejects.toThrow(
        scope === 'offline-fixture'
          ? 'OFFLINE_RECOVERY_CANNOT_CONFIRM_PROVIDER'
          : 'HOSTED_RECOVERY_READBACK_NOT_CONFIGURED',
      );
      expect(
        (await database.read(recoveryScope(f.manifest), f.context.attemptId)).events,
      ).toHaveLength(1);
    },
  );
  it('requires approval before a mutation intent and never accepts an incomplete release', async () => {
    const f = await setup();
    const preflight: ReleaseRecord = {
      ...f.record,
      state: 'INCOMPLETE',
      phase: 'preflight',
      sequence: 1,
    };
    await f.log.checkpoint(preflight);
    await expect(
      f.log.checkpoint({ ...preflight, sequence: 2, phase: 'worker-intent' }),
    ).rejects.toThrow('PUBLICATION_APPROVAL_REQUIRED');
    await expect(
      f.log.checkpoint({ ...preflight, sequence: 2, phase: 'acceptance', state: 'ACCEPTED' }),
    ).rejects.toThrow();
  });
  it('retains a rejected approval as terminal evidence without authorizing publication', async () => {
    const f = await setup();
    f.claim.decision = 'REJECT';
    await f.log.consume(await checked(f));
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(
      inspectRecovery(f.manifest, f.context.attemptId, snapshot.events, snapshot.head).disposition,
    ).toBe('REJECTED');
    await expect(
      f.log.checkpoint({ ...f.record, state: 'INCOMPLETE', phase: 'preflight', sequence: 1 }),
    ).rejects.toThrow('RELEASE_APPROVAL_REJECTED');
  });
  it('recovers a write-ahead intent after simulated runner-directory loss and local database reopen', async () => {
    const f = await setup();
    await f.log.consume(await checked(f));
    const preflight: ReleaseRecord = {
      ...f.record,
      state: 'INCOMPLETE',
      phase: 'preflight',
      sequence: 1,
    };
    await f.log.checkpoint(preflight);
    await f.log.checkpoint({ ...preflight, phase: 'worker-intent', sequence: 2 });
    const snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    f.database.close();
    stores.delete(f.database);
    const reopened = store();
    const recovered = await RecoveryLog.recover(
      reopened,
      f.manifest,
      f.context.attemptId,
      snapshot.head,
    );
    expect(recovered).toMatchObject({
      record: { phase: 'worker-intent', state: 'INCOMPLETE' },
      offRunDurable: false,
      releaseAccepted: false,
    });
    expect(recovered).not.toHaveProperty('publish');
    await expect(
      new RecoveryLog(reopened, f.manifest, crypto.randomUUID()).checkpoint(f.record),
    ).rejects.toThrow();
  });
  it.each(['gap', 'replay', 'payload', 'tail', 'head'] as const)(
    'rejects %s tampering against an independent checkpoint',
    async (kind) => {
      const f = await setup();
      await f.log.consume(await checked(f));
      const { events, head } = await f.database.read(
        recoveryScope(f.manifest),
        f.context.attemptId,
      );
      const changed = structuredClone(events),
        anchor = structuredClone(head);
      if (kind === 'gap') changed.shift();
      if (kind === 'replay') changed.push(changed[1]!);
      if (kind === 'payload') changed[1]!.record.sequence = 99;
      if (kind === 'tail') changed.pop();
      if (kind === 'head') anchor.hash = '0'.repeat(64);
      expect(() => inspectRecovery(f.manifest, f.context.attemptId, changed, anchor)).toThrow();
    },
  );
  it('does not infer independent authenticity from a rehashed journal or a local checkpoint', async () => {
    const f = await setup(),
      snapshot = await f.database.read(recoveryScope(f.manifest), f.context.attemptId);
    const result = inspectRecovery(f.manifest, f.context.attemptId, snapshot.events, snapshot.head);
    expect(result.authenticated).toBe(false);
    expect(result.offRunDurable).toBe(false);
    expect(hostedRecoveryStore).toThrow('HOSTED_RECOVERY_STORE_NOT_CONFIGURED');
  });
  it('writes evidence before any simulated mutation and recovers after runner-directory loss', async () => {
    const f = await controlsFixture(),
      database = store();
    const log = new RecoveryLog(database, f.manifest, f.context.attemptId);
    const journal = await ReleaseJournal.create(join(directory, 'runner'), f.manifest, log);
    await log.consume(await checked(f));
    const previous = manifestFixture({ preparedAt: '2026-11-04T00:00:00.000Z' });
    const { provider } = providerFixture(f.manifest, previous);
    const publish = vi.spyOn(provider, 'publishWorker').mockImplementation(async () => {
      const snapshot = await database.read(recoveryScope(f.manifest), f.context.attemptId);
      expect(snapshot.events.at(-1)?.record.phase).toBe('worker-intent');
      throw new Error('Simulated runner interruption.');
    });
    await expect(
      journal.publish(provider, {
        previous: { manifest: previous, record: acceptedFixture(previous) },
        authenticatePrevious: async () => true,
        admission: f.context.admission,
        integrity: async () => {},
        now: f.context.now,
      }),
    ).rejects.toThrow();
    expect(publish).toHaveBeenCalledOnce();
    expect(journal.current()).toMatchObject({ state: 'INCOMPLETE', acceptance: null });
    await rm(journal.directory, { recursive: true, force: true });
    const snapshot = await database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(
      (await RecoveryLog.recover(database, f.manifest, f.context.attemptId, snapshot.head)).record
        .state,
    ).toBe('INCOMPLETE');
  });
  it('stops before provider mutation when a committed intent loses its acknowledgement', async () => {
    const f = await controlsFixture(),
      database = store();
    const original = database.append.bind(database);
    const append = vi.spyOn(database, 'append');
    append.mockImplementation(async (event, expected) => {
      const receipt = await original(event, expected);
      if (event.record.phase === 'worker-intent') throw new Error('private-storage-canary');
      return receipt;
    });
    const log = new RecoveryLog(database, f.manifest, f.context.attemptId);
    const journal = await ReleaseJournal.create(join(directory, 'lost-ack'), f.manifest, log);
    await log.consume(await checked(f));
    const previous = manifestFixture({ preparedAt: '2026-11-04T00:00:00.000Z' }),
      { provider } = providerFixture(f.manifest, previous);
    const mutation = vi.spyOn(provider, 'publishWorker');
    await expect(
      journal.publish(provider, {
        previous: { manifest: previous, record: acceptedFixture(previous) },
        authenticatePrevious: async () => true,
        admission: f.context.admission,
        integrity: async () => {},
        now: f.context.now,
      }),
    ).rejects.toThrow('RECOVERY_APPEND_FAILED_RECONCILE');
    expect(mutation).not.toHaveBeenCalled();
    const snapshot = await database.read(recoveryScope(f.manifest), f.context.attemptId);
    expect(
      (await RecoveryLog.recover(database, f.manifest, f.context.attemptId, snapshot.head)).record
        .phase,
    ).toBe('worker-intent');
  });
  it('redacts storage failures and refuses an invalid acknowledgement', async () => {
    const f = await controlsFixture(),
      database = store();
    const append = vi.spyOn(database, 'append');
    append.mockResolvedValueOnce({
      scopeId: 'wrong',
      attemptId: f.context.attemptId,
      sequence: 0,
      hash: '0'.repeat(64),
    });
    await expect(
      new RecoveryLog(database, f.manifest, f.context.attemptId).checkpoint(f.record),
    ).rejects.toThrow('RECOVERY_RECEIPT_MISMATCH');
    vi.spyOn(database, 'read').mockRejectedValueOnce(new Error('private-storage-canary'));
    await expect(
      RecoveryLog.recover(database, f.manifest, f.context.attemptId, {} as never),
    ).rejects.toThrow(/^RECOVERY_READ_FAILED_UNVERIFIED$/);
  });
  it('keeps publication and hosted acceptance blocked even with callback flags', async () => {
    const f = await controlsFixture(),
      journal = await ReleaseJournal.create(join(directory, 'blocked'), f.manifest);
    const previous = manifestFixture({ preparedAt: '2026-11-04T00:00:00.000Z' }),
      { provider } = providerFixture(f.manifest, previous);
    const calls = vi.spyOn(provider, 'publishWorker');
    Object.defineProperty(provider, 'mode', { value: 'hosted-observation' });
    await expect(
      journal.publish(provider, {
        previous: { manifest: previous, record: acceptedFixture(previous) },
        authenticatePrevious: async () => true,
        admission: f.context.admission,
        integrity: async () => {},
        now: f.context.now,
      }),
    ).rejects.toThrow('HOSTED_PUBLICATION_DISABLED');
    expect(calls).not.toHaveBeenCalled();
    expect(hostedProvider).toThrow('HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED');
    await expect(
      journal.accept(
        decisionFixture(),
        {
          manifestId: f.manifest.id,
          workerVersion: f.claim.workerVersion,
          pagesDeployment: f.claim.pagesDeployment,
        },
        async () => true,
      ),
    ).rejects.toThrow('HOSTED_ACCEPTANCE_AUTHORITY_NOT_CONFIGURED');
    expect(await readdir(journal.directory)).not.toContain('acceptance.json');
    expect(() => requireAccepted(f.manifest, initialRecord(f.manifest))).toThrow();
  });
  it('retains the shared environment lock after failure and prevents a second local release', async () => {
    const f = await controlsFixture();
    const previous = manifestFixture({ preparedAt: '2026-11-04T00:00:00.000Z' });
    const first = await ReleaseJournal.create(join(directory, 'first'), f.manifest);
    const a = providerFixture(f.manifest, previous).provider;
    vi.spyOn(a, 'publishWorker').mockRejectedValueOnce(new Error('Simulated failure.'));
    const options = {
      previous: { manifest: previous, record: acceptedFixture(previous) },
      authenticatePrevious: async () => true,
      admission: f.context.admission,
      integrity: async () => {},
      now: f.context.now,
    };
    await expect(first.publish(a, options)).rejects.toThrow();
    const other = manifestFixture({ preparedAt: '2026-11-05T00:00:01.000Z' });
    const second = await ReleaseJournal.create(join(directory, 'second'), other);
    const b = providerFixture(other, previous).provider;
    const current = vi.spyOn(b, 'current'),
      mutation = vi.spyOn(b, 'publishWorker');
    await expect(second.publish(b, options)).rejects.toThrow();
    expect(current).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(
      (await readdir(directory)).filter((name) => /^environment-.*\.lock$/.test(name)),
    ).toHaveLength(1);
  });
});
