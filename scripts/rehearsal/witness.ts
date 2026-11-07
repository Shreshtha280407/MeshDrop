import { ReleaseError, requireRelease } from '../deploy/release-record';
import { exact } from './contract';
import type { RehearsalArtifact } from './contract';
import type { RehearsalHead } from './recovery';

/** Implementations must authenticate an independently retained latest head,
 * including scope, run/attempt and freshness. A database's own head, caller
 * boolean, deletable Actions artifact or old signed head is insufficient. */
export interface RecoveryWitness {
  verify(
    artifact: RehearsalArtifact,
    expected: {
      head: RehearsalHead;
      storeId: string;
      artifactId: string;
      rehearsalId: string;
      authority: string;
      minimumCounter: number;
    },
    evidence: Uint8Array,
  ): Promise<{
    independentlyAuthenticated: true;
    storeId: string;
    head: RehearsalHead;
    checkedAt: string;
    artifactId: string;
    rehearsalId: string;
    monotonicCounter: number;
    authority: string;
  }>;
}
export function hostedRecoveryWitness(): never {
  throw new ReleaseError('INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED');
}

/** Classifies untrusted proposals only. No signature verification is invented. */
export function verifyHostedWitness(proposal: unknown): never {
  const p = exact(
    proposal,
    'source,artifactId,rehearsalId,storeId,head,witnessTime,witnessIdentity,monotonicCounter,signedEnvelope,fixture',
  );
  requireRelease(p.source === 'independent-service', 'SAME_STORE_OR_LOCAL_WITNESS_FORBIDDEN');
  requireRelease(p.fixture === false, 'FIXTURE_WITNESS_FORBIDDEN');
  requireRelease(
    typeof p.signedEnvelope === 'string' && p.signedEnvelope.length > 0,
    'UNSIGNED_WITNESS_FORBIDDEN',
  );
  requireRelease(
    Number.isSafeInteger(p.monotonicCounter) && Number(p.monotonicCounter) > 0,
    'WITNESS_MONOTONIC_COUNTER_REQUIRED',
  );
  return hostedRecoveryWitness();
}
