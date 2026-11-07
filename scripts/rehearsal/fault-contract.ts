import { fingerprint, requireRelease, sameContent, REPOSITORY } from '../deploy/release-record';
import { PsqlRecoveryConnection } from '../deploy/postgres-connection';
import { exact, flags, HASH, ID, parseArtifact, UUID } from './contract';
import type { RehearsalArtifact } from './contract';
import type { RehearsalHead } from './recovery';

export const FAULT_MODES = [
  'replay',
  'concurrency',
  'lost-ack',
  'reconnect',
  'history-integrity',
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];
export type FaultCheck = 'PASS' | 'FAIL' | 'NOT_RUN';
export const CHECK_NAMES = [
  'replayCheck',
  'concurrencyCheck',
  'lostAckCheck',
  'reconnectCheck',
  'historyIntegrityCheck',
] as const;
export type FaultTarget = {
  mode: 'rehearsal-only';
  rehearsalOnly: true;
  environment: 'preview';
  environmentName: 'trust-rehearsal-preview';
  environmentId: string;
  expectedEnvironmentId: string;
  production: { environmentId: string | null; database: string | null; storeId: string | null };
  executable: string;
  host: string;
  port: number;
  database: string;
  user: string;
  readerUser: string;
  caFile: string;
  passwordFile: string;
  readerPasswordFile: string;
  storeId: string;
  caSha256: string;
  psqlSha256: string;
};
export function faultMode(value: unknown): FaultMode {
  requireRelease(FAULT_MODES.includes(value as FaultMode), 'INVALID_REHEARSAL_FAULT_MODE');
  return value as FaultMode;
}
export function faultScope(mode: FaultMode) {
  faultMode(mode);
  return fingerprint({
    repository: REPOSITORY,
    environment: 'preview',
    purpose: 'trust-rehearsal-fault-test',
    mode,
  });
}
export function parseFaultTarget(
  value: unknown,
  identity: Pick<RehearsalArtifact, 'environment'>,
): FaultTarget {
  const t = exact(
    value,
    'mode,rehearsalOnly,environment,environmentName,environmentId,expectedEnvironmentId,production,executable,host,port,database,user,readerUser,caFile,passwordFile,readerPasswordFile,storeId,caSha256,psqlSha256',
  );
  requireRelease(
    identity.environment === 'preview' &&
      t.environment === 'preview' &&
      t.environmentName === 'trust-rehearsal-preview' &&
      t.mode === 'rehearsal-only' &&
      t.rehearsalOnly === true,
    'PRODUCTION_FAULT_TARGET_FORBIDDEN',
  );
  requireRelease(
    typeof t.environmentId === 'string' &&
      ID.test(t.environmentId) &&
      t.environmentId === t.expectedEnvironmentId,
    'FAULT_ENVIRONMENT_ID_MISMATCH',
  );
  const p = exact(t.production, 'environmentId,database,storeId');
  for (const k of ['environmentId', 'database', 'storeId'] as const)
    requireRelease(
      p[k] === null || (typeof p[k] === 'string' && p[k].length > 0),
      'INVALID_PRODUCTION_ISOLATION_PINS',
    );
  requireRelease(
    t.environmentId !== p.environmentId && t.database !== p.database && t.storeId !== p.storeId,
    'PRODUCTION_FAULT_TARGET_FORBIDDEN',
  );
  requireRelease(
    typeof t.database === 'string' &&
      /^meshdrop_rehearsal_[a-z0-9_]+$/.test(t.database) &&
      typeof t.storeId === 'string' &&
      UUID.test(t.storeId) &&
      typeof t.caSha256 === 'string' &&
      HASH.test(t.caSha256) &&
      typeof t.psqlSha256 === 'string' &&
      HASH.test(t.psqlSha256),
    'DEDICATED_REHEARSAL_DATABASE_REQUIRED',
  );
  requireRelease(
    typeof t.readerUser === 'string' &&
      t.readerUser !== t.user &&
      typeof t.readerPasswordFile === 'string' &&
      t.readerPasswordFile !== t.passwordFile,
    'SEPARATE_REHEARSAL_READER_REQUIRED',
  );
  new PsqlRecoveryConnection(t as FaultTarget);
  new PsqlRecoveryConnection({
    ...(t as FaultTarget),
    user: t.readerUser as string,
    passwordFile: t.readerPasswordFile as string,
  });
  return structuredClone(t) as FaultTarget;
}
/** Deterministic child UUID, never a provider identity or approval identifier. */
export function faultAttempt(artifact: RehearsalArtifact, mode: FaultMode, writer: 0 | 1) {
  parseArtifact(artifact);
  faultMode(mode);
  const h = fingerprint({ artifactId: artifact.artifactId, mode, writer });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export type FaultEvent = {
  schemaVersion: 1;
  scopeId: string;
  attemptId: string;
  manifestId: string;
  environment: 'preview';
  sourceCommit: string;
  sequence: number;
  previousHash: string | null;
  kind: 'START' | 'CHECKPOINT';
  record: {
    schemaVersion: 1;
    purpose: 'trust-rehearsal-fault-test';
    state: 'PREPARED';
    mode: FaultMode;
    writer: 0 | 1;
    artifact: RehearsalArtifact;
    sequence: number;
    phase: 'RESERVED' | 'EVIDENCE' | 'CLOSED';
    evidenceId: string | null;
    publicationEnabled: false;
    acceptanceEnabled: false;
    productionApproved: false;
  };
  approval: null;
  hash: string;
};
const phases = ['RESERVED', 'EVIDENCE', 'CLOSED'] as const;
export function makeFaultEvent(
  artifact: RehearsalArtifact,
  mode: FaultMode,
  writer: 0 | 1,
  sequence: number,
  previousHash: string | null,
): FaultEvent {
  const attemptId = faultAttempt(artifact, mode, writer);
  const payload = {
    schemaVersion: 1 as const,
    scopeId: faultScope(mode),
    attemptId,
    manifestId: artifact.artifactId,
    environment: 'preview' as const,
    sourceCommit: artifact.sourceCommit,
    sequence,
    previousHash,
    kind: sequence === 0 ? ('START' as const) : ('CHECKPOINT' as const),
    record: {
      schemaVersion: 1 as const,
      purpose: 'trust-rehearsal-fault-test' as const,
      state: 'PREPARED' as const,
      mode,
      writer,
      artifact,
      sequence,
      phase: phases[sequence]!,
      evidenceId: sequence === 1 ? attemptId : null,
      publicationEnabled: false as const,
      acceptanceEnabled: false as const,
      productionApproved: false as const,
    },
    approval: null,
  };
  return parseFaultEvent({ ...payload, hash: fingerprint(payload) });
}
export function parseFaultEvent(value: unknown): FaultEvent {
  const e = exact(
    value,
    'schemaVersion,scopeId,attemptId,manifestId,environment,sourceCommit,sequence,previousHash,kind,record,approval,hash',
  );
  const r = exact(
    e.record,
    'schemaVersion,purpose,state,mode,writer,artifact,sequence,phase,evidenceId,publicationEnabled,acceptanceEnabled,productionApproved',
  );
  flags(r);
  const a = parseArtifact(r.artifact),
    mode = faultMode(r.mode);
  requireRelease(
    a.environment === 'preview' && e.environment === 'preview' && e.scopeId === faultScope(mode),
    'FAULT_HISTORY_WRONG_SCOPE',
  );
  requireRelease(r.writer === 0 || r.writer === 1, 'FAULT_HISTORY_WRONG_WRITER');
  requireRelease(e.attemptId === faultAttempt(a, mode, r.writer), 'FAULT_HISTORY_WRONG_ATTEMPT');
  requireRelease(
    Number.isInteger(e.sequence) &&
      Number(e.sequence) >= 0 &&
      Number(e.sequence) <= 2 &&
      r.sequence === e.sequence &&
      r.phase === phases[Number(e.sequence)] &&
      r.evidenceId === (e.sequence === 1 ? e.attemptId : null),
    'FAULT_HISTORY_INVALID_SEQUENCE_OR_EVIDENCE',
  );
  requireRelease(
    e.schemaVersion === 1 &&
      r.schemaVersion === 1 &&
      r.purpose === 'trust-rehearsal-fault-test' &&
      r.state === 'PREPARED' &&
      e.manifestId === a.artifactId &&
      e.sourceCommit === a.sourceCommit &&
      e.approval === null &&
      e.kind === (e.sequence === 0 ? 'START' : 'CHECKPOINT'),
    'FAULT_HISTORY_IDENTITY_MISMATCH',
  );
  const { hash, ...payload } = e;
  requireRelease(hash === fingerprint(payload), 'FAULT_HISTORY_MODIFIED');
  return structuredClone(e) as FaultEvent;
}
export function eventHead(e: FaultEvent): RehearsalHead {
  return { scopeId: e.scopeId, attemptId: e.attemptId, sequence: e.sequence, hash: e.hash };
}
/** Discovery is integrity-only: no supplied history blob can authenticate its latest head. */
export function inspectFaultHistory(
  value: unknown,
  storeId: string,
  mode: FaultMode,
  attemptId: string,
  anchor?: RehearsalHead,
) {
  const h = exact(value, 'storeId,head,events');
  requireRelease(h.storeId === storeId, 'FAULT_HISTORY_WRONG_STORE');
  requireRelease(
    Array.isArray(h.events) && h.events.length >= 1 && h.events.length <= 3,
    'FAULT_HISTORY_MISSING_OR_DUPLICATED',
  );
  const events = h.events.map(parseFaultEvent);
  for (const [i, e] of events.entries()) {
    requireRelease(e.scopeId === faultScope(mode), 'FAULT_HISTORY_WRONG_SCOPE');
    requireRelease(e.attemptId === attemptId, 'FAULT_HISTORY_WRONG_ATTEMPT');
    requireRelease(
      e.sequence === i && e.previousHash === (i ? events[i - 1]!.hash : null),
      'FAULT_HISTORY_GAP_OR_ORDER',
    );
    requireRelease(
      sameContent(e.record.artifact, events[0]!.record.artifact),
      'FAULT_HISTORY_IDENTITY_MISMATCH',
    );
  }
  const head = eventHead(events.at(-1)!);
  requireRelease(
    sameContent(h.head, head) && (!anchor || sameContent(anchor, head)),
    'FAULT_HISTORY_STALE_HEAD',
  );
  return {
    events,
    head,
    artifact: events[0]!.record.artifact,
    complete: events.length === 3,
    independentWitnessVerified: false as const,
  };
}
