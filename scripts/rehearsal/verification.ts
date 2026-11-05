import { bytesHash, canonical, requireRelease, sameContent } from '../deploy/release-record';
import { parseAttestationPolicy, verifyAttestation } from '../deploy/github-attestation';
import type { AttestationPolicy } from '../deploy/github-attestation';
import { matchArtifact, parseArtifact, WORKFLOW } from './contract';
import type { RehearsalArtifact, RehearsalExpectation } from './contract';

export type RehearsalVerification = Awaited<ReturnType<typeof verifyAttestation>> & {
  artifactId: string;
  environment: string;
  rehearsalId: string;
};
const issued = new WeakMap<
  object,
  { artifact: RehearsalArtifact; result: RehearsalVerification }
>();
export async function verifyRehearsal(
  artifactBytes: Uint8Array,
  bundle: Uint8Array,
  roots: Uint8Array,
  policy: AttestationPolicy,
  expected: RehearsalExpectation,
  now = new Date(),
): Promise<RehearsalVerification> {
  const artifact = parseArtifact(JSON.parse(Buffer.from(artifactBytes).toString('utf8')));
  requireRelease(
    Buffer.from(artifactBytes).equals(Buffer.from(canonical(artifact))),
    'NONCANONICAL_REHEARSAL_ARTIFACT',
  );
  matchArtifact(artifact, expected);
  const pins = parseAttestationPolicy(policy);
  requireRelease(
    pins.schemaVersion === 2 &&
      pins.signerRef === expected.sourceRef &&
      pins.repository === 'Shreshtha280407/MeshDrop' &&
      pins.repositoryId === expected.repositoryId &&
      pins.ownerId === expected.ownerId &&
      pins.sourceWorkflow === WORKFLOW &&
      pins.signerWorkflow === `Shreshtha280407/MeshDrop/${WORKFLOW}` &&
      pins.signerCommit === expected.sourceCommit &&
      pins.sourceCommit === expected.sourceCommit &&
      pins.sourceRef === expected.sourceRef &&
      pins.runId === expected.runId &&
      pins.runAttempt === expected.runAttempt &&
      pins.artifactSha256 === bytesHash(Buffer.from(artifactBytes)),
    'REHEARSAL_ATTESTATION_POLICY_MISMATCH',
  );
  const verified = await verifyAttestation(artifactBytes, bundle, roots, pins, now);
  const result = {
    ...verified,
    artifactId: artifact.artifactId,
    environment: artifact.environment,
    rehearsalId: artifact.rehearsalId,
  };
  issued.set(result, { artifact: structuredClone(artifact), result: structuredClone(result) });
  return result;
}
/** A serialized success flag can never select hosted storage mode. */
export function requireRehearsalVerification(
  result: RehearsalVerification,
  artifact: RehearsalArtifact,
) {
  const proof = issued.get(result);
  requireRelease(
    proof && sameContent(proof.artifact, artifact) && sameContent(proof.result, result),
    'UNTRUSTED_REHEARSAL_VERIFICATION',
  );
}
