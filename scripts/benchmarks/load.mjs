import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fixed local test plans, with no arbitrary command or public-origin argument. */
export function localLoadPlan(mode, ambient, credentialFiles = []) {
  if (!['matrix', 'browser'].includes(mode))
    throw Error('Choose matrix or browser local load mode.');
  if (credentialFiles.length)
    throw Error(
      'Local load refuses signaling .dev.vars files; preserve them and use an isolated checkout.',
    );
  const env = { ...ambient };
  for (const key of Object.keys(env))
    if (
      /^(CLOUDFLARE_|METERED_|TURN_|OPS_|MESHDROP_|BROWSERSTACK_|GITHUB_TOKEN$|GH_TOKEN$)/.test(key)
    )
      delete env[key];
  Object.assign(env, {
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    MESHDROP_SIGNAL_ORIGIN: 'http://127.0.0.1:8787',
    ENVIRONMENT: 'development',
    ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    ADMISSION_PAUSED: 'false',
  });
  const steps =
    mode === 'browser'
      ? [
          [
            'exec',
            'playwright',
            'test',
            'tests/e2e/concurrent-transfers.spec.ts',
            '--workers',
            '1',
            '--retries',
            '0',
          ],
        ]
      : [
          [
            'exec',
            'vitest',
            'run',
            '--project',
            'integration',
            'tests/integration/concurrency-load.spec.ts',
            'tests/integration/load-cleanup.spec.ts',
            'tests/integration/load-operations.spec.ts',
            'tests/integration/load-rate-limits.spec.ts',
            'tests/integration/load-relay.spec.ts',
          ],
          [
            'exec',
            'vitest',
            'run',
            '--project',
            'security',
            'tests/security/peer-reconnect-flood.spec.ts',
            'tests/security/rate-load.spec.ts',
          ],
          [
            'exec',
            'vitest',
            'run',
            '--project',
            'faults',
            'tests/faults/concurrent-transfers.spec.ts',
          ],
        ];
  return { env, steps };
}
async function main() {
  if (process.argv.length > 3) throw Error('Unexpected local load argument.');
  const privateFiles = readdirSync('apps/signaling').filter((name) =>
    /^\.dev\.vars(?:\.|$)/.test(name),
  );
  const { env, steps } = localLoadPlan(process.argv[2] ?? 'matrix', process.env, privateFiles);
  const manager = process.env.npm_execpath;
  if (!manager || !/pnpm\.(?:cjs|js)$/.test(manager))
    throw Error('Run this command through pnpm test:load or pnpm test:load:browser.');
  for (const args of steps) {
    const code = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [manager, ...args], {
        env,
        stdio: 'inherit',
        shell: false,
      });
      child.once('error', () => reject(Error('Local load command could not start.')));
      child.once('exit', (code) => accept(code));
    });
    if (code !== 0) {
      process.exitCode = 1;
      return;
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
