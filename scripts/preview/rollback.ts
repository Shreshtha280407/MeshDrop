import { compareSnapshots, inspectCommit } from '../deploy/rollback-compatibility';
import { requireRelease, sameContent, parseManifest } from '../deploy/release-record';
import type { Manifest } from '../deploy/release-record';
import { CAPABILITIES, isolation } from './contract';
import type { Isolation } from './contract';

/** Eligibility only, never a mutation, automatic rollback or approval. Both frozen
 * archives must separately pass verifyPreparedArtifacts and manifestGate. */
export async function previewRollbackEligibility(
  pins: Isolation,
  current: Manifest,
  target: Manifest,
) {
  isolation(pins.target, pins.deny);
  parseManifest(current);
  parseManifest(target);
  requireRelease(
    current.environment === 'preview' &&
      target.environment === 'preview' &&
      current.accountId === pins.target.accountId &&
      target.accountId === pins.target.accountId &&
      current.worker === pins.target.worker &&
      target.worker === pins.target.worker &&
      current.project === pins.target.project &&
      target.project === pins.target.project &&
      current.origin === pins.target.origin &&
      target.origin === pins.target.origin &&
      current.admissionPaused === true &&
      target.admissionPaused === true,
    'PREVIEW_ROLLBACK_SCOPE_MISMATCH',
  );
  requireRelease(
    current.id !== target.id &&
      current.protocolVersion === target.protocolVersion &&
      current.configurationSha256 === target.configurationSha256 &&
      current.migrationsSha256 === target.migrationsSha256,
    'PREVIEW_ROLLBACK_INCOMPATIBLE',
  );
  const latest = await inspectCommit(current.sourceCommit),
    previous = await inspectCommit(target.sourceCommit);
  requireRelease(
    compareSnapshots(latest, previous).length === 0 &&
      sameContent(latest.bindings, previous.bindings),
    'PREVIEW_ROLLBACK_INCOMPATIBLE',
  );
  return {
    contentCompatible: true,
    providerIdentitiesVerified: false,
    drillPerformed: false,
    ...CAPABILITIES,
  };
}
