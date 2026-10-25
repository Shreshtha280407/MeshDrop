import type { PagesDeployment } from './pages-rollback';

export interface ReleasePair {
  origin: string;
  project: string;
  workerName: string;
  workerVersion: string;
  pages: PagesDeployment;
  assets: { module: string; sha256: string };
}
export interface ActivePair {
  workerVersion: string;
  pagesDeployment: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pair = (release: ReleasePair): ActivePair => ({
  workerVersion: release.workerVersion,
  pagesDeployment: release.pages.id,
});
const same = (left: ActivePair, right: ActivePair) =>
  left.workerVersion === right.workerVersion && left.pagesDeployment === right.pagesDeployment;

export function validateRelease(release: ReleasePair): ReleasePair {
  if (
    !/^[a-z][a-z0-9-]{2,40}-preview$/.test(release.project) ||
    release.origin !== `https://${release.project}.pages.dev` ||
    release.workerName !== `${release.project}-signaling` ||
    !uuid.test(release.workerVersion) ||
    !uuid.test(release.pages.id) ||
    release.pages.project_name !== release.project ||
    release.pages.environment !== 'production' ||
    release.pages.latest_stage.status !== 'success' ||
    !Number.isFinite(Date.parse(release.pages.created_on)) ||
    !/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(release.assets.module) ||
    !/^[a-f0-9]{64}$/.test(release.assets.sha256)
  )
    throw new Error('PRODUCT_INVALID_PREVIEW_RELEASE');
  // Keep restore records limited to the fields this drill needs. Pages history
  // responses may contain environment variables or other provider extras.
  return {
    origin: release.origin,
    project: release.project,
    workerName: release.workerName,
    workerVersion: release.workerVersion,
    pages: {
      id: release.pages.id,
      created_on: release.pages.created_on,
      environment: 'production',
      project_name: release.project,
      latest_stage: { status: 'success' },
    },
    assets: { module: release.assets.module, sha256: release.assets.sha256 },
  };
}

/** Restricted Worker API; never propagate a provider body, secret or raw error. */
export function workerDeploymentClient(
  account: string,
  worker: string,
  token: string,
  transport: typeof fetch = fetch,
  options: { allowedSecretChanges?: readonly string[] } = {},
) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z][a-z0-9-]{2,60}$/.test(worker) || !token)
    throw new Error('PRODUCT_INVALID_PROVIDER_CONFIGURATION');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/deployments`;
  const allowed = options.allowedSecretChanges ?? [];
  const providerSecrets = [
    'METERED_SECRET_KEY',
    'CLOUDFLARE_ANALYTICS_API_TOKEN',
    'TURN_SHARED_SECRET',
    'CLOUDFLARE_TURN_KEY_ID',
    'CLOUDFLARE_TURN_API_TOKEN',
  ];
  if (!Array.isArray(allowed) || allowed.some((name) => !providerSecrets.includes(name)))
    throw new Error('PRODUCT_UNSAFE_SECRET_ROLLBACK_CONFIRMATION');
  async function request(method = 'GET', body?: unknown) {
    let status = 0;
    let codes: number[] = [];
    try {
      let force = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await transport(endpoint + (force ? '?force=true' : ''), {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        status = response.status;
        const result = (await response.json()) as {
          errors?: { code?: unknown; message?: unknown }[];
          success?: boolean;
          result?: {
            deployments?: { versions?: { version_id?: string; percentage?: number }[] }[];
          };
        };
        codes = (result.errors ?? [])
          .map((item) => item.code)
          .filter((code): code is number => Number.isSafeInteger(code));
        if (response.ok && result.success) return result.result;
        // Cloudflare requires an explicit confirmation when rolling across a
        // secret change. Only names reviewed in the private release record can
        // authorize this retry; operator secrets can never be confirmed here.
        const error = result.errors?.find((item) => item.code === 10220);
        const suffix =
          typeof error?.message === 'string'
            ? error.message.split('The following secrets have changed:')[1]
            : undefined;
        const names = suffix?.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
        if (
          !force &&
          method === 'POST' &&
          codes.includes(10220) &&
          names.length > 0 &&
          names.every((name) => allowed.includes(name))
        ) {
          force = true;
          continue;
        }
        throw new Error();
      }
      throw new Error();
    } catch {
      throw new Error('PRODUCT_PROVIDER_OPERATION_FAILED', { cause: { status, codes } });
    }
  }

  return {
    async active(): Promise<string> {
      const versions = (await request())?.deployments?.[0]?.versions;
      if (
        versions?.length !== 1 ||
        versions[0]?.percentage !== 100 ||
        !uuid.test(versions[0].version_id ?? '')
      )
        throw new Error('PRODUCT_SINGLE_ACTIVE_WORKER_REQUIRED');
      return versions[0]!.version_id!;
    },
    async promote(version: string): Promise<void> {
      if (!uuid.test(version)) throw new Error('PRODUCT_INVALID_WORKER_VERSION');
      await request('POST', {
        strategy: 'percentage',
        versions: [{ version_id: version, percentage: 100 }],
        annotations: { 'workers/message': 'MeshDrop preview coordinated rollback verification' },
      });
    },
  };
}

/** Each component is restored after a partial/lost response. This is not atomic. */
export async function exerciseProductRollback(options: {
  latest: ReleasePair;
  previous: ReleasePair;
  active(): Promise<ActivePair>;
  promoteWorker(version: string): Promise<void>;
  promotePages(deployment: PagesDeployment): Promise<void>;
  verify(stage: 'rollback' | 'restored', expected: ReleasePair): Promise<void>;
}) {
  const latest = validateRelease(options.latest);
  const previous = validateRelease(options.previous);
  if (
    latest.origin !== previous.origin ||
    latest.project !== previous.project ||
    latest.workerName !== previous.workerName ||
    latest.pages.id === previous.pages.id ||
    latest.workerVersion === previous.workerVersion ||
    Date.parse(previous.pages.created_on) >= Date.parse(latest.pages.created_on)
  )
    throw new Error('PRODUCT_DISTINCT_COMPATIBLE_TARGETS_REQUIRED');
  const report = {
    phase: 'P9',
    scope:
      'coordinated public preview Pages/Worker rollback, persisted room and real browser transfer/receipt checks',
    origin: latest.origin,
    pass: false,
    latest: pair(latest),
    rollback: pair(previous),
    restored: false,
    checks: [] as string[],
    error: '',
  };
  let restoreRequired = false;
  async function allowedState() {
    const state = await options.active();
    if (
      ![latest.workerVersion, previous.workerVersion].includes(state.workerVersion) ||
      ![latest.pages.id, previous.pages.id].includes(state.pagesDeployment)
    )
      throw new Error('PRODUCT_CONCURRENT_RELEASE');
    return state;
  }
  async function restore() {
    // Try both components even if one restore fails. Re-read before every write;
    // never overwrite a detected third deployment/version.
    for (const component of ['worker', 'pages'] as const) {
      const state = await allowedState();
      try {
        if (component === 'worker' && state.workerVersion !== latest.workerVersion)
          await options.promoteWorker(latest.workerVersion);
        if (component === 'pages' && state.pagesDeployment !== latest.pages.id)
          await options.promotePages(latest.pages);
      } catch {
        // Read-after-write below determines whether a response was merely lost.
      }
    }
    if (!same(await options.active(), pair(latest))) throw new Error('PRODUCT_RESTORE_INCOMPLETE');
    await options.verify('restored', latest);
  }
  try {
    if (!same(await options.active(), pair(latest))) throw new Error('PRODUCT_CHANGED_PREFLIGHT');
    restoreRequired = true;
    await options.promoteWorker(previous.workerVersion);
    const partial = await allowedState();
    if (
      partial.workerVersion !== previous.workerVersion ||
      partial.pagesDeployment !== latest.pages.id
    )
      throw new Error('PRODUCT_UNEXPECTED_PARTIAL_RELEASE');
    await options.promotePages(previous.pages);
    if (!same(await options.active(), pair(previous)))
      throw new Error('PRODUCT_ROLLBACK_INCOMPLETE');
    await options.verify('rollback', previous);
    report.checks.push(
      'previous compatible pair serves the recorded client and passes persisted-room plus fresh transfer/receipt gates',
    );
  } catch {
    report.error = 'PRODUCT_ROLLBACK_GATE_FAILED';
  } finally {
    if (restoreRequired) {
      try {
        await restore();
        report.restored = true;
        report.checks.push(
          'original pair and exact assets restored; persisted-room and fresh transfer/receipt gates pass',
        );
      } catch {
        report.error = 'PRODUCT_RESTORATION_REQUIRES_ATTENTION';
      }
    }
  }
  report.pass = !report.error && report.restored && report.checks.length === 2;
  return report;
}
