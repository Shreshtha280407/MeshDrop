import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admissionIntent, explicitPause } from './release-lifecycle';
import { requireRelease } from './release-record';

const KEYS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'PAGES_PROJECT',
  'PUBLIC_ORIGIN',
  'OPS_REVOKE_SECRET',
  'ADMISSION_PAUSED',
  'ADMISSION_ACTION',
  'ADMISSION_REOPEN_CONFIRMATION',
  'TURN_PROVIDER',
  'TURN_URLS',
  'TURN_SHARED_SECRET',
  'CLOUDFLARE_TURN_KEY_ID',
  'CLOUDFLARE_TURN_API_TOKEN',
  'METERED_DOMAIN',
  'METERED_FREE_ONLY',
  'METERED_SECRET_KEY',
  'CLOUDFLARE_ANALYTICS_API_TOKEN',
] as const;

/** Creates only a new workflow-owned file; output failure removes only that file. */
export async function writeWorkflowEnvironment(
  root: string,
  target: string,
  values: Record<string, string | undefined>,
  recordCreation: () => Promise<void>,
): Promise<void> {
  requireRelease(target === 'preview' || target === 'production', 'INVALID_WORKFLOW_ENVIRONMENT');
  explicitPause(values.ADMISSION_PAUSED);
  admissionIntent(values.ADMISSION_ACTION, values.ADMISSION_REOPEN_CONFIRMATION);
  const directory = resolve(root, 'infrastructure/cloudflare', target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, '.env');
  let owned = false;
  try {
    const handle = await open(file, 'wx', 0o600);
    owned = true;
    try {
      await handle.writeFile(
        KEYS.map((key) => `${key}=${JSON.stringify(values[key] ?? '')}`).join('\n') + '\n',
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await recordCreation();
  } catch (error) {
    if (owned) await rm(file);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const output = process.env.GITHUB_OUTPUT;
    requireRelease(output, 'WORKFLOW_OUTPUT_REQUIRED');
    await writeWorkflowEnvironment(process.cwd(), process.env.TARGET ?? '', process.env, () =>
      writeFile(output, 'created=true\n', { flag: 'a' }),
    );
  } catch {
    console.error('WORKFLOW_ENVIRONMENT_CREATION_FAILED');
    process.exitCode = 1;
  }
}
