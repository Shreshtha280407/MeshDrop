import decision from '../../docs/decisions/task-10d-waiver.json';
import { requireRelease, sameContent } from '../deploy/release-record';

/** Risk acknowledgement only. This module is not imported by release admission. */
export function task10dWaiver(value: unknown = decision) {
  requireRelease(sameContent(value, decision), 'TASK10D_WAIVER_CHANGED');
  requireRelease(
    decision.decision === 'SKIPPED' &&
      decision.hostedTrustVerified === false &&
      decision.humanAuthorizationVerified === false &&
      decision.independentWitnessVerified === false &&
      decision.productionApproved === false &&
      decision.acceptanceEnabled === false,
    'TASK10D_CANNOT_ESTABLISH_AUTHORITY',
  );
  return structuredClone(decision);
}
