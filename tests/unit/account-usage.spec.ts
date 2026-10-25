import { describe, expect, it, vi } from 'vitest';
import {
  accountAnalyticsConfigured,
  accountUsage,
  parseAccountUsage,
} from '../../apps/signaling/src/routes/account-usage';
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_ANALYTICS_API_TOKEN: 's'.repeat(40),
};
const sample = (rows: unknown) => ({
  data: {
    viewer: {
      accounts: [
        {
          workersInvocationsAdaptive: rows,
          pagesFunctionsInvocationsAdaptiveGroups: [],
          durableObjectsInvocationsAdaptiveGroups: [],
        },
      ],
    },
  },
});
describe('account provider usage', () => {
  it('requires an exact account and a scoped server credential', () => {
    expect(accountAnalyticsConfigured(env)).toBe(true);
    expect(accountAnalyticsConfigured({ ...env, CLOUDFLARE_ACCOUNT_ID: 'invalid' })).toBe(false);
  });
  it('retains only aggregates and an explicit UTC measurement window', () => {
    expect(
      parseAccountUsage(
        sample([{ sum: { requests: 80001, errors: 2 }, privateField: 'ignored' }]),
        86400100,
      ),
    ).toEqual({
      checkedAt: 86400100,
      dayStart: 86400000,
      requestsToday: 80001,
      workerRequestsToday: 80001,
      pagesRequestsToday: 0,
      durableRequestsToday: 0,
      errorsToday: 2,
    });
    expect(parseAccountUsage(sample([]), 1).requestsToday).toBe(0);
  });
  it.each([
    {},
    { errors: [{ message: 'secret error' }] },
    { data: { viewer: { accounts: [] } } },
    sample([{ sum: { requests: -1, errors: 0 } }]),
    sample([{ sum: { requests: 2, errors: NaN } }]),
    sample([{}, {}]),
  ])('does not turn unavailable or invalid evidence into zero', (value) => {
    expect(() => parseAccountUsage(value)).toThrow('ACCOUNT_USAGE_UNAVAILABLE');
  });
  it('uses only the fixed HTTPS endpoint, aggregate query and bounded no-redirect response', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json(sample([{ sum: { requests: 7, errors: 0 } }])));
    expect((await accountUsage(env, transport)).requestsToday).toBe(7);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init.redirect).toBe('manual');
    expect(init.headers.Authorization).toBe(`Bearer ${env.CLOUDFLARE_ANALYTICS_API_TOKEN}`);
    expect(init.body).not.toContain(env.CLOUDFLARE_ANALYTICS_API_TOKEN);
  });
  it('redacts provider denial and GraphQL error bodies', async () => {
    await expect(
      accountUsage(env, vi.fn().mockResolvedValue(new Response('private body', { status: 403 }))),
    ).rejects.toThrow('ACCOUNT_USAGE_UNAVAILABLE');
    await expect(
      accountUsage(
        env,
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ errors: [{ message: env.CLOUDFLARE_ANALYTICS_API_TOKEN }] }),
          ),
      ),
    ).rejects.toThrow('ACCOUNT_USAGE_UNAVAILABLE');
  });
});
