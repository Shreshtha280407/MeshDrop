import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubReviewReader } from '../../scripts/deploy/github-reviews';
import type { ReviewExpectation } from '../../scripts/deploy/github-reviews';
import { fingerprint } from '../../scripts/deploy/release-record';
import { hostedApprovalAuthority } from '../../scripts/deploy/release-approval';
import { controlsFixture } from '../fixtures/release-controls';

const TOKEN = 'offline-review-token-canary';
async function fixture() {
  const f = await controlsFixture();
  const expected: ReviewExpectation = {
    repository: 'Shreshtha280407/MeshDrop',
    repositoryId: '101',
    ownerId: '102',
    environment: 'preview',
    environmentId: 606,
    environmentName: 'preview-publication',
    workflowPath: '.github/workflows/review.yml',
    purpose: 'publication',
    publicationApproverId: null,
    policy: f.context.policy,
  };
  const reviews = [
    {
      state: 'approved',
      comment: `meshdrop-approval-v1:${f.claim.approvalId}:${fingerprint(f.claim)}`,
      environments: [{ id: 606, name: expected.environmentName }],
      user: { id: 202, login: 'untrusted-display-name' },
    },
  ];
  const responses: Record<string, unknown> = {
    '': { id: 101, full_name: expected.repository, owner: { id: 102 } },
    [`/actions/runs/${f.claim.runId}/attempts/1`]: {
      id: Number(f.claim.runId),
      run_attempt: 1,
      head_sha: f.claim.sourceCommit,
      repository: { id: 101 },
      actor: { id: 101 },
      triggering_actor: { id: 101 },
      workflow_id: 505,
    },
    '/actions/workflows/505': { path: expected.workflowPath, state: 'active' },
    [`/environments/${expected.environmentName}`]: {
      id: 606,
      name: expected.environmentName,
      protection_rules: [
        {
          type: 'required_reviewers',
          prevent_self_review: true,
          reviewers: [{ type: 'User', reviewer: { id: 202 } }],
        },
      ],
    },
    [`/actions/runs/${f.claim.runId}/approvals`]: reviews,
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200,
    contentType = 'application/json',
    link = '',
    raw: string | null = null;
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace(`/repos/${expected.repository}`, '');
    expect(Object.hasOwn(responses, path)).toBe(true);
    return new Response(raw ?? JSON.stringify(responses[path]), {
      status,
      headers: { 'content-type': contentType, ...(link ? { link } : {}) },
    });
  });
  const reader = new GitHubReviewReader(expected, TOKEN, transport, f.context.now);
  return {
    ...f,
    expected,
    responses,
    reviews,
    calls,
    transport,
    reader,
    setStatus(v: number) {
      status = v;
    },
    setRaw(v: string) {
      raw = v;
    },
    setContentType(v: string) {
      contentType = v;
    },
    setLink(v: string) {
      link = v;
    },
  };
}
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real account access forbidden.'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('documented read-only GitHub reviewer evidence boundary', () => {
  it('keeps the credential out of serialized reader objects and sanitized diagnostics', async () => {
    const f = await fixture();
    expect(JSON.stringify(f.reader)).not.toContain(TOKEN);
    expect(JSON.stringify(await f.reader.inspect(f.claim))).not.toContain(TOKEN);
  });
  it('cannot promote injected responses by relabeling the reader', async () => {
    const f = await fixture();
    Object.defineProperty(f.reader, 'scope', { value: 'github-api' });
    expect(await f.reader.inspect(f.claim)).toMatchObject({
      scope: 'offline-fixture',
      identityObserved: false,
      authorizationVerified: false,
    });
  });
  it('binds fixture review identity but does not fabricate time, attempt or revocation proof', async () => {
    const f = await fixture();
    const result = await f.reader.inspect(f.claim);
    expect(result).toMatchObject({
      status: 'UNVERIFIED',
      scope: 'offline-fixture',
      identityObserved: false,
      authorizationVerified: false,
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    });
    expect(result.limitations).toEqual([
      'REVIEW_TIME_UNAVAILABLE',
      'REVIEW_ATTEMPT_BINDING_UNAVAILABLE',
      'REVOCATION_UNVERIFIED',
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('untrusted-display-name');
    for (const { url, init } of f.calls) {
      expect(new URL(url).origin).toBe('https://api.github.com');
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
    }
    expect(hostedApprovalAuthority).toThrow('HOSTED_APPROVAL_AUTHORITY_NOT_CONFIGURED');
  });
  it.each([
    ['repository ID', '', 'id', 999],
    ['owner', '', 'owner', { id: 999 }],
    ['run source', '/actions/runs/404/attempts/1', 'head_sha', 'b'.repeat(40)],
    ['run attempt', '/actions/runs/404/attempts/1', 'run_attempt', 2],
    ['triggering actor', '/actions/runs/404/attempts/1', 'triggering_actor', { id: 999 }],
    ['workflow', '/actions/workflows/505', 'path', '.github/workflows/attacker.yml'],
    ['environment', '/environments/preview-publication', 'id', 999],
  ])('rejects mismatched %s', async (_name, path, key, value) => {
    const f = await fixture();
    (f.responses[String(path)] as Record<string, unknown>)[String(key)] = value;
    await expect(f.reader.inspect(f.claim)).rejects.toThrow();
  });
  it.each([
    'environment',
    'workerVersion',
    'pagesDeployment',
    'manifestId',
    'providerObservationId',
    'runAttempt',
  ] as const)('rejects a substituted %s bound to the signed/reviewed claim', async (key) => {
    const f = await fixture();
    if (key === 'runAttempt') f.claim.runAttempt = 2;
    else if (key === 'environment') f.claim.environment = 'production';
    else if (key === 'workerVersion' || key === 'pagesDeployment')
      f.claim[key] = '90000000-0000-4000-8000-000000000001';
    else f.claim[key] = '0'.repeat(64);
    await expect(f.reader.inspect(f.claim)).rejects.toThrow();
  });
  it('rejects a display-name match without the authorized reviewer ID', async () => {
    const f = await fixture();
    f.reviews[0]!.user.id = 999;
    await expect(f.reader.inspect(f.claim)).rejects.toThrow(
      'GITHUB_REVIEW_MISSING_CONFLICTING_OR_REJECTED',
    );
  });
  it('rejects missing, conflicting or rejected reviews without assuming list order', async () => {
    const f = await fixture();
    f.reviews.push({ ...f.reviews[0]!, state: 'rejected' });
    await expect(f.reader.inspect(f.claim)).rejects.toThrow(
      'GITHUB_REVIEW_MISSING_CONFLICTING_OR_REJECTED',
    );
    f.reviews.shift();
    await expect(f.reader.inspect(f.claim)).rejects.toThrow(
      'GITHUB_REVIEW_MISSING_CONFLICTING_OR_REJECTED',
    );
    f.reviews.length = 0;
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_REVIEW_HISTORY_UNVERIFIED');
  });
  it('rejects self approval and publication/acceptance reviewer collision', async () => {
    const f = await fixture();
    f.claim.approverId = f.claim.requestedById;
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_REVIEWER_NOT_AUTHORIZED');
    f.claim.approverId = '202';
    f.claim.purpose = 'acceptance';
    f.claim.decision = 'ACCEPT';
    f.claim.evidence = (await controlsFixture('acceptance')).claim.evidence;
    f.expected.purpose = 'acceptance';
    f.expected.publicationApproverId = '202';
    f.expected.policy.acceptanceApprovers = ['202'];
    await expect(
      new GitHubReviewReader(f.expected, TOKEN, f.transport, f.context.now).inspect(f.claim),
    ).rejects.toThrow('GITHUB_REVIEWER_NOT_AUTHORIZED');
  });
  it('rejects expired claims instead of borrowing environment creation timestamps', async () => {
    const f = await fixture();
    f.setTime(new Date(f.claim.expiresAt));
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_REVIEW_CLAIM_EXPIRED');
  });
  it('rejects insufficient protection and unsupported team membership assumptions', async () => {
    const f = await fixture();
    const env = f.responses['/environments/preview-publication'] as {
      protection_rules: { prevent_self_review: boolean; reviewers: { type: string }[] }[];
    };
    env.protection_rules[0]!.prevent_self_review = false;
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_REVIEW_PROTECTION_UNVERIFIED');
    env.protection_rules[0]!.prevent_self_review = true;
    env.protection_rules[0]!.reviewers[0]!.type = 'Team';
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_REVIEWER_NOT_CONFIGURED');
  });
  it.each([401, 403, 429, 500, 302])('fails closed for API status %s', async (status) => {
    const f = await fixture();
    f.setStatus(status);
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_READ_INCOMPLETE_OR_FAILED');
  });
  it('rejects malformed, oversized and non-JSON replies', async () => {
    const f = await fixture();
    f.setRaw('{');
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_READ_UNAVAILABLE');
    f.setRaw('x'.repeat(262145));
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_RESPONSE_LIMIT');
    f.setContentType('text/html');
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('INVALID_GITHUB_RESPONSE');
  });
  it('rejects pagination instead of trusting an incomplete approval history', async () => {
    const f = await fixture();
    f.setLink('<https://attacker.invalid>; rel="next"');
    await expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_READ_INCOMPLETE_OR_FAILED');
    expect(f.calls).toHaveLength(1);
  });
  it('sanitizes transport failures and rejects missing credentials', async () => {
    const f = await fixture();
    f.transport.mockRejectedValueOnce(new Error(TOKEN));
    await expect(f.reader.inspect(f.claim)).rejects.toThrow(/^GITHUB_READ_UNAVAILABLE$/);
    expect(() => new GitHubReviewReader(f.expected, '')).toThrow('GITHUB_READ_CREDENTIAL_REQUIRED');
  });
  it('bounds unavailable verifier requests', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.transport.mockImplementationOnce(() => new Promise(() => {}));
    const result = expect(f.reader.inspect(f.claim)).rejects.toThrow('GITHUB_READ_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10001);
    await result;
  });
});
