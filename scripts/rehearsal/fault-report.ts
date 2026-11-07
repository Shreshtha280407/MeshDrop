import { fingerprint, requireRelease, sameContent } from '../deploy/release-record';
import { exact, flags } from './contract';
import type { RehearsalArtifact } from './contract';
import { CHECK_NAMES, FAULT_MODES, inspectFaultHistory } from './fault-contract';
import type { FaultCheck, FaultMode } from './fault-contract';
import type { FaultHarness } from './faults';

export type FaultResult = Awaited<ReturnType<FaultHarness['run']>>;
export function faultReport(
  artifact: RehearsalArtifact,
  storeId: string,
  results: FaultResult[],
  failedMode: FaultMode | null = null,
  failure: string | null = null,
) {
  const checks = Object.fromEntries(
    FAULT_MODES.map((mode, i) => [
      CHECK_NAMES[i]!,
      results.some((r) => r.mode === mode) ? 'PASS' : mode === failedMode ? 'FAIL' : 'NOT_RUN',
    ]),
  ) as Record<(typeof CHECK_NAMES)[number], FaultCheck>;
  const payload = {
    schemaVersion: 1,
    purpose: 'trust-rehearsal-fault-report',
    artifactId: artifact.artifactId,
    rehearsalId: artifact.rehearsalId,
    repository: artifact.repository,
    repositoryId: artifact.repositoryId,
    ownerId: artifact.ownerId,
    environment: 'preview',
    sourceCommit: artifact.sourceCommit,
    sourceRef: artifact.sourceRef,
    runId: artifact.runId,
    runAttempt: artifact.runAttempt,
    storeId,
    checks,
    results,
    failure,
    independentWitnessVerified: false,
    humanAuthorizationVerified: false,
    publicationEnabled: false,
    acceptanceEnabled: false,
    productionApproved: false,
  };
  return { ...payload, reportDigest: fingerprint(payload) };
}
export function inspectFaultReport(artifact: RehearsalArtifact, value: unknown) {
  const r = exact(
    value,
    'schemaVersion,purpose,artifactId,rehearsalId,repository,repositoryId,ownerId,environment,sourceCommit,sourceRef,runId,runAttempt,storeId,checks,results,failure,independentWitnessVerified,humanAuthorizationVerified,publicationEnabled,acceptanceEnabled,productionApproved,reportDigest',
  );
  flags(r);
  requireRelease(
    r.schemaVersion === 1 &&
      r.purpose === 'trust-rehearsal-fault-report' &&
      artifact.environment === 'preview' &&
      r.environment === 'preview' &&
      r.independentWitnessVerified === false &&
      r.humanAuthorizationVerified === false,
    'FAULT_REPORT_AUTHORITY_FORBIDDEN',
  );
  for (const k of [
    'artifactId',
    'rehearsalId',
    'repository',
    'repositoryId',
    'ownerId',
    'sourceCommit',
    'sourceRef',
    'runId',
    'runAttempt',
  ] as const)
    requireRelease(r[k] === artifact[k], 'FAULT_REPORT_ARTIFACT_MISMATCH');
  const { reportDigest, ...payload } = r;
  requireRelease(reportDigest === fingerprint(payload), 'FAULT_REPORT_MODIFIED');
  const checks = exact(r.checks, CHECK_NAMES.join(','));
  requireRelease(
    Object.values(checks).every((v) => ['PASS', 'FAIL', 'NOT_RUN'].includes(String(v))) &&
      Array.isArray(r.results) &&
      r.results.length <= 5,
    'FAULT_REPORT_INVALID_RESULTS',
  );
  const seen = new Set<string>();
  for (const raw of r.results) {
    const v = raw as FaultResult;
    requireRelease(
      v && FAULT_MODES.includes(v.mode) && !seen.has(v.mode),
      'FAULT_REPORT_DUPLICATE_MODE',
    );
    seen.add(v.mode);
    requireRelease(
      v.status === 'PASS' &&
        v.storeId === r.storeId &&
        v.artifactId === artifact.artifactId &&
        v.rehearsalId === artifact.rehearsalId &&
        v.sourceCommit === artifact.sourceCommit &&
        v.runId === artifact.runId &&
        v.runAttempt === artifact.runAttempt &&
        v.repositoryId === artifact.repositoryId &&
        v.ownerId === artifact.ownerId &&
        v.environment === 'preview',
      'FAULT_REPORT_ARTIFACT_MISMATCH',
    );
    flags(v as unknown as Record<string, unknown>);
    requireRelease(
      v.independentWitnessVerified === false && v.humanAuthorizationVerified === false,
      'FAULT_REPORT_AUTHORITY_FORBIDDEN',
    );
    const { resultDigest, ...body } = v;
    requireRelease(resultDigest === fingerprint(body), 'FAULT_RESULT_MODIFIED');
    const h = inspectFaultHistory(
      { storeId: v.storeId, head: v.head, events: v.events },
      v.storeId,
      v.mode,
      v.recoveryAttemptId,
      v.head,
    );
    requireRelease(
      sameContent(h.artifact, artifact) && h.events.length === v.eventCount,
      'FAULT_REPORT_HISTORY_MISMATCH',
    );
    requireRelease(
      checks[CHECK_NAMES[FAULT_MODES.indexOf(v.mode)]!] === 'PASS',
      'FAULT_REPORT_INVALID_RESULTS',
    );
    const c = v.checks;
    if (v.mode === 'concurrency')
      requireRelease(
        c.winnerCount === 1 && c.loserCount === 1 && c.splitBrain === false,
        'FAULT_REPORT_INVALID_CONCURRENCY',
      );
    if (v.mode === 'lost-ack')
      requireRelease(
        c.reconciliationRequired === true &&
          c.blindRetryPerformed === false &&
          c.acknowledgementSuppressed === true &&
          c.proposedEventCommitted === true,
        'FAULT_REPORT_INVALID_RECONCILIATION',
      );
    if (v.mode === 'reconnect')
      requireRelease(
        c.writerProcessExited === true &&
          c.readerUsedCachedState === false &&
          c.automaticResumePerformed === false &&
          c.blindRetryPerformed === false,
        'FAULT_REPORT_AUTOMATIC_RETRY_FORBIDDEN',
      );
    if (v.mode === 'history-integrity')
      requireRelease(
        c.injection === 'reader-input-copy-only' &&
          c.databaseHistoryModified === false &&
          Object.keys(c.rejectedProbes as object).length === 10,
        'FAULT_REPORT_HISTORY_MUTATION_FORBIDDEN',
      );
    if (v.mode === 'replay')
      requireRelease(
        Array.isArray(c.rejectedProbes) &&
          c.rejectedProbes.length === 5 &&
          c.eventOverwritten === false,
        'FAULT_REPORT_INVALID_REPLAY',
      );
  }
  for (const [i, mode] of FAULT_MODES.entries())
    requireRelease(
      checks[CHECK_NAMES[i]!] !== 'PASS' || seen.has(mode),
      'FAULT_REPORT_MISSING_MODE',
    );
  return {
    checks,
    complete:
      seen.size === 5 && Object.values(checks).every((v) => v === 'PASS') && r.failure === null,
    reportDigest,
    publicationEnabled: false,
    acceptanceEnabled: false,
    productionApproved: false,
    independentWitnessVerified: false,
    humanAuthorizationVerified: false,
  };
}
