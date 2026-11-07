import { lstat, readFile } from 'node:fs/promises';
import {
  bytesHash,
  canonical,
  fingerprint,
  requireRelease,
  ReleaseError,
  sameContent,
} from '../deploy/release-record';
import { PsqlRecoveryConnection } from '../deploy/postgres-connection';
import type { RecoverySql } from '../deploy/postgres-connection';
import { exact, parseArtifact, ID, UUID } from './contract';
import type { RehearsalArtifact } from './contract';
import type { RehearsalHead } from './recovery';
import { requireRehearsalVerification } from './verification';
import type { RehearsalVerification } from './verification';
import {
  eventHead,
  faultMode,
  inspectFaultHistory,
  makeFaultEvent,
  parseFaultTarget,
} from './fault-contract';
import type { FaultEvent, FaultMode, FaultTarget } from './fault-contract';

type Role = 'writer' | 'reader';
export type FaultConnections = (role: Role) => RecoverySql;
const hosted = new WeakSet<object>();
const REJECTIONS = [
  'ENVIRONMENT_ALREADY_OWNED',
  'ENVIRONMENT_OWNERSHIP_CONFLICT',
  'HEAD_CONFLICT',
  'INVALID_START',
  'DUPLICATE_RECOVERY_IDENTIFIER',
  'FAULT_INVALID_RECORD',
];
function text(value: string) {
  return `convert_from(decode('${Buffer.from(value).toString('hex')}','hex'),'UTF8')`;
}
function json(value: unknown) {
  return text(canonical(value));
}

/** A stateless client. Each execute starts/exits a distinct psql process/session.
 * It never caches journal state or retries a statement. */
export class FaultClient {
  constructor(
    private readonly target: FaultTarget,
    private readonly identity: Pick<RehearsalArtifact, 'repositoryId' | 'ownerId'>,
    private readonly connection: RecoverySql,
    private readonly role: Role,
  ) {
    this.target = parseFaultTarget(target, { environment: 'preview' });
    requireRelease(
      ID.test(identity.repositoryId) && ID.test(identity.ownerId),
      'FAULT_REPOSITORY_PINS_REQUIRED',
    );
  }
  private args() {
    return `'${this.target.storeId}'::uuid,${text(this.target.environmentId)},${text(this.identity.repositoryId)},${text(this.identity.ownerId)}`;
  }
  private async query(sql: string) {
    const user = this.role === 'writer' ? this.target.user : this.target.readerUser;
    const guard = `DO $fault$ BEGIN IF current_database()<>${text(this.target.database)} OR session_user<>${text(user)} THEN RAISE EXCEPTION 'FAULT_SESSION_IDENTITY_MISMATCH'; END IF; END $fault$;\n`;
    try {
      const result = await this.connection.execute(guard + sql);
      requireRelease(Buffer.byteLength(result) <= 131072, 'FAULT_RESPONSE_LIMIT');
      const parsed = JSON.parse(result);
      requireRelease(parsed?.storeId === this.target.storeId, 'FAULT_HISTORY_WRONG_STORE');
      return parsed;
    } catch (error) {
      throw error instanceof ReleaseError
        ? error
        : new ReleaseError('FAULT_DATABASE_UNAVAILABLE_RECONCILE');
    }
  }
  async marker() {
    const m = await this.query(`SELECT meshdrop_rehearsal.check_store(${this.args()});`);
    exact(m, 'storeId,environmentId,repositoryId,ownerId,purpose,environment,database,tls');
    requireRelease(
      m.environmentId === this.target.environmentId &&
        m.repositoryId === this.identity.repositoryId &&
        m.ownerId === this.identity.ownerId &&
        m.purpose === 'fault-test-only' &&
        m.environment === 'preview' &&
        m.database === this.target.database &&
        m.tls === true,
      'FAULT_STORE_ISOLATION_UNVERIFIED',
    );
  }
  private appendSql(event: FaultEvent, expected: RehearsalHead | null) {
    const { hash, ...payload } = event;
    requireRelease(hash === fingerprint(payload), 'FAULT_PROPOSAL_MODIFIED');
    return `SELECT meshdrop_rehearsal.append_probe(${this.args()},${json(event)},${json(payload)},${expected ? json(expected) + '::jsonb' : 'NULL'});`;
  }
  async append(event: FaultEvent, expected: RehearsalHead | null) {
    requireRelease(this.role === 'writer', 'FAULT_READER_CANNOT_APPEND');
    const reply = await this.query(this.appendSql(event, expected));
    if (reply.outcome === 'APPENDED') {
      exact(reply, 'storeId,head,outcome');
      requireRelease(sameContent(reply.head, eventHead(event)), 'FAULT_RECEIPT_MISMATCH');
      return { outcome: 'APPENDED' as const, head: eventHead(event) };
    }
    exact(reply, 'storeId,outcome,code');
    requireRelease(
      reply.outcome === 'REJECTED' && REJECTIONS.includes(reply.code),
      'FAULT_UNCONFIRMED_REJECTION',
    );
    return { outcome: 'REJECTED' as const, code: reply.code as string };
  }
  /** Controlled boundary AFTER the SQL process succeeded/committed. The writer
   * discards stdout; no application receipt or head is returned to the caller. */
  async appendWithoutAcknowledgement(event: FaultEvent, expected: RehearsalHead) {
    requireRelease(
      this.role === 'writer' && event.record.mode === 'lost-ack',
      'FAULT_ACK_DROP_FORBIDDEN',
    );
    await this.connection.execute(this.appendSql(event, expected));
    // No parse, receipt, head update or retry. The psql writer process has exited.
  }
  async discover(mode: FaultMode, attemptId: string) {
    requireRelease(UUID.test(attemptId), 'FAULT_HISTORY_WRONG_ATTEMPT');
    const raw = await this.query(
      `SELECT meshdrop_rehearsal.read_attempt(${this.args()},${text(faultMode(mode))},'${attemptId}'::uuid);`,
    );
    return { raw, ...inspectFaultHistory(raw, this.target.storeId, mode, attemptId) };
  }
}
function rehash(event: FaultEvent): FaultEvent {
  const { hash, ...payload } = event;
  void hash;
  return { ...payload, hash: fingerprint(payload) };
}

export class FaultHarness {
  readonly #artifact: RehearsalArtifact;
  readonly #target: FaultTarget;
  constructor(
    artifact: RehearsalArtifact,
    target: FaultTarget,
    private readonly connections: FaultConnections,
  ) {
    this.#artifact = parseArtifact(artifact);
    this.#target = parseFaultTarget(target, this.#artifact);
  }
  private client(role: Role) {
    return new FaultClient(this.#target, this.#artifact, this.connections(role), role);
  }
  private async accepted(event: FaultEvent, head: RehearsalHead | null) {
    const reply = await this.client('writer').append(event, head);
    requireRelease(reply.outcome === 'APPENDED', 'FAULT_INITIAL_APPEND_REJECTED_RECONCILE');
    return reply.head;
  }
  private async rejected(event: FaultEvent, head: RehearsalHead | null, codes: string[]) {
    const reply = await this.client('writer').append(event, head);
    requireRelease(
      reply.outcome === 'REJECTED' && codes.includes(reply.code),
      'FAULT_REPLAY_WAS_NOT_REJECTED',
    );
    return reply.code;
  }
  private async read(mode: FaultMode, attemptId: string, anchor?: RehearsalHead) {
    // Reader starts from store/scope/attempt only; artifact/chain comes from SQL.
    const read = await this.client('reader').discover(mode, attemptId);
    requireRelease(sameContent(read.artifact, this.#artifact), 'FAULT_DURABLE_ARTIFACT_MISMATCH');
    if (anchor) requireRelease(sameContent(read.head, anchor), 'FAULT_HISTORY_STALE_HEAD');
    return read;
  }
  async run(mode: FaultMode) {
    faultMode(mode);
    await this.client('writer').marker();
    await this.client('reader').marker();
    const a = this.#artifact;
    const start = makeFaultEvent(a, mode, 0, 0, null),
      attemptId = start.attemptId;
    const checks: Record<string, unknown> = {};
    let head: RehearsalHead;
    let finalAttempt = attemptId;
    if (mode === 'concurrency') {
      const other = makeFaultEvent(a, mode, 1, 0, null);
      // Independent execute calls => independent client processes and server transactions.
      const settled = await Promise.allSettled([
        this.client('writer').append(start, null),
        this.client('writer').append(other, null),
      ]);
      // A failed transport must not leave the competing writer running while
      // the caller starts reconciliation. Join both child sessions first.
      const outcomes = settled.map((result) => {
        if (result.status === 'rejected')
          throw new ReleaseError('FAULT_DATABASE_UNAVAILABLE_RECONCILE');
        return result.value;
      });
      const winner = outcomes.findIndex((v) => v.outcome === 'APPENDED');
      requireRelease(
        outcomes.filter((v) => v.outcome === 'APPENDED').length === 1 &&
          outcomes.filter((v) => v.outcome === 'REJECTED' && v.code === 'ENVIRONMENT_ALREADY_OWNED')
            .length === 1,
        'FAULT_CONCURRENCY_SPLIT_BRAIN_OR_UNCONFIRMED',
      );
      const winning = winner === 0 ? start : other,
        losing = winner === 0 ? other : start;
      head = eventHead(winning);
      finalAttempt = winning.attemptId;
      const evidence = makeFaultEvent(a, mode, winning.record.writer, 1, head.hash);
      await this.rejected(makeFaultEvent(a, mode, losing.record.writer, 1, head.hash), head, [
        'ENVIRONMENT_OWNERSHIP_CONFLICT',
      ]);
      await this.rejected(losing, null, ['ENVIRONMENT_ALREADY_OWNED']);
      head = await this.accepted(evidence, head);
      head = await this.accepted(
        makeFaultEvent(a, mode, winning.record.writer, 2, head.hash),
        head,
      );
      await this.read(mode, winning.attemptId, head);
      Object.assign(checks, {
        winnerCount: 1,
        loserCount: 1,
        splitBrain: false,
        loserAttemptId: losing.attemptId,
      });
    } else {
      head = await this.accepted(start, null);
      const proposed = makeFaultEvent(a, mode, 0, 1, head.hash);
      if (mode === 'lost-ack') {
        // The proposed head is saved BEFORE mutation; it is not an acknowledged head.
        const proposedHead = eventHead(proposed);
        await this.client('writer').appendWithoutAcknowledgement(proposed, head);
        // The writer is discarded. A fresh reader process independently reconciles.
        const reconciled = await this.read(mode, attemptId);
        requireRelease(
          sameContent(reconciled.head, proposedHead) && reconciled.events.length === 2,
          'FAULT_LOST_ACK_NOT_RECONCILED',
        );
        head = reconciled.head;
        Object.assign(checks, {
          reconciliationRequired: true,
          blindRetryPerformed: false,
          acknowledgementSuppressed: true,
          boundary: 'after-psql-exit-before-harness-ack',
          proposedEventCommitted: true,
        });
      } else {
        const reserved = head;
        head = await this.accepted(proposed, head);
        if (mode === 'replay') {
          const rejected = [];
          rejected.push(await this.rejected(start, null, ['ENVIRONMENT_ALREADY_OWNED']));
          rejected.push(await this.rejected(proposed, reserved, ['HEAD_CONFLICT']));
          rejected.push(
            await this.rejected(makeFaultEvent(a, mode, 0, 2, head.hash), reserved, [
              'HEAD_CONFLICT',
            ]),
          );
          const repeatEvidence = makeFaultEvent(a, mode, 0, 2, head.hash);
          repeatEvidence.record.evidenceId = attemptId;
          rejected.push(
            await this.rejected(rehash(repeatEvidence), head, ['FAULT_INVALID_RECORD']),
          );
          // Deliberately forged next-attempt claim, not a second verified attestation.
          const spoof = structuredClone(proposed);
          const { artifactId, ...identity } = spoof.record.artifact;
          void artifactId;
          identity.runAttempt++;
          spoof.record.artifact = { ...identity, artifactId: fingerprint(identity) };
          spoof.manifestId = spoof.record.artifact.artifactId;
          rejected.push(await this.rejected(rehash(spoof), head, ['HEAD_CONFLICT']));
          await this.read(mode, attemptId, head);
          Object.assign(checks, {
            rejectedProbes: rejected,
            crossAttemptProbe: 'forged-next-attempt-claim',
            approvalReplay: 'NOT_APPLICABLE_NULL_APPROVALS',
            eventOverwritten: false,
          });
        }
        if (mode === 'reconnect') {
          // Both writer psql processes have exited. No cached head is supplied.
          const restored = await this.client('reader').discover(mode, attemptId);
          requireRelease(
            restored.events.length === 2 &&
              restored.artifact.artifactId === a.artifactId &&
              sameContent(restored.head, head),
            'FAULT_RECONNECT_NOT_RECONCILED',
          );
          Object.assign(checks, {
            writerProcessExited: true,
            readerUsedCachedState: false,
            reconciliationRequired: true,
            automaticResumePerformed: false,
            blindRetryPerformed: false,
          });
        } else {
          head = await this.accepted(makeFaultEvent(a, mode, 0, 2, head.hash), head);
        }
      }
    }
    const final = await this.read(mode, finalAttempt, head);
    if (mode === 'history-integrity') {
      const probes: Record<string, (v: typeof final.raw) => void> = {
        missing: (v) => {
          v.events.splice(1, 1);
        },
        deleted: (v) => {
          v.events.splice(0, 1);
        },
        modified: (v) => {
          v.events[1].record.phase = 'CLOSED';
        },
        reordered: (v) => {
          v.events.reverse();
        },
        previousHash: (v) => {
          v.events[1].previousHash = '0'.repeat(64);
        },
        scope: (v) => {
          v.events[1].scopeId = '0'.repeat(64);
        },
        store: (v) => {
          v.storeId = '00000000-0000-4000-8000-000000000000';
        },
        attempt: (v) => {
          v.events[1].attemptId = '00000000-0000-4000-8000-000000000000';
        },
        staleAnchor: (v) => {
          v.head = eventHead(final.events[0]!);
        },
        duplicate: (v) => {
          v.events.splice(1, 0, structuredClone(v.events[1]));
        },
      };
      const codes: Record<string, string> = {};
      for (const [name, alter] of Object.entries(probes)) {
        const copy = structuredClone(final.raw);
        alter(copy);
        try {
          inspectFaultHistory(copy, this.#target.storeId, mode, finalAttempt, head);
        } catch (error) {
          if (error instanceof ReleaseError) codes[name] = error.code;
          else throw error;
        }
        requireRelease(
          codes[name]?.startsWith('FAULT_HISTORY_'),
          'FAULT_INTEGRITY_PROBE_NOT_REJECTED',
        );
      }
      Object.assign(checks, {
        rejectedProbes: codes,
        injection: 'reader-input-copy-only',
        databaseHistoryModified: false,
      });
      await this.read(mode, finalAttempt, head);
    }
    const payload = {
      schemaVersion: 1,
      purpose: 'trust-rehearsal-fault-test',
      scope: hosted.has(this) ? 'github-rehearsal' : 'offline-fixture',
      mode,
      status: 'PASS',
      repository: a.repository,
      repositoryId: a.repositoryId,
      ownerId: a.ownerId,
      environment: 'preview',
      environmentId: this.#target.environmentId,
      sourceCommit: a.sourceCommit,
      sourceRef: a.sourceRef,
      artifactId: a.artifactId,
      rehearsalId: a.rehearsalId,
      runId: a.runId,
      runAttempt: a.runAttempt,
      storeId: this.#target.storeId,
      recoveryAttemptId: finalAttempt,
      head,
      eventCount: final.events.length,
      checks,
      events: final.events,
      tlsValidated: true,
      independentWitnessVerified: false,
      humanAuthorizationVerified: false,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    };
    return { ...payload, resultDigest: fingerprint(payload) };
  }
}

export async function createHostedFaultHarness(
  artifact: RehearsalArtifact,
  proof: RehearsalVerification,
  target: FaultTarget,
) {
  // No injected transport or serialized success flag can enter hosted mode.
  requireRehearsalVerification(proof, artifact);
  const t = parseFaultTarget(target, artifact);
  const files = await Promise.all(
    [t.caFile, t.passwordFile, t.readerPasswordFile, t.executable].map((p) => lstat(p)),
  );
  requireRelease(
    files.every((s) => s.isFile()) &&
      !(files[1]!.mode & 0o077) &&
      !(files[2]!.mode & 0o077) &&
      !(files[3]!.mode & 0o022),
    'UNSAFE_FAULT_CREDENTIAL_FILES',
  );
  requireRelease(
    bytesHash(await readFile(t.caFile)) === t.caSha256 &&
      bytesHash(await readFile(t.executable)) === t.psqlSha256,
    'FAULT_CLIENT_OR_CA_MISMATCH',
  );
  const harness = new FaultHarness(
    artifact,
    t,
    (role) =>
      new PsqlRecoveryConnection({
        ...t,
        user: role === 'writer' ? t.user : t.readerUser,
        passwordFile: role === 'writer' ? t.passwordFile : t.readerPasswordFile,
      }),
  );
  hosted.add(harness);
  return harness;
}
