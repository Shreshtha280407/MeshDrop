import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { artifactHashes, inspectCommit } from './rollback-compatibility';
import { deploymentConfig } from './config';
import type { Environment } from './config';
import {
  bytesHash,
  canonical,
  fingerprint,
  parseManifest,
  REPOSITORY,
  requireRelease,
  sealManifest,
} from './release-record';
import type { Manifest } from './release-record';
import { explicitPause, ReleaseJournal } from './release-lifecycle';

function git(root: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function sourceFingerprint(root: string, commit: string): string {
  requireRelease(/^[a-f0-9]{40}$/.test(commit), 'INVALID_SOURCE_COMMIT');
  return bytesHash(git(root, ['ls-tree', '-r', commit]));
}
export function collectSource(root: string) {
  const origin = git(root, ['remote', 'get-url', 'origin']).trim();
  requireRelease(
    [REPOSITORY, `${REPOSITORY}.git`, 'git@github.com:Shreshtha280407/MeshDrop.git'].includes(
      origin,
    ),
    'REPOSITORY_IDENTITY_MISMATCH',
  );
  requireRelease(
    !git(root, ['status', '--porcelain', '--untracked-files=normal']),
    'SOURCE_WORKTREE_NOT_CLEAN',
  );
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).trim();
  return { sourceCommit, sourceTreeSha256: sourceFingerprint(root, sourceCommit) };
}

/** Shared local builder. Caller-supplied source is a test/input boundary, never provider evidence. */
export async function buildPreparedRelease(options: {
  root: string;
  target: Environment;
  values: Record<string, string | undefined>;
  source: ReturnType<typeof collectSource>;
  preparedAt: string;
  artifactRoot: string;
  journalRoot: string;
}): Promise<{ directory: string; journalDirectory: string; manifest: Manifest }> {
  const { root, target, values, source } = options;
  explicitPause(values.ADMISSION_PAUSED);
  requireRelease(
    /^[a-f0-9]{32}$/.test(values.CLOUDFLARE_ACCOUNT_ID ?? ''),
    'EXPLICIT_ACCOUNT_ID_REQUIRED',
  );
  requireRelease(
    source.sourceTreeSha256 === sourceFingerprint(root, source.sourceCommit),
    'SOURCE_IDENTITY_MISMATCH',
  );
  const config = deploymentConfig(target, values, root);
  await mkdir(options.artifactRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.artifactRoot, 'run-'));
  // An incomplete build has no valid manifest; it cannot be published or accepted.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { build } from ${JSON.stringify(pathToFileURL(resolve(root, 'apps/web/node_modules/vite/dist/node/index.js')).href)};
    await build(${JSON.stringify({ root: resolve(root, 'apps/web'), configFile: resolve(root, 'apps/web/vite.config.ts'), envFile: false, logLevel: 'silent', build: { outDir: join(directory, 'web'), emptyOutDir: true } })});`,
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    },
  );
  for (const [entry, outfile, external] of [
    ['infrastructure/cloudflare/pages-worker.ts', 'web/_worker.js', []],
    ['apps/signaling/src/index.ts', 'worker/index.js', ['cloudflare:workers']],
  ] as const)
    await build({
      absWorkingDir: root,
      entryPoints: [resolve(root, entry)],
      outfile: join(directory, outfile),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: [...external],
      logLevel: 'silent',
    });
  await writeFile(
    join(directory, 'web/_routes.json'),
    JSON.stringify({ version: 1, include: ['/*'], exclude: [] }),
    { flag: 'wx' },
  );
  await writeFile(join(directory, 'worker.json'), canonical(config.worker), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(join(directory, 'wrangler.json'), canonical(config.pages), {
    flag: 'wx',
    mode: 0o600,
  });
  const files = await artifactHashes(join(directory, 'web'));
  const workerFiles = await artifactHashes(join(directory, 'worker'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8', cwd: root }).trim();
  requireRelease(pkg.packageManager === `pnpm@${pnpm}`, 'PACKAGE_MANAGER_IDENTITY_MISMATCH');
  const vite = JSON.parse(
    await readFile(join(root, 'apps/web/node_modules/vite/package.json'), 'utf8'),
  ) as { version: string };
  const snapshot = await inspectCommit(source.sourceCommit);
  const manifest = sealManifest({
    schemaVersion: 2,
    repository: REPOSITORY,
    ...source,
    environment: target,
    accountId: values.CLOUDFLARE_ACCOUNT_ID!,
    origin: config.origin,
    worker: config.workerName,
    project: config.project,
    protocolVersion: snapshot.protocol,
    admissionPaused: explicitPause(values.ADMISSION_PAUSED),
    preparedAt: options.preparedAt,
    files,
    workerFiles,
    gatewaySha256: files['_worker.js']!,
    configurationSha256: fingerprint({ worker: config.worker, pages: config.pages }),
    migrationsSha256: fingerprint({
      bindings: config.worker.durable_objects.bindings,
      migrations: config.worker.migrations,
    }),
    toolchain: {
      node: process.version,
      pnpm,
      esbuild: esbuildVersion,
      vite: vite.version,
      lockSha256: bytesHash(await readFile(join(root, 'pnpm-lock.yaml'))),
    },
  });
  await writeFile(join(directory, 'manifest.json'), canonical(manifest), {
    flag: 'wx',
    mode: 0o600,
  });
  await mkdir(options.journalRoot, { recursive: true, mode: 0o700 });
  const journalDirectory = join(options.journalRoot, manifest.id);
  const journal = await ReleaseJournal.create(journalDirectory, manifest);
  await writeFile(join(directory, 'release.json'), canonical(journal.current()), {
    flag: 'wx',
    mode: 0o600,
  });
  return { directory, journalDirectory, manifest };
}
export async function verifyPreparedArtifacts(
  directory: string,
  manifest: Manifest,
): Promise<void> {
  parseManifest(manifest);
  requireRelease(
    canonical(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))) ===
      canonical(manifest),
    'MANIFEST_CHANGED_AFTER_PREPARATION',
  );
  const worker = JSON.parse(await readFile(join(directory, 'worker.json'), 'utf8')) as {
    durable_objects: { bindings: unknown };
    migrations: unknown;
    vars: { ADMISSION_PAUSED: string };
  };
  const pages: unknown = JSON.parse(await readFile(join(directory, 'wrangler.json'), 'utf8'));
  requireRelease(
    fingerprint({ worker, pages }) === manifest.configurationSha256 &&
      fingerprint({ bindings: worker.durable_objects.bindings, migrations: worker.migrations }) ===
        manifest.migrationsSha256 &&
      explicitPause(worker.vars.ADMISSION_PAUSED) === manifest.admissionPaused,
    'PREPARED_CONFIGURATION_MISMATCH',
  );
  requireRelease(
    canonical(await artifactHashes(join(directory, 'web'))) === canonical(manifest.files) &&
      canonical(await artifactHashes(join(directory, 'worker'))) ===
        canonical(manifest.workerFiles),
    'PREPARED_ARTIFACT_MISMATCH',
  );
}
export async function prepareRelease(
  root: string,
  target: Environment,
  values: Record<string, string | undefined>,
) {
  const source = collectSource(root);
  const result = await buildPreparedRelease({
    root,
    target,
    values,
    source,
    preparedAt: new Date().toISOString(),
    artifactRoot: resolve(root, '.meshdrop-artifacts/deploy', target),
    journalRoot: resolve(root, '.meshdrop-artifacts/releases', target),
  });
  requireRelease(
    collectSource(root).sourceCommit === source.sourceCommit,
    'SOURCE_CHANGED_DURING_PREPARATION',
  );
  return result;
}
