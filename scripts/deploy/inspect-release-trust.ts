import {
  readAttestationInput,
  parseAttestationPolicy,
  verifyAttestation,
} from './github-attestation';
import { inspectRecovery } from './recovery-evidence';
import { parseManifest, ReleaseError } from './release-record';

const [mode, ...args] = process.argv.slice(2);
try {
  let result: object;
  if (mode === 'attestation' && args.length === 4) {
    const [artifact, bundle, roots, policy] = await Promise.all(
      args.map((path) => readAttestationInput(path)),
    );
    result = await verifyAttestation(
      artifact!,
      bundle!,
      roots!,
      parseAttestationPolicy(JSON.parse(policy!.toString())),
    );
  } else if (mode === 'history' && args.length === 4) {
    const [manifest, events, anchor] = await Promise.all(
      args.slice(0, 3).map((path) => readAttestationInput(path)),
    );
    const inspected = inspectRecovery(
      parseManifest(JSON.parse(manifest!.toString())),
      args[3]!,
      JSON.parse(events!.toString()),
      JSON.parse(anchor!.toString()),
    );
    result = {
      integrityVerified: inspected.integrityVerified,
      authenticated: false,
      offRunDurable: false,
      environment: inspected.record.provider.observation?.environment ?? null,
      events: inspected.events.length,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    };
  } else throw new ReleaseError('USAGE_INSPECT_RELEASE_TRUST_ATTESTATION_OR_HISTORY');
  console.log(
    JSON.stringify({
      status: 'UNVERIFIED',
      reason: 'HOSTED_AUTHORIZATION_AND_DURABILITY_NOT_ESTABLISHED',
      ...result,
    }),
  );
  process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'UNVERIFIED',
      reason: error instanceof ReleaseError ? error.code : 'INVALID_OR_UNAVAILABLE_TRUST_INPUT',
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    }),
  );
  process.exitCode = 1;
}
