/** Pages API access and rollback recovery. Provider bodies never enter diagnostics. */
export interface PagesDeployment {
  id: string;
  created_on: string;
  environment: 'production';
  project_name: string;
  latest_stage: { status: 'success' };
}

function deployment(value: unknown, project: string): PagesDeployment {
  const item = value as Partial<PagesDeployment> | null;
  if (
    !item ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id ?? '') ||
    item.project_name !== project ||
    item.environment !== 'production' ||
    item.latest_stage?.status !== 'success' ||
    !Number.isFinite(Date.parse(item.created_on ?? ''))
  )
    throw new Error('PAGES_INVALID_DEPLOYMENT');
  return {
    id: item.id!,
    created_on: item.created_on!,
    project_name: project,
    environment: 'production',
    latest_stage: { status: 'success' },
  };
}

export function previousDeployment(active: PagesDeployment, history: unknown[]): PagesDeployment {
  const candidates: PagesDeployment[] = [];
  for (const value of history) {
    try {
      const item = deployment(value, active.project_name);
      if (item.id !== active.id && Date.parse(item.created_on) < Date.parse(active.created_on))
        candidates.push(item);
    } catch {
      // Failed builds, branch previews and foreign projects are never rollback targets.
    }
  }
  candidates.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  if (!candidates[0]) throw new Error('PAGES_PREVIOUS_PRODUCTION_REQUIRED');
  return candidates[0];
}

export function pagesClient(
  account: string,
  project: string,
  token: string,
  transport: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z][a-z0-9-]{2,40}$/.test(project) || !token)
    throw new Error('PAGES_INVALID_CONFIGURATION');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}`;
  async function request(path = '', method = 'GET'): Promise<unknown> {
    try {
      const response = await transport(`${base}${path}`, {
        method,
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      });
      const result = (await response.json()) as { success?: boolean; result?: unknown };
      if (!response.ok || result.success !== true) throw new Error();
      return result.result;
    } catch {
      throw new Error('PAGES_PROVIDER_OPERATION_FAILED');
    }
  }
  return {
    async active(): Promise<PagesDeployment> {
      const result = (await request()) as { canonical_deployment?: unknown } | null;
      return deployment(result?.canonical_deployment, project);
    },
    async history(): Promise<unknown[]> {
      const result = await request('/deployments?env=production&per_page=25');
      if (!Array.isArray(result)) throw new Error('PAGES_INVALID_HISTORY');
      return result;
    },
    async promote(target: PagesDeployment): Promise<void> {
      const item = deployment(target, project);
      const result = await request(`/deployments/${item.id}/rollback`, 'POST');
      if (deployment(result, project).id !== item.id)
        throw new Error('PAGES_UNEXPECTED_DEPLOYMENT');
    },
  };
}

export interface PagesRollbackReport {
  phase: 'P9';
  scope: string;
  pass: boolean;
  latestDeployment: string;
  rollbackDeployment: string;
  restored: boolean;
  checks: string[];
  error: string;
}

/** The restore obligation begins before the first mutation, including a lost response. */
export async function exercisePagesRollback(options: {
  latest: PagesDeployment;
  previous: PagesDeployment;
  active(): Promise<PagesDeployment>;
  promote(target: PagesDeployment): Promise<void>;
  verify(stage: 'rollback' | 'restored'): Promise<void>;
}): Promise<PagesRollbackReport> {
  const latest = deployment(options.latest, options.latest.project_name);
  const previous = previousDeployment(latest, [options.previous]);
  const report: PagesRollbackReport = {
    phase: 'P9',
    scope: 'public preview Pages rollback and restoration; Worker version unchanged',
    pass: false,
    latestDeployment: latest.id,
    rollbackDeployment: previous.id,
    restored: false,
    checks: [],
    error: '',
  };
  let restorationRequired = false;
  async function restore() {
    const current = (await options.active()).id;
    if (current !== latest.id && current !== previous.id)
      throw new Error('PAGES_CONCURRENT_RELEASE');
    if (current !== latest.id) await options.promote(latest);
    if ((await options.active()).id !== latest.id) throw new Error();
    await options.verify('restored');
  }
  try {
    if ((await options.active()).id !== latest.id) throw new Error();
    restorationRequired = true;
    await options.promote(previous);
    if ((await options.active()).id !== previous.id) throw new Error();
    await options.verify('rollback');
    report.checks.push(
      'previous Pages deployment serves working control routes and changed assets',
    );
  } catch {
    report.error = 'PAGES_ROLLBACK_GATE_FAILED';
  } finally {
    if (restorationRequired) {
      try {
        await restore();
        report.restored = true;
        report.checks.push('original Pages deployment, assets and control routes restored');
      } catch {
        report.error = 'PAGES_RESTORATION_REQUIRES_ATTENTION';
      }
    }
  }
  report.pass = !report.error && report.restored && report.checks.length === 2;
  return report;
}
