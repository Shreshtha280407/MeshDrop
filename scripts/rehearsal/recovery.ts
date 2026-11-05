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
import type { RecoverySql, PsqlConfiguration } from '../deploy/postgres-connection';
import { exact, flags, HASH, parseArtifact, rehearsalScope, STATUS, UUID } from './contract';
import type { RehearsalArtifact } from './contract';
import { requireRehearsalVerification } from './verification';
import type { RehearsalVerification } from './verification';

export type RehearsalHead = { scopeId: string; attemptId: string; sequence: number; hash: string };
type RecordState = {
  schemaVersion: 1;
  purpose: 'trust-rehearsal';
  state: 'PREPARED';
  phase: 'RESERVED' | 'EVIDENCE' | 'CLOSED';
  sequence: number;
  artifactId: string;
  evidenceId: string | null;
  publicationEnabled: false;
  acceptanceEnabled: false;
  productionApproved: false;
};
export type RehearsalEvent = {
  schemaVersion: 1;
  scopeId: string;
  attemptId: string;
  manifestId: string;
  environment: string;
  sourceCommit: string;
  sequence: number;
  previousHash: string | null;
  kind: 'START' | 'CHECKPOINT';
  record: RecordState;
  approval: null;
  hash: string;
};
export type RehearsalDatabase = PsqlConfiguration & {
  storeId: string;
  environment: RehearsalArtifact['environment'];
  attemptId: string;
  caSha256: string;
  psqlSha256: string;
};
const modes = new WeakSet<object>();
const phases = ['RESERVED', 'EVIDENCE', 'CLOSED'] as const;
export function parseEvent(value: unknown, artifact: RehearsalArtifact): RehearsalEvent {
  const e = exact(
    value,
    'schemaVersion,scopeId,attemptId,manifestId,environment,sourceCommit,sequence,previousHash,kind,record,approval,hash',
  );
  requireRelease(
    e.schemaVersion === 1 &&
      e.scopeId === rehearsalScope(artifact) &&
      e.attemptId === artifact.rehearsalId &&
      e.manifestId === artifact.artifactId &&
      e.environment === artifact.environment &&
      e.sourceCommit === artifact.sourceCommit &&
      Number.isSafeInteger(e.sequence) &&
      Number(e.sequence) >= 0 &&
      Number(e.sequence) <= 2 &&
      e.kind === (e.sequence === 0 ? 'START' : 'CHECKPOINT') &&
      e.approval === null &&
      (e.previousHash === null ||
        (typeof e.previousHash === 'string' && HASH.test(e.previousHash))),
    'INVALID_REHEARSAL_EVENT',
  );
  const r = exact(
    e.record,
    'schemaVersion,purpose,state,phase,sequence,artifactId,evidenceId,publicationEnabled,acceptanceEnabled,productionApproved',
  );
  flags(r);
  requireRelease(
    r.schemaVersion === 1 &&
      r.purpose === 'trust-rehearsal' &&
      r.state === 'PREPARED' &&
      r.phase === phases[Number(e.sequence)] &&
      r.sequence === e.sequence &&
      r.artifactId === artifact.artifactId &&
      r.evidenceId === (e.sequence === 1 ? artifact.rehearsalId : null),
    'INVALID_REHEARSAL_RECORD_OR_REPLAY',
  );
  const { hash, ...payload } = e;
  requireRelease(hash === fingerprint(payload), 'REHEARSAL_EVENT_TAMPERED');
  return structuredClone(e) as RehearsalEvent;
}
export function inspectHistory(
  artifact: RehearsalArtifact,
  values: unknown,
  anchor: RehearsalHead,
) {
  parseArtifact(artifact);
  requireRelease(
    Array.isArray(values) && values.length > 0 && values.length <= 3,
    'REHEARSAL_HISTORY_MISSING_OR_REPLAYED',
  );
  const events = values.map((v) => parseEvent(v, artifact));
  for (const [i, e] of events.entries())
    requireRelease(
      e.sequence === i && e.previousHash === (i ? events[i - 1]!.hash : null),
      'REHEARSAL_HISTORY_GAP_OR_REPLAY',
    );
  const last = events.at(-1)!;
  const head = {
    scopeId: last.scopeId,
    attemptId: last.attemptId,
    sequence: last.sequence,
    hash: last.hash,
  };
  requireRelease(sameContent(head, anchor), 'REHEARSAL_HEAD_MISMATCH');
  return {
    events,
    head,
    integrityVerified: true as const,
    complete: events.length === 3,
    independentWitnessVerified: false as const,
    publicationEnabled: false as const,
    acceptanceEnabled: false as const,
    productionApproved: false as const,
  };
}
function textSql(value: string) {
  return `convert_from(decode('${Buffer.from(value).toString('hex')}','hex'),'UTF8')`;
}
function json(value: unknown) {
  return `convert_from(decode('${Buffer.from(canonical(value)).toString('hex')}','hex'),'UTF8')`;
}
export function parseDatabase(value: unknown, artifact: RehearsalArtifact): RehearsalDatabase {
  const c = exact(
    value,
    'executable,host,port,database,user,caFile,passwordFile,storeId,environment,attemptId,caSha256,psqlSha256',
  );
  new PsqlRecoveryConnection(c as PsqlConfiguration);
  requireRelease(
    typeof c.storeId === 'string' &&
      UUID.test(c.storeId) &&
      c.environment === artifact.environment &&
      c.attemptId === artifact.rehearsalId &&
      typeof c.caSha256 === 'string' &&
      HASH.test(c.caSha256) &&
      typeof c.psqlSha256 === 'string' &&
      HASH.test(c.psqlSha256),
    'REHEARSAL_DATABASE_SCOPE_UNVERIFIED',
  );
  return structuredClone(c) as RehearsalDatabase;
}
/** Injection always remains an offline fixture, including an injected true TLS response. */
export class RehearsalJournal {
  readonly #artifact: RehearsalArtifact;
  readonly #config: RehearsalDatabase;
  private busy = false;
  constructor(
    artifact: RehearsalArtifact,
    config: RehearsalDatabase,
    private readonly connection: RecoverySql,
  ) {
    this.#artifact = parseArtifact(artifact);
    this.#config = parseDatabase(config, artifact);
  }
  private async query(sql: string) {
    const c = this.#config;
    // Every operation checks this same session before touching the journal.
    const guard = `DO $rehearsal$ BEGIN IF current_database()<>${textSql(c.database)} OR session_user<>${textSql(c.user)} OR pg_is_in_recovery() OR NOT coalesce((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),false) THEN RAISE EXCEPTION 'REHEARSAL_TLS_OR_DATABASE_UNVERIFIED'; END IF; END $rehearsal$;\n`;
    try {
      const text = await this.connection.execute(guard + sql);
      requireRelease(Buffer.byteLength(text) <= 65536, 'REHEARSAL_DATABASE_RESPONSE_LIMIT');
      const reply = JSON.parse(text);
      requireRelease(reply?.storeId === c.storeId, 'REHEARSAL_STORE_IDENTITY_MISMATCH');
      return reply;
    } catch (error) {
      throw error instanceof ReleaseError
        ? error
        : new ReleaseError('REHEARSAL_DATABASE_FAILED_RECONCILE');
    }
  }
  async read(anchor: RehearsalHead) {
    const a = this.#artifact;
    const result = await this.query(
      `SELECT meshdrop_recovery.read_history('${this.#config.storeId}'::uuid,'${rehearsalScope(a)}','${a.rehearsalId}'::uuid);`,
    );
    requireRelease(sameContent(result.head, anchor), 'REHEARSAL_HEAD_MISMATCH');
    return inspectHistory(a, result.events, anchor);
  }
  async run() {
    requireRelease(!this.busy, 'CONCURRENT_REHEARSAL_CALL');
    this.busy = true;
    try {
      const a = this.#artifact;
      let head: RehearsalHead | null = null;
      for (const [sequence, phase] of phases.entries()) {
        const record: RecordState = {
          schemaVersion: 1,
          purpose: 'trust-rehearsal',
          state: 'PREPARED',
          phase,
          sequence,
          artifactId: a.artifactId,
          evidenceId: sequence === 1 ? a.rehearsalId : null,
          publicationEnabled: false,
          acceptanceEnabled: false,
          productionApproved: false,
        };
        const payload = {
          schemaVersion: 1 as const,
          scopeId: rehearsalScope(a),
          attemptId: a.rehearsalId,
          manifestId: a.artifactId,
          environment: a.environment,
          sourceCommit: a.sourceCommit,
          sequence,
          previousHash: head?.hash ?? null,
          kind: sequence === 0 ? ('START' as const) : ('CHECKPOINT' as const),
          record,
          approval: null,
        };
        const event = parseEvent({ ...payload, hash: fingerprint(payload) }, a);
        const next = {
          scopeId: event.scopeId,
          attemptId: event.attemptId,
          sequence,
          hash: event.hash,
        };
        const reply = await this.query(
          `SELECT meshdrop_recovery.append_event('${this.#config.storeId}'::uuid,${json(event)},${json(payload)},${head ? `${json(head)}::jsonb` : 'NULL'});`,
        );
        requireRelease(sameContent(reply.head, next), 'REHEARSAL_RECEIPT_MISMATCH');
        head = next;
      }
      requireRelease(head, 'REHEARSAL_HEAD_MISSING');
      const checked = await this.read(head);
      requireRelease(checked.complete, 'REHEARSAL_INCOMPLETE');
      return {
        status: STATUS,
        scope: modes.has(this) ? ('github-rehearsal' as const) : ('offline-fixture' as const),
        repository: a.repository,
        repositoryId: a.repositoryId,
        ownerId: a.ownerId,
        environment: a.environment,
        sourceCommit: a.sourceCommit,
        runId: a.runId,
        runAttempt: a.runAttempt,
        rehearsalId: a.rehearsalId,
        artifactId: a.artifactId,
        storeId: this.#config.storeId,
        head,
        eventCount: checked.events.length,
        tlsValidated: true,
        replayCheck: 'NOT_RUN' as const,
        concurrencyCheck: 'NOT_RUN' as const,
        independentWitnessVerified: false as const,
        authorizationVerified: false as const,
        unresolved: [
          'HUMAN_RELEASE_AUTHORIZATION',
          'INDEPENDENT_LATEST_HEAD',
          'HOSTED_DISASTER_DURABILITY',
        ],
        publicationEnabled: false as const,
        acceptanceEnabled: false as const,
        productionApproved: false as const,
        events: checked.events,
      };
    } finally {
      this.busy = false;
    }
  }
}
export async function createHostedJournal(
  artifact: RehearsalArtifact,
  verification: RehearsalVerification,
  value: unknown,
) {
  requireRehearsalVerification(verification, artifact);
  const c = parseDatabase(value, artifact);
  const [ca, password, binary] = await Promise.all([
    lstat(c.caFile),
    lstat(c.passwordFile),
    lstat(c.executable),
  ]);
  requireRelease(
    ca.isFile() &&
      password.isFile() &&
      !(password.mode & 0o077) &&
      binary.isFile() &&
      !(binary.mode & 0o022),
    'UNSAFE_REHEARSAL_CREDENTIAL_FILES',
  );
  requireRelease(
    bytesHash(await readFile(c.caFile)) === c.caSha256 &&
      bytesHash(await readFile(c.executable)) === c.psqlSha256,
    'REHEARSAL_CLIENT_OR_CA_MISMATCH',
  );
  const journal = new RehearsalJournal(artifact, c, new PsqlRecoveryConnection(c));
  modes.add(journal);
  return journal;
}
