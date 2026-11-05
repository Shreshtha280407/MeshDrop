import { requireRelease, ReleaseError } from '../deploy/release-record';
import { assertNoDeployCredentials, ID, SHA, UUID, WORKFLOW } from './contract';
import type { RehearsalExpectation } from './contract';

export type Runtime = Record<string, string | undefined>;
export function runtimeExpectation(env: Runtime, rehearsalId: string): RehearsalExpectation {
  assertNoDeployCredentials(env);
  requireRelease(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REPOSITORY === 'Shreshtha280407/MeshDrop' &&
      env.REHEARSAL_RUNNER_KIND === 'github-hosted' &&
      env.GITHUB_SHA === env.REHEARSAL_EXPECTED_SOURCE &&
      env.GITHUB_SHA === env.REHEARSAL_WORKFLOW_SHA &&
      typeof env.GITHUB_SHA === 'string' &&
      SHA.test(env.GITHUB_SHA) &&
      env.GITHUB_REF === env.REHEARSAL_EXPECTED_REF &&
      typeof env.GITHUB_REF === 'string' &&
      /^refs\/(heads|tags)\/[A-Za-z0-9_./-]+$/.test(env.GITHUB_REF) &&
      env.GITHUB_WORKFLOW_REF === `Shreshtha280407/MeshDrop/${WORKFLOW}@${env.GITHUB_REF}` &&
      typeof env.TRUST_REHEARSAL_REPOSITORY_ID === 'string' &&
      ID.test(env.TRUST_REHEARSAL_REPOSITORY_ID) &&
      env.GITHUB_REPOSITORY_ID === env.TRUST_REHEARSAL_REPOSITORY_ID &&
      typeof env.TRUST_REHEARSAL_OWNER_ID === 'string' &&
      ID.test(env.TRUST_REHEARSAL_OWNER_ID) &&
      env.GITHUB_REPOSITORY_OWNER_ID === env.TRUST_REHEARSAL_OWNER_ID &&
      (env.REHEARSAL_ENVIRONMENT === 'preview' || env.REHEARSAL_ENVIRONMENT === 'production') &&
      typeof env.GITHUB_RUN_ID === 'string' &&
      ID.test(env.GITHUB_RUN_ID) &&
      typeof env.GITHUB_RUN_ATTEMPT === 'string' &&
      /^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT) &&
      UUID.test(rehearsalId),
    'INVALID_REHEARSAL_RUNTIME_IDENTITY',
  );
  return {
    repositoryId: env.GITHUB_REPOSITORY_ID,
    ownerId: env.GITHUB_REPOSITORY_OWNER_ID,
    environment: env.REHEARSAL_ENVIRONMENT,
    sourceCommit: env.GITHUB_SHA,
    sourceRef: env.GITHUB_REF,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    rehearsalId,
  };
}
export async function inspectEnvironment(env: Runtime, transport: typeof fetch = fetch) {
  // This sentinel only validates context before a real UUID is generated.
  const identity = runtimeExpectation(env, '00000000-0000-4000-8000-000000000000');
  const name = `trust-rehearsal-${identity.environment}`;
  const expectedId =
    env[
      identity.environment === 'preview'
        ? 'TRUST_REHEARSAL_PREVIEW_ENVIRONMENT_ID'
        : 'TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID'
    ];
  requireRelease(
    typeof expectedId === 'string' && ID.test(expectedId) && env.GITHUB_TOKEN,
    'REHEARSAL_ENVIRONMENT_NOT_CONFIGURED',
  );
  let reviewers: unknown;
  try {
    reviewers = JSON.parse(env.TRUST_REHEARSAL_REVIEWER_IDS ?? '');
  } catch {
    throw new ReleaseError('REHEARSAL_REVIEWERS_NOT_CONFIGURED');
  }
  requireRelease(
    Array.isArray(reviewers) &&
      reviewers.length > 0 &&
      reviewers.length <= 6 &&
      reviewers.every((v) => typeof v === 'string' && ID.test(v)) &&
      new Set(reviewers).size === reviewers.length,
    'REHEARSAL_REVIEWERS_NOT_CONFIGURED',
  );
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  const aborted = new Promise<never>((_, reject) =>
    controller.signal.addEventListener(
      'abort',
      () => reject(new ReleaseError('REHEARSAL_ENVIRONMENT_TIMEOUT')),
      { once: true },
    ),
  );
  try {
    const response = await Promise.race([
      transport(`https://api.github.com/repos/Shreshtha280407/MeshDrop/environments/${name}`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }),
      aborted,
    ]);
    requireRelease(
      response.status === 200 && !response.redirected && !response.headers.get('link'),
      'REHEARSAL_ENVIRONMENT_READ_FAILED',
    );
    const reader = response.body?.getReader();
    requireRelease(reader, 'REHEARSAL_ENVIRONMENT_READ_FAILED');
    let count = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        count += value.byteLength;
        requireRelease(count <= 65536, 'REHEARSAL_ENVIRONMENT_RESPONSE_LIMIT');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const rules = Array.isArray(data.protection_rules)
      ? data.protection_rules.filter((r: { type?: string }) => r.type === 'required_reviewers')
      : [];
    requireRelease(
      Number.isSafeInteger(data.id) &&
        String(data.id) === expectedId &&
        data.name === name &&
        rules.length === 1 &&
        rules[0].prevent_self_review === true &&
        Array.isArray(rules[0].reviewers) &&
        rules[0].reviewers.every(
          (r: { type?: string; reviewer?: { id?: number } }) =>
            r.type === 'User' && Number.isSafeInteger(r.reviewer?.id),
        ) &&
        rules[0].reviewers
          .map((r: { reviewer: { id: number } }) => String(r.reviewer.id))
          .sort()
          .join(',') === [...reviewers].sort().join(',') &&
        data.deployment_branch_policy?.custom_branch_policies === true &&
        data.deployment_branch_policy?.protected_branches === false,
      'REHEARSAL_ENVIRONMENT_PROTECTION_UNVERIFIED',
    );
    return {
      environmentName: name,
      environmentId: expectedId,
      environmentReview: 'JOB_GATE_ONLY' as const,
      authorizationVerified: false as const,
      productionApproved: false as const,
    };
  } catch (error) {
    throw error instanceof ReleaseError
      ? error
      : new ReleaseError('REHEARSAL_ENVIRONMENT_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
