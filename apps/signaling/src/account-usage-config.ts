export type AccountAnalyticsSettings = {
  [Key in 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_ANALYTICS_API_TOKEN']?: string | undefined;
};
export function accountAnalyticsConfigured(env: AccountAnalyticsSettings): boolean {
  return (
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') &&
    /^[A-Za-z0-9_-]{20,256}$/.test(env.CLOUDFLARE_ANALYTICS_API_TOKEN ?? '')
  );
}
