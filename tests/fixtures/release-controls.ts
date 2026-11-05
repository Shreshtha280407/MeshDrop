import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, fingerprint, initialRecord } from '../../scripts/deploy/release-record';
import { PUBLICATION_EVIDENCE, observationIdentity } from '../../scripts/deploy/release-approval';
import type {
  ApprovalAuthority,
  ApprovalClaim,
  ApprovalContext,
  ApprovalPolicy,
} from '../../scripts/deploy/release-approval';
import type {
  RecoveryEvent,
  RecoveryHead,
  RecoveryStore,
} from '../../scripts/deploy/recovery-evidence';
import { CloudflareReadOnly } from '../../scripts/deploy/cloudflare-readonly';
import {
  fixtureTransport,
  readOnlyExpectation,
  readOnlyResponses,
  FIXTURE_TOKEN,
} from './cloudflare-readonly';
import { ACCEPTANCE_CHECKS } from '../../scripts/deploy/release-record';
import { manifestFixture, NOW, publishedFixture } from './release-record';

// Both keys/identities below are generated solely for offline tests. They are
// not GitHub keys, Cloudflare readback, real human approval or production roots.
export class FixtureApprovalAuthority implements ApprovalAuthority {
  readonly scope = 'offline-fixture' as const;
  private readonly attestor = generateKeyPairSync('ed25519');
  private readonly reviewer = generateKeyPairSync('ed25519');
  readonly revoked = new Set<string>();
  readonly calls: string[] = [];
  override: Partial<Awaited<ReturnType<ApprovalAuthority['verify']>>> = {};
  constructor(
    private readonly policy: ApprovalPolicy,
    private readonly now: () => Date,
  ) {}
  bundle(claim: ApprovalClaim, approverId = claim.approverId): Uint8Array {
    const payload = canonical(claim);
    const review = {
      digest: fingerprint(claim),
      approverId,
      decision: claim.decision,
      reviewId: '505',
    };
    return Buffer.from(
      JSON.stringify({
        signature: sign(null, Buffer.from(payload), this.attestor.privateKey).toString('base64'),
        review,
        reviewSignature: sign(
          null,
          Buffer.from(canonical(review)),
          this.reviewer.privateKey,
        ).toString('base64'),
      }),
    );
  }
  async verify(payload: string, bundle: Uint8Array, challenge: string) {
    const claim = JSON.parse(payload) as ApprovalClaim;
    const proof = JSON.parse(Buffer.from(bundle).toString('utf8')) as {
      signature: string;
      review: {
        digest: string;
        approverId: string;
        decision: ApprovalClaim['decision'];
        reviewId: string;
      };
      reviewSignature: string;
    };
    if (
      !verify(
        null,
        Buffer.from(payload),
        this.attestor.publicKey,
        Buffer.from(proof.signature, 'base64'),
      ) ||
      !verify(
        null,
        Buffer.from(canonical(proof.review)),
        this.reviewer.publicKey,
        Buffer.from(proof.reviewSignature, 'base64'),
      ) ||
      proof.review.digest !== fingerprint(claim)
    )
      throw new Error('Invalid offline signature.');
    this.calls.push(claim.approvalId);
    return {
      digest: fingerprint(claim),
      issuer: 'https://token.actions.githubusercontent.com',
      repositoryId: this.policy.repositoryId,
      repositoryOwnerId: this.policy.repositoryOwnerId,
      signerWorkflow: this.policy.signerWorkflow,
      signerCommit: this.policy.signerCommit,
      sourceCommit: claim.sourceCommit,
      environment: claim.environment,
      runId: claim.runId,
      runAttempt: claim.runAttempt,
      approverId: proof.review.approverId,
      reviewId: proof.review.reviewId,
      decision: proof.review.decision,
      checkedAt: this.now().toISOString(),
      challenge,
      revoked: this.revoked.has(claim.approvalId),
      ...this.override,
    };
  }
}
export async function controlsFixture(purpose: ApprovalClaim['purpose'] = 'publication') {
  let currentTime = new Date(NOW);
  const manifest = manifestFixture();
  const record = purpose === 'publication' ? initialRecord(manifest) : publishedFixture(manifest);
  const expected = readOnlyExpectation(),
    responses = readOnlyResponses(expected);
  const transport = fixtureTransport(responses, expected);
  const readback = new CloudflareReadOnly(expected, FIXTURE_TOKEN, {
    transport: transport.transport,
    now: () => currentTime,
  });
  const policy: ApprovalPolicy = {
    repositoryId: '101',
    repositoryOwnerId: '102',
    signerWorkflow: 'fixture-owner/review-policy/.github/workflows/approval.yml',
    signerCommit: 'd'.repeat(40),
    publicationApprovers: ['202', '204'],
    acceptanceApprovers: ['303', '304'],
  };
  const context: ApprovalContext = {
    manifest,
    record,
    attemptId: crypto.randomUUID(),
    runId: '404',
    runAttempt: 1,
    requestedById: '101',
    publicationApproverId: purpose === 'acceptance' ? '202' : null,
    purpose,
    admission: { action: 'preserve', confirmation: '' },
    policy,
    readback,
    now: () => currentTime,
  };
  const observation = await readback.observe();
  const keys = purpose === 'publication' ? PUBLICATION_EVIDENCE : ACCEPTANCE_CHECKS;
  const claim: ApprovalClaim = {
    schemaVersion: 1,
    approvalId: crypto.randomUUID(),
    repository: manifest.repository,
    environment: manifest.environment,
    sourceCommit: manifest.sourceCommit,
    manifestId: manifest.id,
    attemptId: context.attemptId,
    runId: context.runId,
    runAttempt: context.runAttempt,
    purpose,
    decision: purpose === 'publication' ? 'AUTHORIZE' : 'ACCEPT',
    workerVersion: expected.workerVersion,
    pagesDeployment: expected.pagesDeployment,
    providerObservationId: observationIdentity(observation),
    recordSha256: fingerprint(record),
    approverId: purpose === 'publication' ? '202' : '303',
    requestedById: context.requestedById,
    admissionAction: 'preserve',
    observedAdmissionPaused: true,
    issuedAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 300000).toISOString(),
    evidence: Object.fromEntries(keys.map((key) => [key, fingerprint({ offlineFixture: key })])),
  };
  const authority = new FixtureApprovalAuthority(policy, context.now);
  return {
    manifest,
    record,
    context,
    claim,
    authority,
    transport,
    responses,
    readback,
    setTime(value: Date) {
      currentTime = value;
    },
  };
}

/** Real local SQLite CAS/replay/ownership model. It survives local reopen only;
 * it makes no independent authority or off-run durability claim. Test-only. */
export class FixtureRecoveryStore implements RecoveryStore {
  readonly scope = 'offline-fixture' as const;
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS owners(scope TEXT PRIMARY KEY, attempt TEXT NOT NULL, manifest TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(scope TEXT NOT NULL, attempt TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,seq));
      CREATE TABLE IF NOT EXISTS consumed(approval TEXT PRIMARY KEY, scope TEXT NOT NULL, attempt TEXT NOT NULL);`);
  }
  async append(event: RecoveryEvent, expected: RecoveryHead | null): Promise<RecoveryHead> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM owners WHERE scope=?').get(event.scopeId) as
        | { scope: string; attempt: string; manifest: string; seq: number; hash: string }
        | undefined;
      if (expected === null) {
        if (row || event.sequence !== 0 || event.kind !== 'START')
          throw new Error('Attempt/environment already reserved.');
        this.db
          .prepare('INSERT INTO owners VALUES(?,?,?,?,?)')
          .run(event.scopeId, event.attemptId, event.manifestId, -1, '');
      } else if (
        !row ||
        row.attempt !== event.attemptId ||
        row.manifest !== event.manifestId ||
        expected.scopeId !== row.scope ||
        expected.attemptId !== row.attempt ||
        expected.sequence !== row.seq ||
        expected.hash !== row.hash ||
        event.previousHash !== row.hash ||
        event.sequence !== row.seq + 1
      )
        throw new Error('CAS conflict.');
      if (event.approval)
        this.db
          .prepare('INSERT INTO consumed VALUES(?,?,?)')
          .run(event.approval.approvalId, event.scopeId, event.attemptId);
      this.db
        .prepare('INSERT INTO events VALUES(?,?,?,?)')
        .run(event.scopeId, event.attemptId, event.sequence, canonical(event));
      this.db
        .prepare('UPDATE owners SET seq=?,hash=? WHERE scope=?')
        .run(event.sequence, event.hash, event.scopeId);
      this.db.exec('COMMIT');
      return {
        scopeId: event.scopeId,
        attemptId: event.attemptId,
        sequence: event.sequence,
        hash: event.hash,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async read(scopeId: string, attemptId: string) {
    const row = this.db
      .prepare('SELECT * FROM owners WHERE scope=? AND attempt=?')
      .get(scopeId, attemptId) as { seq: number; hash: string } | undefined;
    if (!row) throw new Error('Missing attempt.');
    const rows = this.db
      .prepare('SELECT payload FROM events WHERE scope=? AND attempt=? ORDER BY seq')
      .all(scopeId, attemptId) as { payload: string }[];
    return {
      events: rows.map((row) => JSON.parse(row.payload) as RecoveryEvent),
      head: { scopeId, attemptId, sequence: row.seq, hash: row.hash },
    };
  }
  close() {
    this.db.close();
  }
}
