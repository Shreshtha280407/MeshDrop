import { ReleaseError } from '../deploy/release-record';
import type { RehearsalArtifact } from './contract';
import type { RehearsalHead } from './recovery';

/** Implementations must authenticate an independently retained latest head,
 * including scope, run/attempt and freshness. A database's own head, caller
 * boolean, deletable Actions artifact or old signed head is insufficient. */
export interface RecoveryWitness {
  verify(
    artifact: RehearsalArtifact,
    expected: RehearsalHead,
    evidence: Uint8Array,
  ): Promise<{
    independentlyAuthenticated: true;
    storeId: string;
    head: RehearsalHead;
    checkedAt: string;
    authority: string;
  }>;
}
export function hostedRecoveryWitness(): never {
  throw new ReleaseError('INDEPENDENT_REHEARSAL_WITNESS_NOT_CONFIGURED');
}
