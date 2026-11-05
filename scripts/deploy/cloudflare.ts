import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv, promisify } from 'node:util';
import { deploymentConfig, environment } from './config';
import { ensureWorkersSubdomain } from './bootstrap';
import { collectSource, prepareRelease, verifyPreparedArtifacts } from './release-preparation';
import { parseManifest, requireRelease, ReleaseError } from './release-record';
import { writeBlockedPublication } from './release-lifecycle';

const [command, targetValue, directoryValue] = process.argv.slice(2);
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
async function releaseDirectory() {
  requireRelease(directoryValue, 'EXPLICIT_RELEASE_DIRECTORY_REQUIRED');
  const base = await realpath(resolve(root, '.meshdrop-artifacts/deploy', target));
  const directory = await realpath(resolve(root, directoryValue));
  requireRelease(
    directory.startsWith(base + sep) &&
      !(await lstat(resolve(root, directoryValue))).isSymbolicLink(),
    'RELEASE_DIRECTORY_SCOPE_MISMATCH',
  );
  const manifest = parseManifest(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
  );
  requireRelease(manifest.environment === target, 'RELEASE_ENVIRONMENT_MISMATCH');
  await verifyPreparedArtifacts(directory, manifest);
  return { directory, manifest };
}

try {
  if (command === 'publish') {
    // Deliberately before private .env/auth access. Never fall back to the old
    // exit-code-only publication path without independent hosted readback.
    const { manifest } = await releaseDirectory();
    await writeBlockedPublication(
      resolve(root, '.meshdrop-artifacts/releases', target, manifest.id),
      manifest,
    );
  } else if (command === 'init') {
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
      const release = await prepareRelease(root, target, values);
      const directory = relative(root, release.directory);
      const journal = relative(root, release.journalDirectory);
      console.log(
        JSON.stringify({
          state: 'PREPARED',
          manifestId: release.manifest.id,
          directory,
          journal,
          providerConfirmed: false,
        }),
      );
      if (process.env.GITHUB_OUTPUT)
        await writeFile(
          process.env.GITHUB_OUTPUT,
          `release-directory=${directory}\njournal-directory=${journal}\nmanifest-id=${release.manifest.id}\n`,
          { flag: 'a' },
        );
    } else if (command === 'dry-run') {
      const { directory, manifest } = await releaseDirectory();
      requireRelease(
        manifest.sourceCommit === collectSource(root).sourceCommit,
        'SOURCE_IDENTITY_MISMATCH',
      );
      const output = await mkdtemp(join(tmpdir(), 'meshdrop-release-dry-run-'));
      try {
        await run(
          process.execPath,
          [
            wrangler,
            'deploy',
            '--config',
            join(directory, 'worker.json'),
            '--dry-run',
            '--outdir',
            output,
          ],
          root,
          env,
        );
      } finally {
        await rm(output, { recursive: true, force: true });
      }
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
    } else if (command === 'provision') {
      if (!/^[a-f0-9]{32}$/.test(values.CLOUDFLARE_ACCOUNT_ID ?? ''))
        throw new ReleaseError('EXPLICIT_ACCOUNT_ID_REQUIRED');
      await run(
        process.execPath,
        [
          wrangler,
          'pages',
          'project',
          'create',
          config.project,
          '--force',
          '--production-branch',
          'release',
        ],
        config.directory,
        env,
      );
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
  console.error(
    error instanceof ReleaseError
      ? error.code
      : 'DEPLOYMENT_STEP_FAILED; review configuration and local release records.',
  );
  process.exitCode = 1;
}
