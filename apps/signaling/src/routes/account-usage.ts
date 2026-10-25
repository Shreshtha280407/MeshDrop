import type { Env } from '../env';
import { readJson } from '../limits';
import { accountAnalyticsConfigured } from '../account-usage-config';
export { accountAnalyticsConfigured } from '../account-usage-config';
export interface AccountUsage {
  checkedAt: number;
  dayStart: number;
  requestsToday: number;
  workerRequestsToday: number;
  pagesRequestsToday: number;
  durableRequestsToday: number;
  errorsToday: number;
}
export const ACCOUNT_USAGE_REFRESH_MS = 900000;
type AccountEnv = Pick<Env, 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_ANALYTICS_API_TOKEN'>;

export function parseAccountUsage(value: unknown, now = Date.now()): AccountUsage {
  type Row = { sum?: { requests?: number; errors?: number } };
  const data = value as {
    errors?: unknown[] | null;
    data?: {
      viewer?: {
        accounts?: {
          workersInvocationsAdaptive?: Row[];
          pagesFunctionsInvocationsAdaptiveGroups?: Row[];
          durableObjectsInvocationsAdaptiveGroups?: Row[];
        }[];
      };
    };
  } | null;
  const accounts = data?.data?.viewer?.accounts;
  if (
    !data ||
    (data.errors != null && (!Array.isArray(data.errors) || data.errors.length)) ||
    !Array.isArray(accounts) ||
    accounts.length !== 1
  )
    throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
  function total(rows: Row[] | undefined, field: 'requests' | 'errors'): number {
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
    const count = rows.length ? rows[0]?.sum?.[field] : 0;
    if (!Number.isSafeInteger(count) || count! < 0) throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
    return count!;
  }
  const account = accounts[0]!;
  const workerRequestsToday = total(account.workersInvocationsAdaptive, 'requests');
  const pagesRequestsToday = total(account.pagesFunctionsInvocationsAdaptiveGroups, 'requests');
  const durableRequestsToday = total(account.durableObjectsInvocationsAdaptiveGroups, 'requests');
  const requestsToday = workerRequestsToday + pagesRequestsToday;
  const errorsToday =
    total(account.workersInvocationsAdaptive, 'errors') +
    total(account.pagesFunctionsInvocationsAdaptiveGroups, 'errors');
  if (!Number.isSafeInteger(requestsToday) || !Number.isSafeInteger(errorsToday))
    throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
  return {
    checkedAt: now,
    dayStart: Math.floor(now / 86400000) * 86400000,
    requestsToday,
    workerRequestsToday,
    pagesRequestsToday,
    durableRequestsToday,
    errorsToday,
  };
}

/** Aggregate provider analytics, not an invoice or a guaranteed real-time counter. */
export async function accountUsage(
  env: AccountEnv,
  transport: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<AccountUsage> {
  if (!accountAnalyticsConfigured(env)) throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
  const now = Date.now();
  try {
    const response = await transport('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'query($account: string, $start: string, $end: string) { viewer { accounts(filter:{accountTag:$account}) { workersInvocationsAdaptive(limit:1, filter:{datetime_geq:$start,datetime_lt:$end}) { sum { requests errors } } pagesFunctionsInvocationsAdaptiveGroups(limit:1, filter:{datetime_geq:$start,datetime_lt:$end}) { sum { requests errors } } durableObjectsInvocationsAdaptiveGroups(limit:1, filter:{datetime_geq:$start,datetime_lt:$end}) { sum { requests } } } } }',
        variables: {
          account: env.CLOUDFLARE_ACCOUNT_ID,
          start: new Date(Math.floor(now / 86400000) * 86400000).toISOString(),
          end: new Date(now).toISOString(),
        },
      }),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new Error();
    }
    return parseAccountUsage(await readJson(response), now);
  } catch {
    throw new Error('ACCOUNT_USAGE_UNAVAILABLE');
  }
}
