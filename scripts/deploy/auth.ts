import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

/** Capture CLI auth privately; never print or persist the returned provider token. */
export async function cloudflareToken(values: Record<string, string | undefined>): Promise<string> {
  if (values.CLOUDFLARE_API_TOKEN) return values.CLOUDFLARE_API_TOKEN;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('apps/signaling/node_modules/wrangler/bin/wrangler.js'), 'auth', 'token', '--json'],
      { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    );
    const auth = JSON.parse(stdout) as { type?: string; token?: string };
    if (!['oauth', 'api_token'].includes(auth.type ?? '') || !auth.token) throw new Error();
    return auth.token;
  } catch {
    throw new Error('Use a Cloudflare OAuth login or scoped API token.');
  }
}
