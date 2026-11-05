import {
  fingerprint,
  parseManifest,
  parseRecord,
  REPOSITORY,
  requireRelease,
  ReleaseError,
  sameContent,
} from './release-record';
import type { Manifest, ReleaseRecord } from './release-record';
import { recheckApproval } from './release-approval';
import type { CheckedApproval } from './release-approval';
import type { ReleaseEvidenceSink } from './release-lifecycle';

export type RecoveryHead = { scopeId: string; attemptId: string; sequence: number; hash: string };
export type RecoveryEvent = {
  schemaVersion: 1;
  scopeId: string;
  attemptId: string;
  manifestId: string;
  environment: Manifest['environment'];
  sourceCommit: string;
  sequence: number;
  previousHash: string | null;
  kind: 'START' | 'CHECKPOINT' | 'APPROVAL_CHECKED' | 'APPROVAL_REJECTED';
  record: ReleaseRecord;
  approval: {
    approvalId: string;
    digest: string;
    purpose: 'publication' | 'acceptance';
    decision: 'AUTHORIZE' | 'ACCEPT' | 'REJECT';
  } | null;
  hash: string;
};
/** Storage is a trusted dependency, not data from a release artifact.
 * append must atomically CAS the head, reserve the environment on START, and
 * uniquely consume approval IDs across attempts. read must return complete,
 * consistently ordered history. A hosted adapter must authenticate independent
 * checkpoints and provide retention/access guarantees. None is installed here.
 */
export interface RecoveryStore {
  readonly scope: 'offline-fixture' | 'external-authenticated';
  append(event: RecoveryEvent, expected: RecoveryHead | null): Promise<RecoveryHead>;
  read(
    scopeId: string,
    attemptId: string,
  ): Promise<{ events: RecoveryEvent[]; head: RecoveryHead }>;
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function recoveryScope(manifest: Manifest): string {
  parseManifest(manifest);
  // Match the repository/environment workflow lock; renamed resources cannot escape it.
  return fingerprint({ repository: REPOSITORY, environment: manifest.environment });
}
function head(event: RecoveryEvent): RecoveryHead {
  return {
    scopeId: event.scopeId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    hash: event.hash,
  };
}
export function parseRecoveryEvent(
  value: unknown,
  manifest: Manifest,
  attemptId: string,
): RecoveryEvent {
  requireRelease(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_RECOVERY_EVENT',
  );
  const e = value as RecoveryEvent;
  requireRelease(
    Object.keys(e).sort().join(',') ===
      'schemaVersion,scopeId,attemptId,manifestId,environment,sourceCommit,sequence,previousHash,kind,record,approval,hash'
        .split(',')
        .sort()
        .join(','),
    'UNEXPECTED_RECOVERY_FIELDS',
  );
  requireRelease(
    e.schemaVersion === 1 &&
      e.scopeId === recoveryScope(manifest) &&
      e.attemptId === attemptId &&
      UUID.test(e.attemptId) &&
      e.manifestId === manifest.id &&
      e.environment === manifest.environment &&
      e.sourceCommit === manifest.sourceCommit &&
      Number.isSafeInteger(e.sequence) &&
      e.sequence >= 0 &&
      (e.previousHash === null || HASH.test(e.previousHash)) &&
      ['START', 'CHECKPOINT', 'APPROVAL_CHECKED', 'APPROVAL_REJECTED'].includes(e.kind),
    'RECOVERY_SCOPE_OR_SEQUENCE_MISMATCH',
  );
  parseRecord(e.record, manifest);
  if (e.approval !== null) {
    const a = e.approval;
    requireRelease(
      a &&
        typeof a === 'object' &&
        Object.keys(a).sort().join(',') === 'approvalId,decision,digest,purpose' &&
        UUID.test(a.approvalId) &&
        HASH.test(a.digest) &&
        ['publication', 'acceptance'].includes(a.purpose) &&
        ['AUTHORIZE', 'ACCEPT', 'REJECT'].includes(a.decision),
      'INVALID_RECOVERY_APPROVAL',
    );
  }
  requireRelease(
    (e.kind === 'APPROVAL_CHECKED' || e.kind === 'APPROVAL_REJECTED') === (e.approval !== null),
    'INVALID_RECOVERY_APPROVAL',
  );
  requireRelease(
    e.approval === null ||
      (e.kind === 'APPROVAL_REJECTED'
        ? e.approval.decision === 'REJECT'
        : e.approval.decision === (e.approval.purpose === 'publication' ? 'AUTHORIZE' : 'ACCEPT')),
    'INVALID_RECOVERY_APPROVAL',
  );
  const { hash, ...payload } = e;
  requireRelease(HASH.test(hash) && hash === fingerprint(payload), 'RECOVERY_EVENT_TAMPERED');
  return structuredClone(e);
}
/** Integrity only. The caller's independent anchor is not authenticated by hashing. */
export function inspectRecovery(
  manifest: Manifest,
  attemptId: string,
  values: unknown[],
  anchor: RecoveryHead,
) {
  parseManifest(manifest);
  requireRelease(anchor && values.length > 0 && values.length <= 10000, 'RECOVERY_ANCHOR_REQUIRED');
  const events = values.map((value) => parseRecoveryEvent(value, manifest, attemptId));
  const approvals = new Set<string>();
  for (const [index, event] of events.entries()) {
    requireRelease(
      event.sequence === index && event.previousHash === (index ? events[index - 1]!.hash : null),
      'RECOVERY_HISTORY_GAP_OR_REPLAY',
    );
    requireRelease(
      index
        ? event.kind !== 'START'
        : event.kind === 'START' &&
            event.record.sequence === 0 &&
            event.record.state === 'PREPARED',
      'INVALID_RECOVERY_START',
    );
    if (index) {
      const previous = events[index - 1]!;
      requireRelease(
        event.kind === 'CHECKPOINT'
          ? event.record.sequence === previous.record.sequence + 1
          : sameContent(event.record, previous.record),
        'RECOVERY_SNAPSHOT_SEQUENCE_MISMATCH',
      );
    }
    if (event.approval) {
      requireRelease(!approvals.has(event.approval.approvalId), 'RECOVERY_APPROVAL_REPLAY');
      approvals.add(event.approval.approvalId);
    }
  }
  requireRelease(sameContent(head(events.at(-1)!), anchor), 'RECOVERY_HEAD_MISMATCH');
  return {
    events,
    head: head(events.at(-1)!),
    record: structuredClone(events.at(-1)!.record),
    disposition: events.some((e) => e.kind === 'APPROVAL_REJECTED')
      ? 'REJECTED'
      : 'RECONCILIATION_REQUIRED',
    integrityVerified: true,
    authenticated: false,
    offRunDurable: false,
    releaseAccepted: false,
    productionApproved: false,
    publicationEnabled: false,
  };
}
export class RecoveryLog implements ReleaseEvidenceSink {
  private cursor: RecoveryHead | null = null;
  private record: ReleaseRecord | null = null;
  private publication: CheckedApproval | null = null;
  private publicationApprover: string | null = null;
  private acceptance: CheckedApproval | null = null;
  private rejected = false;
  private busy = false;
  constructor(
    private readonly store: RecoveryStore,
    private readonly manifest: Manifest,
    readonly attemptId: string,
  ) {
    parseManifest(manifest);
    requireRelease(UUID.test(attemptId), 'INVALID_RELEASE_ATTEMPT');
    this.manifest = structuredClone(manifest);
  }
  static async recover(
    store: RecoveryStore,
    manifest: Manifest,
    attemptId: string,
    anchor: RecoveryHead,
  ) {
    let snapshot: Awaited<ReturnType<RecoveryStore['read']>>;
    try {
      snapshot = await store.read(recoveryScope(manifest), attemptId);
    } catch {
      throw new ReleaseError('RECOVERY_READ_FAILED_UNVERIFIED');
    }
    requireRelease(sameContent(snapshot.head, anchor), 'RECOVERY_HEAD_MISMATCH');
    // Inspection deliberately returns no restored approval capability or mutation operation.
    return inspectRecovery(manifest, attemptId, snapshot.events, anchor);
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    requireRelease(!this.busy, 'CONCURRENT_RECOVERY_OPERATION');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private async append(
    kind: RecoveryEvent['kind'],
    record: ReleaseRecord,
    approval: RecoveryEvent['approval'],
  ) {
    const payload: Omit<RecoveryEvent, 'hash'> = {
      schemaVersion: 1,
      scopeId: recoveryScope(this.manifest),
      attemptId: this.attemptId,
      manifestId: this.manifest.id,
      environment: this.manifest.environment,
      sourceCommit: this.manifest.sourceCommit,
      sequence: this.cursor ? this.cursor.sequence + 1 : 0,
      previousHash: this.cursor?.hash ?? null,
      kind,
      record: structuredClone(record),
      approval,
    };
    const event = parseRecoveryEvent(
      { ...payload, hash: fingerprint(payload) },
      this.manifest,
      this.attemptId,
    );
    let receipt: RecoveryHead;
    try {
      receipt = await this.store.append(event, this.cursor ? structuredClone(this.cursor) : null);
    } catch {
      throw new ReleaseError('RECOVERY_APPEND_FAILED_RECONCILE');
    }
    requireRelease(sameContent(receipt, head(event)), 'RECOVERY_RECEIPT_MISMATCH');
    this.cursor = structuredClone(receipt);
    this.record = structuredClone(record);
  }
  async checkpoint(value: ReleaseRecord): Promise<void> {
    await this.exclusive(async () => {
      const record = parseRecord(structuredClone(value), this.manifest);
      requireRelease(
        this.store.scope !== 'offline-fixture' || record.scope !== 'hosted-observation',
        'OFFLINE_RECOVERY_CANNOT_CONFIRM_PROVIDER',
      );
      requireRelease(
        record.scope !== 'hosted-observation',
        'HOSTED_RECOVERY_READBACK_NOT_CONFIGURED',
      );
      if (!this.record) {
        requireRelease(
          record.sequence === 0 && record.state === 'PREPARED',
          'INVALID_RECOVERY_START',
        );
        await this.append('START', record, null);
        return;
      }
      requireRelease(!this.rejected, 'RELEASE_APPROVAL_REJECTED');
      requireRelease(
        record.sequence === this.record.sequence + 1,
        'RECOVERY_SNAPSHOT_SEQUENCE_MISMATCH',
      );
      requireRelease(this.record.failure === null, 'INCOMPLETE_RECOVERY_CANNOT_ADVANCE');
      const nextPhase: Partial<Record<ReleaseRecord['phase'], ReleaseRecord['phase']>> = {
        prepared: 'preflight',
        preflight: 'worker-intent',
        'worker-intent': 'worker-confirmed',
        'worker-confirmed': 'pages-intent',
        'pages-intent': 'pages-confirmed',
        'pages-confirmed': 'readiness',
        readiness: 'published',
        published: 'acceptance',
      };
      requireRelease(
        record.failure !== null
          ? record.state === 'INCOMPLETE' && record.phase === this.record.phase
          : record.phase === nextPhase[this.record.phase],
        'UNSUPPORTED_RECOVERY_TRANSITION',
      );
      if (record.phase === 'worker-intent' && record.failure === null) {
        requireRelease(this.publication, 'PUBLICATION_APPROVAL_REQUIRED');
        const claim = await recheckApproval(this.publication);
        requireRelease(claim.decision === 'AUTHORIZE', 'RELEASE_APPROVAL_REJECTED');
      }
      if (record.phase === 'acceptance') {
        requireRelease(
          this.record.state === 'PUBLISHED' && this.acceptance,
          'ACCEPTANCE_APPROVAL_REQUIRED',
        );
        const claim = await recheckApproval(this.acceptance);
        requireRelease(
          claim.recordSha256 === fingerprint(this.record) &&
            record.acceptance?.operator === `github-user-${claim.approverId}` &&
            record.acceptance.decidedAt === claim.issuedAt &&
            sameContent(record.acceptance.evidence, claim.evidence) &&
            record.acceptance.decision === claim.decision,
          'ACCEPTANCE_EVIDENCE_MISMATCH',
        );
      }
      await this.append('CHECKPOINT', record, null);
    });
  }
  async consume(check: CheckedApproval): Promise<void> {
    await this.exclusive(async () => {
      requireRelease(this.record && !this.rejected, 'RECOVERY_ATTEMPT_REQUIRED');
      const claim = await recheckApproval(check, true);
      requireRelease(
        claim.manifestId === this.manifest.id &&
          claim.environment === this.manifest.environment &&
          claim.sourceCommit === this.manifest.sourceCommit &&
          claim.attemptId === this.attemptId &&
          claim.recordSha256 === fingerprint(this.record),
        'APPROVAL_RELEASE_MISMATCH',
      );
      if (claim.purpose === 'publication')
        requireRelease(
          this.record.state === 'PREPARED' && !this.publication,
          'PUBLICATION_APPROVAL_ALREADY_RECORDED',
        );
      else
        requireRelease(
          this.record.state === 'PUBLISHED' &&
            this.publication &&
            !this.acceptance &&
            this.publicationApprover !== claim.approverId,
          'ACCEPTANCE_APPROVAL_REQUIRED',
        );
      await this.append(
        claim.decision === 'REJECT' ? 'APPROVAL_REJECTED' : 'APPROVAL_CHECKED',
        this.record,
        {
          approvalId: claim.approvalId,
          digest: fingerprint(claim),
          purpose: claim.purpose,
          decision: claim.decision,
        },
      );
      if (claim.decision === 'REJECT') this.rejected = true;
      else if (claim.purpose === 'publication') {
        this.publication = check;
        this.publicationApprover = claim.approverId;
      } else this.acceptance = check;
    });
  }
}
export function hostedRecoveryStore(): never {
  throw new ReleaseError('HOSTED_RECOVERY_STORE_NOT_CONFIGURED');
}
