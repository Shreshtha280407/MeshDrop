import { parseApprovalClaim } from './release-approval';
import type { ApprovalClaim, ApprovalPolicy } from './release-approval';
import { canonical, fingerprint, requireRelease, ReleaseError } from './release-record';
import { parseAttestationPolicy, verifyAttestation } from './github-attestation';
import type { AttestationPolicy } from './github-attestation';

export type ReviewExpectation = {
  repository: 'Shreshtha280407/MeshDrop';
  repositoryId: string;
  ownerId: string;
  environmentId: number;
  environment: 'preview' | 'production';
  environmentName: string;
  workflowPath: string;
  purpose: ApprovalClaim['purpose'];
  publicationApproverId: string | null;
  policy: ApprovalPolicy;
};
type Transport = (url: string, init: RequestInit) => Promise<Response>;
function object(value: unknown): Record<string, unknown> {
  requireRelease(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_GITHUB_RESPONSE',
  );
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  requireRelease(Number.isSafeInteger(value) && Number(value) > 0, 'INVALID_GITHUB_ID');
  return String(value);
}
/** GET only; GitHub TLS authenticates the observation, not a downloaded JSON copy. */
export class GitHubReviewReader {
  readonly #offline: boolean;
  readonly #token: string;
  private readonly now: () => Date;
  get scope(): 'github-api' | 'offline-fixture' {
    return this.#offline ? 'offline-fixture' : 'github-api';
  }
  private readonly expected: ReviewExpectation;
  private readonly transport: Transport;
  constructor(expected: ReviewExpectation, token: string, transport?: Transport, now?: () => Date) {
    requireRelease(
      expected.repository === 'Shreshtha280407/MeshDrop' &&
        /^[1-9][0-9]*$/.test(expected.repositoryId) &&
        /^[1-9][0-9]*$/.test(expected.ownerId) &&
        Number.isSafeInteger(expected.environmentId) &&
        expected.environmentId > 0 &&
        ['preview', 'production'].includes(expected.environment) &&
        /^[A-Za-z0-9_-]{1,80}$/.test(expected.environmentName) &&
        /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expected.workflowPath) &&
        ['publication', 'acceptance'].includes(expected.purpose) &&
        expected.policy.repositoryId === expected.repositoryId &&
        expected.policy.repositoryOwnerId === expected.ownerId,
      'EXPLICIT_GITHUB_REVIEW_SCOPE_REQUIRED',
    );
    requireRelease(
      typeof token === 'string' &&
        token.length >= 16 &&
        token.length <= 4096 &&
        !/[\r\n]/.test(token),
      'GITHUB_READ_CREDENTIAL_REQUIRED',
    );
    this.expected = structuredClone(expected);
    this.#token = token;
    this.#offline = Boolean(transport || now);
    this.now = now ?? (() => new Date());
    this.transport = transport ?? fetch;
  }
  private async get(path: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new ReleaseError('GITHUB_READ_TIMEOUT')),
        { once: true },
      ),
    );
    try {
      const response = await Promise.race([
        this.transport(`https://api.github.com/repos/${this.expected.repository}${path}`, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'Cache-Control': 'no-cache',
          },
        }),
        aborted,
      ]);
      requireRelease(
        response.status === 200 && !response.redirected && !response.headers.get('link'),
        'GITHUB_READ_INCOMPLETE_OR_FAILED',
      );
      requireRelease(
        /application\/json/.test(response.headers.get('content-type') ?? ''),
        'INVALID_GITHUB_RESPONSE',
      );
      const reader = response.body?.getReader();
      requireRelease(reader, 'INVALID_GITHUB_RESPONSE');
      let text = '',
        length = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          length += value.byteLength;
          requireRelease(length <= 256 * 1024, 'GITHUB_RESPONSE_LIMIT');
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw error instanceof ReleaseError ? error : new ReleaseError('GITHUB_READ_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  async inspect(value: unknown, attestation?: AttestationPolicy) {
    const claim = parseApprovalClaim(value),
      e = this.expected;
    if (attestation) {
      const pins = parseAttestationPolicy(attestation);
      requireRelease(
        pins.repository === e.repository &&
          pins.repositoryId === e.repositoryId &&
          pins.ownerId === e.ownerId &&
          pins.sourceWorkflow === e.workflowPath &&
          pins.signerWorkflow === e.policy.signerWorkflow &&
          pins.signerCommit === e.policy.signerCommit,
        'GITHUB_ATTESTATION_REVIEW_SCOPE_MISMATCH',
      );
    }
    requireRelease(
      this.now().getTime() >= Date.parse(claim.issuedAt) - 5000 &&
        this.now().getTime() < Date.parse(claim.expiresAt),
      'GITHUB_REVIEW_CLAIM_EXPIRED',
    );
    requireRelease(
      claim.purpose === e.purpose && claim.environment === e.environment,
      'GITHUB_REVIEW_PURPOSE_MISMATCH',
    );
    const allowed =
      e.purpose === 'publication' ? e.policy.publicationApprovers : e.policy.acceptanceApprovers;
    requireRelease(
      allowed.includes(claim.approverId) &&
        claim.approverId !== claim.requestedById &&
        (e.purpose !== 'acceptance' ||
          (e.publicationApproverId !== null && claim.approverId !== e.publicationApproverId)),
      'GITHUB_REVIEWER_NOT_AUTHORIZED',
    );
    const repository = object(await this.get(''));
    requireRelease(
      id(repository.id) === e.repositoryId &&
        id(object(repository.owner).id) === e.ownerId &&
        repository.full_name === e.repository,
      'GITHUB_REPOSITORY_MISMATCH',
    );
    const run = object(await this.get(`/actions/runs/${claim.runId}/attempts/${claim.runAttempt}`));
    requireRelease(
      id(run.id) === claim.runId &&
        run.run_attempt === claim.runAttempt &&
        run.head_sha === claim.sourceCommit &&
        id(object(run.repository).id) === e.repositoryId &&
        id(object(run.actor).id) === claim.requestedById &&
        id(object(run.triggering_actor).id) === claim.requestedById,
      'GITHUB_RUN_MISMATCH',
    );
    const workflow = object(await this.get(`/actions/workflows/${id(run.workflow_id)}`));
    requireRelease(
      workflow.path === e.workflowPath && workflow.state === 'active',
      'GITHUB_WORKFLOW_MISMATCH',
    );
    const environment = object(await this.get(`/environments/${e.environmentName}`));
    requireRelease(
      environment.id === e.environmentId &&
        environment.name === e.environmentName &&
        Array.isArray(environment.protection_rules),
      'GITHUB_ENVIRONMENT_MISMATCH',
    );
    const rules = environment.protection_rules
      .map(object)
      .filter((r) => r.type === 'required_reviewers');
    requireRelease(
      rules.length === 1 &&
        rules[0]!.prevent_self_review === true &&
        Array.isArray(rules[0]!.reviewers),
      'GITHUB_REVIEW_PROTECTION_UNVERIFIED',
    );
    const reviewers = (rules[0]!.reviewers as unknown[]).map(object);
    requireRelease(
      reviewers.length > 0 &&
        reviewers.length <= 6 &&
        reviewers.every((r) => r.type === 'User') &&
        reviewers.some((r) => id(object(r.reviewer).id) === claim.approverId),
      'GITHUB_REVIEWER_NOT_CONFIGURED',
    );
    const reviews = await this.get(`/actions/runs/${claim.runId}/approvals`);
    requireRelease(
      Array.isArray(reviews) && reviews.length > 0 && reviews.length <= 100,
      'GITHUB_REVIEW_HISTORY_UNVERIFIED',
    );
    const comment = `meshdrop-approval-v1:${claim.approvalId}:${fingerprint(claim)}`;
    const matches = reviews.map(object).filter((r) => {
      requireRelease(
        ['approved', 'rejected'].includes(String(r.state)) && Array.isArray(r.environments),
        'INVALID_GITHUB_RESPONSE',
      );
      return (
        id(object(r.user).id) === claim.approverId &&
        (r.environments as unknown[])
          .map(object)
          .some((v) => v.id === e.environmentId && v.name === e.environmentName) &&
        r.comment === comment
      );
    });
    requireRelease(
      matches.length === 1 &&
        matches[0]!.state === (claim.decision === 'REJECT' ? 'rejected' : 'approved'),
      'GITHUB_REVIEW_MISSING_CONFLICTING_OR_REJECTED',
    );
    requireRelease(
      this.now().getTime() < Date.parse(claim.expiresAt),
      'GITHUB_REVIEW_CLAIM_EXPIRED',
    );
    // Neither REST history nor GraphQL DeploymentReview exposes all of the
    // review timestamp, attempt binding and current revocation needed by Task 07.
    return {
      status: 'UNVERIFIED' as const,
      scope: this.#offline ? ('offline-fixture' as const) : ('github-api' as const),
      reviewerId: claim.approverId,
      identityObserved: !this.#offline,
      authorizationVerified: false as const,
      limitations: [
        'REVIEW_TIME_UNAVAILABLE',
        'REVIEW_ATTEMPT_BINDING_UNAVAILABLE',
        'REVOCATION_UNVERIFIED',
      ],
      publicationEnabled: false as const,
      acceptanceEnabled: false as const,
      productionApproved: false as const,
    };
  }
}
/** No ApprovalAuthority receipt can be manufactured from these diagnostics. */
export async function inspectApprovalEvidence(
  claimValue: unknown,
  bundle: Uint8Array,
  roots: Uint8Array,
  policy: AttestationPolicy,
  reader: GitHubReviewReader,
) {
  const claim = parseApprovalClaim(claimValue),
    pins = parseAttestationPolicy(policy);
  requireRelease(
    pins.repository === 'Shreshtha280407/MeshDrop' &&
      pins.sourceCommit === claim.sourceCommit &&
      pins.runId === claim.runId &&
      pins.runAttempt === claim.runAttempt,
    'APPROVAL_ATTESTATION_SCOPE_MISMATCH',
  );
  const signature = await verifyAttestation(Buffer.from(canonical(claim)), bundle, roots, pins);
  const review = await reader.inspect(claim, pins);
  return {
    status: 'UNVERIFIED' as const,
    signature,
    review,
    publicationEnabled: false as const,
    acceptanceEnabled: false as const,
    productionApproved: false as const,
  };
}
