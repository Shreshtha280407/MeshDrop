type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Initialize a new account only; never rename an existing Workers subdomain. */
export async function ensureWorkersSubdomain(
  accountId: string,
  subdomain: string,
  token: string,
  transport: Transport = fetch,
): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z][a-z0-9-]{2,50}$/.test(subdomain))
    throw new Error('Invalid Workers account/subdomain configuration.');
  if (!token) throw new Error('Cloudflare authentication is required.');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const existing = await transport(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = (await existing.json()) as {
    success?: boolean;
    result?: { subdomain?: string };
    errors?: { code?: number }[];
  };
  if (existing.ok && body.success && body.result?.subdomain) return body.result.subdomain;
  if (!body.errors?.some((error) => error.code === 10007))
    throw new Error(`Workers account lookup failed (${existing.status}).`);
  const created = await transport(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ subdomain }),
    signal: AbortSignal.timeout(20000),
  });
  const result = (await created.json()) as { success?: boolean; result?: { subdomain?: string } };
  if (!created.ok || !result.success || result.result?.subdomain !== subdomain)
    throw new Error(`Workers account initialization failed (${created.status}).`);
  return subdomain;
}
