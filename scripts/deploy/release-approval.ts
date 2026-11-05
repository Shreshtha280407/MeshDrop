import { randomUUID } from 'node:crypto';
import { verifyObservedAdmission, requireHostedObservation } from './cloudflare-readonly';
import type { CloudflareReadOnly, ReadOnlyObservation } from './cloudflare-readonly';
import type { AdmissionIntent } from './release-lifecycle';
import {
  ACCEPTANCE_CHECKS,
  REPOSITORY,
  canonical,
  fingerprint,
  parseManifest,
  parseRecord,
  requireRelease,
  ReleaseError,
  sameContent,
} from './release-record';
import type { Environment, Manifest, ReleaseRecord } from './release-record';

export type ApprovalPurpose = 'publication' | 'acceptance';
export type ApprovalClaim = {
  schemaVersion: 1;
  approvalId: string;
  repository: typeof REPOSITORY;
  environment: Environment;
  sourceCommit: string;
  manifestId: string;
  attemptId: string;
  runId: string;
  runAttempt: number;
  purpose: ApprovalPurpose;
  decision: 'AUTHORIZE' | 'ACCEPT' | 'REJECT';
  workerVersion: string;
  pagesDeployment: string;
  providerObservationId: string;
  recordSha256: string;
  approverId: string;
  requestedById: string;
  admissionAction: AdmissionIntent['action'];
  observedAdmissionPaused: boolean;
  issuedAt: string;
  expiresAt: string;
  evidence: Record<string, string>;
};
/** Trusted configuration, never populated from the approval or downloaded artifact. */
export type ApprovalPolicy = {
  repositoryId: string;
  repositoryOwnerId: string;
  signerWorkflow: string;
  signerCommit: string;
  publicationApprovers: readonly string[];
  acceptanceApprovers: readonly string[];
};
/** Output of an independently configured verifier, not a JSON-file parser.
 * Implementations must verify the attestation AND an independently authenticated
 * human review/authorization record, including current revocation status. OIDC's
 * actor claim alone is not a reviewer identity. No hosted implementation exists.
 */
export interface ApprovalAuthority {
  readonly scope: 'offline-fixture' | 'github-attestation';
  verify(
    payload: string,
    bundle: Uint8Array,
    challenge: string,
  ): Promise<{
    digest: string;
    issuer: string;
    repositoryId: string;
    repositoryOwnerId: string;
    signerWorkflow: string;
    signerCommit: string;
    sourceCommit: string;
    environment: Environment;
    runId: string;
    runAttempt: number;
    approverId: string;
    reviewId: string;
    decision: ApprovalClaim['decision'];
    checkedAt: string;
    challenge: string;
    revoked: boolean;
  }>;
}
export type ApprovalContext = {
  manifest: Manifest;
  record: ReleaseRecord;
  attemptId: string;
  runId: string;
  runAttempt: number;
  requestedById: string;
  publicationApproverId: string | null;
  purpose: ApprovalPurpose;
  admission: AdmissionIntent;
  policy: ApprovalPolicy;
  readback: Pick<CloudflareReadOnly, 'observe'>;
  now(): Date;
};
export type CheckedApproval = {
  claim: ApprovalClaim;
  digest: string;
  scope: 'offline-fixture' | 'hosted-candidate';
  releaseAccepted: false;
  productionApproved: false;
  publicationEnabled: false;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
export const PUBLICATION_EVIDENCE = [
  'prepared-artifacts',
  'previous-acceptance',
  'recovery-plan',
] as const;
const proofs = new WeakMap<
  object,
  {
    snapshot: CheckedApproval;
    used: boolean;
    verify(): Promise<CheckedApproval>;
  }
>();
function object(value: unknown): Record<string, unknown> {
  requireRelease(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_APPROVAL');
  return value as Record<string, unknown>;
}
function time(value: unknown): number {
  requireRelease(
    typeof value === 'string' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_APPROVAL_TIME',
  );
  return Date.parse(value);
}
export function parseApprovalClaim(value: unknown): ApprovalClaim {
  const item = object(value);
  requireRelease(
    Object.keys(item).sort().join(',') ===
      'schemaVersion,approvalId,repository,environment,sourceCommit,manifestId,attemptId,runId,runAttempt,purpose,decision,workerVersion,pagesDeployment,providerObservationId,recordSha256,approverId,requestedById,admissionAction,observedAdmissionPaused,issuedAt,expiresAt,evidence'
        .split(',')
        .sort()
        .join(','),
    'UNEXPECTED_APPROVAL_FIELDS',
  );
  requireRelease(
    item.schemaVersion === 1 &&
      item.repository === REPOSITORY &&
      (item.environment === 'preview' || item.environment === 'production') &&
      typeof item.sourceCommit === 'string' &&
      /^[a-f0-9]{40}$/.test(item.sourceCommit) &&
      ['publication', 'acceptance'].includes(String(item.purpose)),
    'INVALID_APPROVAL_SCOPE',
  );
  for (const key of ['approvalId', 'attemptId', 'workerVersion', 'pagesDeployment'])
    requireRelease(
      typeof item[key] === 'string' && UUID.test(item[key]),
      'INVALID_APPROVAL_IDENTITY',
    );
  for (const key of ['manifestId', 'providerObservationId', 'recordSha256'])
    requireRelease(
      typeof item[key] === 'string' && HASH.test(item[key]),
      'INVALID_APPROVAL_DIGEST',
    );
  for (const key of ['runId', 'approverId', 'requestedById'])
    requireRelease(
      typeof item[key] === 'string' && ID.test(item[key]),
      'INVALID_APPROVAL_IDENTITY',
    );
  requireRelease(
    Number.isSafeInteger(item.runAttempt) &&
      Number(item.runAttempt) > 0 &&
      ['preserve', 'pause', 'reopen'].includes(String(item.admissionAction)) &&
      typeof item.observedAdmissionPaused === 'boolean',
    'INVALID_APPROVAL_CONTEXT',
  );
  requireRelease(
    item.purpose === 'publication'
      ? ['AUTHORIZE', 'REJECT'].includes(String(item.decision))
      : ['ACCEPT', 'REJECT'].includes(String(item.decision)),
    'WRONG_APPROVAL_PURPOSE',
  );
  const duration = time(item.expiresAt) - time(item.issuedAt);
  requireRelease(duration > 0 && duration <= 10 * 60000, 'INVALID_APPROVAL_VALIDITY');
  const evidence = object(item.evidence);
  const keys = item.purpose === 'publication' ? PUBLICATION_EVIDENCE : ACCEPTANCE_CHECKS;
  requireRelease(
    Object.keys(evidence).sort().join(',') === [...keys].sort().join(',') &&
      Object.values(evidence).every((value) => typeof value === 'string' && HASH.test(value)),
    'INCOMPLETE_APPROVAL_EVIDENCE',
  );
  return structuredClone(item) as ApprovalClaim;
}
/** A stable identity digest; freshness is verified separately on every observation. */
export function observationIdentity(observation: ReadOnlyObservation): string {
  const current = Object.fromEntries(
    Object.entries(observation.current).filter(([key]) => key !== 'observedAt'),
  );
  return fingerprint({
    current,
    workerDeployment: observation.workerDeployment,
    projectId: observation.projectId,
    pagesSubdomain: observation.pagesSubdomain,
    pagesEnvironment: observation.pagesEnvironment,
    durableObjects: observation.durableObjects,
    classStorage: observation.classStorage,
    migrationTag: observation.migrationTag,
    route: observation.route,
  });
}
function policy(value: ApprovalPolicy) {
  requireRelease(
    ID.test(value.repositoryId) &&
      ID.test(value.repositoryOwnerId) &&
      /^[a-f0-9]{40}$/.test(value.signerCommit) &&
      /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(
        value.signerWorkflow,
      ) &&
      [value.publicationApprovers, value.acceptanceApprovers].every(
        (ids) =>
          Array.isArray(ids) &&
          ids.length > 0 &&
          ids.length <= 32 &&
          new Set(ids).size === ids.length &&
          ids.every((id) => ID.test(id)),
      ),
    'TRUSTED_APPROVAL_POLICY_REQUIRED',
  );
}
export async function checkApproval(
  value: unknown,
  bundle: Uint8Array,
  authority: ApprovalAuthority | undefined,
  context: ApprovalContext,
): Promise<CheckedApproval> {
  requireRelease(authority, 'TRUSTED_APPROVAL_AUTHORITY_REQUIRED');
  requireRelease(
    ['offline-fixture', 'github-attestation'].includes(authority.scope),
    'TRUSTED_APPROVAL_AUTHORITY_REQUIRED',
  );
  requireRelease(
    bundle instanceof Uint8Array && bundle.byteLength > 0 && bundle.byteLength <= 1024 * 1024,
    'INVALID_APPROVAL_BUNDLE',
  );
  const claim = parseApprovalClaim(value),
    proofBytes = bundle.slice();
  const manifest = parseManifest(structuredClone(context.manifest));
  const record = parseRecord(structuredClone(context.record), manifest);
  const pins = structuredClone({ ...context, readback: undefined, now: undefined });
  policy(pins.policy);
  async function verify(): Promise<CheckedApproval> {
    const now = context.now();
    requireRelease(
      now.getTime() >= time(claim.issuedAt) - 5000 && now.getTime() < time(claim.expiresAt),
      'APPROVAL_EXPIRED_OR_NOT_YET_VALID',
    );
    requireRelease(
      claim.purpose === pins.purpose &&
        claim.attemptId === pins.attemptId &&
        claim.runId === pins.runId &&
        claim.runAttempt === pins.runAttempt &&
        claim.requestedById === pins.requestedById &&
        claim.repository === manifest.repository &&
        claim.environment === manifest.environment &&
        claim.sourceCommit === manifest.sourceCommit &&
        claim.manifestId === manifest.id &&
        claim.recordSha256 === fingerprint(record),
      'APPROVAL_RELEASE_MISMATCH',
    );
    requireRelease(
      claim.purpose === 'publication'
        ? record.state === 'PREPARED'
        : record.state === 'PUBLISHED' && record.failure === null && record.acceptance === null,
      'RELEASE_NOT_APPROVABLE',
    );
    const roles =
      claim.purpose === 'publication'
        ? pins.policy.publicationApprovers
        : pins.policy.acceptanceApprovers;
    requireRelease(
      roles.includes(claim.approverId) &&
        claim.approverId !== pins.requestedById &&
        (claim.purpose !== 'acceptance' ||
          (pins.publicationApproverId !== null && claim.approverId !== pins.publicationApproverId)),
      'APPROVER_NOT_AUTHORIZED',
    );
    const challenge = randomUUID();
    let verified: Awaited<ReturnType<ApprovalAuthority['verify']>>;
    try {
      verified = await authority!.verify(canonical(claim), proofBytes.slice(), challenge);
    } catch {
      throw new ReleaseError('APPROVAL_AUTHENTICATION_FAILED');
    }
    requireRelease(
      verified && typeof verified === 'object' && typeof verified.revoked === 'boolean',
      'UNTRUSTED_APPROVAL_AUTHORITY_EVIDENCE',
    );
    const checkedAge = context.now().getTime() - time(verified.checkedAt);
    requireRelease(
      verified.challenge === challenge && checkedAge >= -5000 && checkedAge <= 5000,
      'STALE_AUTHORITY_VERIFICATION',
    );
    requireRelease(!verified.revoked, 'APPROVAL_REVOKED');
    requireRelease(
      verified.digest === fingerprint(claim) &&
        verified.issuer === 'https://token.actions.githubusercontent.com' &&
        verified.repositoryId === pins.policy.repositoryId &&
        verified.repositoryOwnerId === pins.policy.repositoryOwnerId &&
        verified.signerWorkflow === pins.policy.signerWorkflow &&
        verified.signerCommit === pins.policy.signerCommit &&
        verified.sourceCommit === manifest.sourceCommit &&
        verified.environment === manifest.environment &&
        verified.runId === pins.runId &&
        verified.runAttempt === pins.runAttempt &&
        verified.approverId === claim.approverId &&
        ID.test(verified.reviewId) &&
        verified.decision === claim.decision,
      'UNTRUSTED_APPROVAL_AUTHORITY_EVIDENCE',
    );
    const live = await context.readback.observe();
    verifyObservedAdmission(
      manifest,
      live,
      pins.purpose === 'acceptance' ? { action: 'preserve', confirmation: '' } : pins.admission,
      context.now(),
    );
    requireRelease(
      claim.admissionAction ===
        (pins.purpose === 'acceptance' ? 'preserve' : pins.admission.action) &&
        claim.observedAdmissionPaused === live.current.admissionPaused &&
        claim.providerObservationId === observationIdentity(live) &&
        claim.workerVersion === live.current.workerVersion &&
        claim.pagesDeployment === live.current.pagesDeployment,
      'APPROVAL_PROVIDER_MISMATCH',
    );
    if (claim.purpose === 'acceptance')
      requireRelease(
        record.provider.workerVersion === claim.workerVersion &&
          record.provider.pagesDeployment === claim.pagesDeployment,
        'APPROVAL_PROVIDER_MISMATCH',
      );
    // Provider readback is asynchronous: validity at its start is insufficient.
    const finishedAt = context.now().getTime();
    requireRelease(
      finishedAt >= time(claim.issuedAt) - 5000 && finishedAt < time(claim.expiresAt),
      'APPROVAL_EXPIRED_OR_NOT_YET_VALID',
    );
    requireRelease(
      finishedAt - time(verified.checkedAt) >= -5000 &&
        finishedAt - time(verified.checkedAt) <= 5000,
      'STALE_AUTHORITY_VERIFICATION',
    );
    const scope =
      authority!.scope === 'offline-fixture' || live.scope === 'offline-fixture'
        ? 'offline-fixture'
        : 'hosted-candidate';
    if (scope === 'hosted-candidate') requireHostedObservation(live, context.now());
    return {
      claim: structuredClone(claim),
      digest: fingerprint(claim),
      scope,
      releaseAccepted: false,
      productionApproved: false,
      publicationEnabled: false,
    };
  }
  const result = await verify();
  proofs.set(result, { snapshot: structuredClone(result), used: false, verify });
  return result;
}
/** Recheck revocation and fresh provider identities at each use; no cached boolean. */
export async function recheckApproval(
  value: CheckedApproval,
  consume = false,
): Promise<ApprovalClaim> {
  const proof = proofs.get(value);
  requireRelease(
    proof && sameContent(proof.snapshot, value),
    'UNTRUSTED_OR_MODIFIED_APPROVAL_CHECK',
  );
  if (consume) {
    requireRelease(!proof.used, 'APPROVAL_ALREADY_CONSUMED');
    // Uncertain failures require reconciliation, not reuse of this in-process check.
    proof.used = true;
  }
  const checked = await proof.verify();
  requireRelease(sameContent(checked, proof.snapshot), 'APPROVAL_CHECK_CHANGED');
  return structuredClone(checked.claim);
}
export function hostedApprovalAuthority(): never {
  throw new ReleaseError('HOSTED_APPROVAL_AUTHORITY_NOT_CONFIGURED');
}
