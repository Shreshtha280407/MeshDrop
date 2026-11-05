import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { bytesHash, requireRelease, ReleaseError } from './release-record';

/** Protected operator configuration, never supplied by an artifact or bundle. */
export type AttestationPolicy = {
  schemaVersion: 1 | 2;
  signerRef?: string;
  repository: string;
  repositoryId: string;
  ownerId: string;
  signerWorkflow: string;
  signerCommit: string;
  sourceCommit: string;
  sourceRef: string;
  sourceWorkflow: string;
  runId: string;
  runAttempt: number;
  artifactSha256: string;
  trustedRootSha256: string;
  rootReviewedAt: string;
  rootValidUntil: string;
  ghPath: string;
  ghSha256: string;
};
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
export function parseAttestationPolicy(value: unknown): AttestationPolicy {
  requireRelease(value && typeof value === 'object', 'TRUSTED_ATTESTATION_POLICY_REQUIRED');
  const p = value as AttestationPolicy;
  requireRelease(
    Object.keys(p).sort().join(',') ===
      (
        'schemaVersion,repository,repositoryId,ownerId,signerWorkflow,signerCommit,sourceCommit,sourceRef,sourceWorkflow,runId,runAttempt,artifactSha256,trustedRootSha256,rootReviewedAt,rootValidUntil,ghPath,ghSha256' +
        (p.schemaVersion === 2 ? ',signerRef' : '')
      )
        .split(',')
        .sort()
        .join(',') &&
      (p.schemaVersion === 1 ||
        (p.schemaVersion === 2 &&
          typeof p.signerRef === 'string' &&
          /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(p.signerRef))) &&
      REPO.test(p.repository) &&
      ID.test(p.repositoryId) &&
      ID.test(p.ownerId) &&
      typeof p.signerWorkflow === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(
        p.signerWorkflow,
      ) &&
      SHA.test(p.signerCommit) &&
      SHA.test(p.sourceCommit) &&
      WORKFLOW.test(p.sourceWorkflow) &&
      typeof p.sourceRef === 'string' &&
      /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(p.sourceRef) &&
      ID.test(p.runId) &&
      Number.isSafeInteger(p.runAttempt) &&
      p.runAttempt > 0 &&
      HASH.test(p.artifactSha256) &&
      HASH.test(p.trustedRootSha256) &&
      HASH.test(p.ghSha256) &&
      typeof p.ghPath === 'string' &&
      isAbsolute(p.ghPath) &&
      [p.rootReviewedAt, p.rootValidUntil].every(
        (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)),
      ) &&
      Date.parse(p.rootValidUntil) > Date.parse(p.rootReviewedAt) &&
      Date.parse(p.rootValidUntil) - Date.parse(p.rootReviewedAt) <= 7 * 86400000,
    'INVALID_ATTESTATION_POLICY',
  );
  return structuredClone(p);
}
/** Structural policy guard for output of the trusted verifier. Calling this
 * function on JSON does not verify a signature or mint a verification receipt. */
export function enforceAttestationIdentity(result: unknown, p: AttestationPolicy): void {
  const san = `https://github.com/${p.signerWorkflow}@${p.schemaVersion === 2 ? p.signerRef : p.signerCommit}`;
  requireRelease(Array.isArray(result) && result.length === 1, 'AMBIGUOUS_ATTESTATION');
  const verified = result[0]?.verificationResult;
  const cert = verified?.signature?.certificate;
  requireRelease(
    cert &&
      cert.issuer === 'https://token.actions.githubusercontent.com' &&
      cert.subjectAlternativeName === san &&
      cert.buildSignerURI === san &&
      cert.buildSignerDigest === p.signerCommit &&
      cert.sourceRepositoryURI === `https://github.com/${p.repository}` &&
      cert.sourceRepositoryIdentifier === p.repositoryId &&
      cert.sourceRepositoryOwnerIdentifier === p.ownerId &&
      cert.sourceRepositoryDigest === p.sourceCommit &&
      cert.sourceRepositoryRef === p.sourceRef &&
      cert.runnerEnvironment === 'github-hosted' &&
      cert.buildConfigURI ===
        `https://github.com/${p.repository}/${p.sourceWorkflow}@${p.sourceRef}` &&
      cert.buildConfigDigest === p.sourceCommit &&
      cert.runInvocationURI ===
        `https://github.com/${p.repository}/actions/runs/${p.runId}/attempts/${p.runAttempt}`,
    'ATTESTATION_IDENTITY_MISMATCH',
  );
  const subject = verified.statement?.subject;
  requireRelease(
    verified.statement?.predicateType === 'https://slsa.dev/provenance/v1' &&
      Array.isArray(subject) &&
      subject.length === 1 &&
      subject[0]?.digest?.sha256 === p.artifactSha256 &&
      Array.isArray(verified.verifiedTimestamps) &&
      verified.verifiedTimestamps.length > 0 &&
      verified.verifiedTimestamps.every(
        (t: { timestamp?: string }) =>
          typeof t.timestamp === 'string' && Number.isFinite(Date.parse(t.timestamp)),
      ),
    'UNVERIFIED_ATTESTATION_STATEMENT',
  );
}
async function executableDigest(path: string) {
  const stat = await lstat(path);
  requireRelease(stat.isFile() && !(stat.mode & 0o022), 'UNTRUSTED_VERIFIER_EXECUTABLE');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
/** Real gh/Sigstore verification. No token, login, API lookup or root refresh. */
export async function verifyAttestation(
  artifact: Uint8Array,
  bundle: Uint8Array,
  roots: Uint8Array,
  value: AttestationPolicy,
  now = new Date(),
) {
  const p = parseAttestationPolicy(value);
  requireRelease(
    now.getTime() >= Date.parse(p.rootReviewedAt) && now.getTime() < Date.parse(p.rootValidUntil),
    'TRUST_ROOT_REVIEW_EXPIRED',
  );
  requireRelease(
    artifact.byteLength > 0 &&
      artifact.byteLength <= 1024 * 1024 &&
      bundle.byteLength > 0 &&
      bundle.byteLength <= 1024 * 1024 &&
      roots.byteLength > 0 &&
      roots.byteLength <= 1024 * 1024,
    'ATTESTATION_INPUT_LIMIT',
  );
  requireRelease(
    bytesHash(Buffer.from(artifact)) === p.artifactSha256,
    'ATTESTED_ARTIFACT_MISMATCH',
  );
  requireRelease(bytesHash(Buffer.from(roots)) === p.trustedRootSha256, 'UNTRUSTED_SIGSTORE_ROOT');
  let directory: string | undefined;
  try {
    requireRelease(
      (await executableDigest(p.ghPath)) === p.ghSha256,
      'UNTRUSTED_VERIFIER_EXECUTABLE',
    );
    directory = await mkdtemp(join(tmpdir(), 'meshdrop-attestation-'));
    await Promise.all([
      writeFile(join(directory, 'artifact'), artifact, { mode: 0o600, flag: 'wx' }),
      writeFile(join(directory, 'bundle.json'), bundle, { mode: 0o600, flag: 'wx' }),
      writeFile(join(directory, 'roots.jsonl'), roots, { mode: 0o600, flag: 'wx' }),
    ]);
    const san = `https://github.com/${p.signerWorkflow}@${p.schemaVersion === 2 ? p.signerRef : p.signerCommit}`;
    const args = [
      'attestation',
      'verify',
      join(directory, 'artifact'),
      '--bundle',
      join(directory, 'bundle.json'),
      '--custom-trusted-root',
      join(directory, 'roots.jsonl'),
      '--repo',
      p.repository,
      '--cert-identity',
      san,
      '--cert-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--signer-digest',
      p.signerCommit,
      '--source-digest',
      p.sourceCommit,
      '--source-ref',
      p.sourceRef,
      '--predicate-type',
      'https://slsa.dev/provenance/v1',
      '--deny-self-hosted-runners',
      '--format',
      'json',
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        p.ghPath,
        args,
        {
          cwd: directory,
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            GH_CONFIG_DIR: directory!,
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
            LC_ALL: 'C',
            TZ: 'UTC',
          },
        },
        (error, output) =>
          error ? reject(new ReleaseError('ATTESTATION_VERIFICATION_FAILED')) : resolve(output),
      );
    });
    requireRelease(
      (await executableDigest(p.ghPath)) === p.ghSha256,
      'UNTRUSTED_VERIFIER_EXECUTABLE',
    );
    enforceAttestationIdentity(JSON.parse(stdout), p);
    return {
      signatureVerified: true as const,
      repository: p.repository,
      repositoryId: p.repositoryId,
      sourceCommit: p.sourceCommit,
      artifactSha256: p.artifactSha256,
      signerWorkflow: p.signerWorkflow,
      runId: p.runId,
      runAttempt: p.runAttempt,
      authorizationVerified: false as const,
      publicationEnabled: false as const,
      acceptanceEnabled: false as const,
      productionApproved: false as const,
    };
  } catch (error) {
    throw error instanceof ReleaseError
      ? error
      : new ReleaseError('ATTESTATION_VERIFIER_UNAVAILABLE_OR_INVALID');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export async function readAttestationInput(path: string) {
  const stat = await lstat(path);
  requireRelease(
    stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024,
    'ATTESTATION_INPUT_LIMIT',
  );
  return readFile(path);
}
