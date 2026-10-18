import { execFile, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { build } from 'esbuild';
import { deploymentConfig, environment } from './config';
import { ensureWorkersSubdomain } from './bootstrap';

const [command, targetValue] = process.argv.slice(2);
const target = environment(targetValue);
const root = process.cwd();
const envPath = resolve(root, 'infrastructure/cloudflare', target, '.env');
const wrangler = resolve(root, 'apps/signaling/node_modules/wrangler/bin/wrangler.js');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm deploy:cloud.');

async function run(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = await new Promise<number>((accept, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => accept(code ?? 1));
  });
  if (result)
    throw new Error('Deployment command failed; do not proceed to the next release step.');
}
async function files(directory: string, prefix = ''): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(hashes, await files(path, `${name}/`));
    else
      hashes[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
  return hashes;
}
try {
  if (command === 'init') {
    await mkdir(resolve(envPath, '..'), { recursive: true });
    const example = await readFile(resolve(root, 'infrastructure/cloudflare/.env.example'), 'utf8');
    await writeFile(
      envPath,
      example
        .replace(
          'meshdrop-yourname-preview',
          `meshdrop-${randomBytes(4).toString('hex')}-${target}`,
        )
        .replace(
          'OPS_REVOKE_SECRET=\n',
          `OPS_REVOKE_SECRET=${randomBytes(32).toString('base64url')}\n`,
        ),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(`Created private configuration: infrastructure/cloudflare/${target}/.env`);
  } else {
    if ((await stat(envPath)).mode & 0o077)
      throw new Error('Run chmod 600 on the environment .env first.');
    const values = parseEnv(await readFile(envPath, 'utf8'));
    const config = deploymentConfig(target, values, root);
    const env = {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
      ...(values.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN } : {}),
    };
    if (command === 'prepare') {
      await run(process.execPath, [pnpm, '--filter', '@meshdrop/web', 'build'], root, env);
      await mkdir(config.directory, { recursive: true });
      await rm(join(config.directory, 'web'), { recursive: true, force: true });
      await cp(resolve(root, 'apps/web/dist'), join(config.directory, 'web'), { recursive: true });
      await build({
        entryPoints: [resolve(root, 'infrastructure/cloudflare/pages-worker.ts')],
        outfile: join(config.directory, 'web/_worker.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
      });
      await build({
        entryPoints: [resolve(root, 'apps/signaling/src/index.ts')],
        outfile: join(config.directory, 'worker/index.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        external: ['cloudflare:workers'],
      });
      // Run the gateway for every request, including unknown/API routes. It adds
      // CSP itself because Pages _headers rules do not cover Function responses.
      await writeFile(
        join(config.directory, 'web/_routes.json'),
        JSON.stringify({ version: 1, include: ['/*'], exclude: [] }),
      );
      await writeFile(
        join(config.directory, 'worker.json'),
        JSON.stringify(config.worker, null, 2),
      );
      await writeFile(
        join(config.directory, 'wrangler.json'),
        JSON.stringify(config.pages, null, 2),
      );
      await writeFile(
        join(config.directory, 'manifest.json'),
        JSON.stringify(
          {
            environment: target,
            origin: config.origin,
            worker: config.workerName,
            files: await files(join(config.directory, 'web')),
            workerFiles: await files(join(config.directory, 'worker')),
          },
          null,
          2,
        ),
      );
      console.log(`Prepared ${target}: ${config.origin}. No remote changes.`);
    } else if (command === 'dry-run') {
      await run(
        process.execPath,
        [
          wrangler,
          'deploy',
          '--config',
          join(config.directory, 'worker.json'),
          '--dry-run',
          '--outdir',
          join(config.directory, 'worker-bundle'),
        ],
        root,
        env,
      );
    } else if (command === 'bootstrap') {
      let token = values.CLOUDFLARE_API_TOKEN;
      if (!token) {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [wrangler, 'auth', 'token', '--json'],
          { cwd: root, env },
        );
        const auth = JSON.parse(stdout) as { type?: string; token?: string };
        if (!['oauth', 'api_token'].includes(auth.type ?? '') || !auth.token)
          throw new Error('Use a Cloudflare OAuth login or scoped API token.');
        token = auth.token;
      }
      const subdomain = await ensureWorkersSubdomain(
        values.CLOUDFLARE_ACCOUNT_ID ?? '',
        config.project.replace(/-(preview|production)$/, ''),
        token,
      );
      console.log(
        `Workers account initialized: ${subdomain}.workers.dev (signaling public route remains disabled).`,
      );
    } else if (command === 'provision' || command === 'publish') {
      if (!/^[a-f0-9]{32}$/.test(values.CLOUDFLARE_ACCOUNT_ID ?? ''))
        throw new Error('Set CLOUDFLARE_ACCOUNT_ID in the private .env before remote changes.');
      if (command === 'provision') {
        await run(
          process.execPath,
          [
            wrangler,
            'pages',
            'project',
            'create',
            config.project,
            // Current Wrangler otherwise delegates first-time Pages creation to
            // Workers Assets. Pin the Pages product required by this architecture.
            '--force',
            '--production-branch',
            'release',
          ],
          config.directory,
          env,
        );
      } else {
        const manifest = JSON.parse(
          await readFile(join(config.directory, 'manifest.json'), 'utf8'),
        );
        if (
          manifest.environment !== target ||
          manifest.origin !== config.origin ||
          manifest.worker !== config.workerName ||
          JSON.stringify(manifest.files) !==
            JSON.stringify(await files(join(config.directory, 'web'))) ||
          JSON.stringify(manifest.workerFiles) !==
            JSON.stringify(await files(join(config.directory, 'worker'))) ||
          (await readFile(join(config.directory, 'worker.json'), 'utf8')) !==
            JSON.stringify(config.worker, null, 2) ||
          (await readFile(join(config.directory, 'wrangler.json'), 'utf8')) !==
            JSON.stringify(config.pages, null, 2)
        )
          throw new Error('Configuration/artifacts changed. Run prepare and dry-run again.');
        const secretFile = join(config.directory, '.env');
        await writeFile(
          secretFile,
          [
            'OPS_REVOKE_SECRET',
            'TURN_SHARED_SECRET',
            'CLOUDFLARE_TURN_KEY_ID',
            'CLOUDFLARE_TURN_API_TOKEN',
          ]
            .filter((key) => Boolean(values[key]?.trim()))
            .map((key) => `${key}=${JSON.stringify(values[key] ?? '')}`)
            .join('\n') + '\n',
          { mode: 0o600 },
        );
        await run(
          process.execPath,
          [
            wrangler,
            'deploy',
            '--config',
            join(config.directory, 'worker.json'),
            '--secrets-file',
            secretFile,
            '--no-bundle',
          ],
          root,
          env,
        );
        await run(
          process.execPath,
          [
            wrangler,
            'pages',
            'deploy',
            'web',
            '--project-name',
            config.project,
            '--branch',
            'release',
            '--commit-dirty=true',
          ],
          config.directory,
          env,
        );
        const health = await fetch(`${config.origin}/ready`);
        if (!health.ok || !((await health.json()) as { ready?: boolean }).ready)
          throw new Error('Public readiness failed. Follow docs/runbook.md.');
        console.log(
          `Published ${config.origin}. Device/relay release gates still require evidence.`,
        );
      }
    } else if (command === 'revoke') {
      const roomId = process.argv[4];
      if (!roomId || !/^[a-f0-9-]{36}$/.test(roomId))
        throw new Error('Supply the room UUID after the environment.');
      const response = await fetch(`${config.origin}/ops/rooms/${roomId}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${values.OPS_REVOKE_SECRET}` },
      });
      if (!response.ok) throw new Error(`Operator revocation failed (${response.status}).`);
      console.log('Room revoked.');
    } else
      throw new Error(
        'Use init, bootstrap, prepare, dry-run, provision, publish or revoke with preview|production.',
      );
  }
} catch (error) {
  // Errors constructed here contain configuration field names, never values.
  console.error(error instanceof Error ? error.message : 'Deployment failed.');
  process.exitCode = 1;
}
