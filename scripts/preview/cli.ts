import { execFile, execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  buildPreparedRelease,
  collectSource,
  verifyPreparedArtifacts,
} from '../deploy/release-preparation';
import {
  canonical,
  parseManifest,
  requireRelease,
  ReleaseError,
  sameContent,
} from '../deploy/release-record';
import {
  configured,
  runtime,
  manifestGate,
  buildValues,
  CAPABILITIES,
  ENVIRONMENT,
} from './contract';
import { PreviewReadback } from './provider';
import { runHostedCanary, validateCanary } from './canary';
import { previewBrowser } from './browser';
import { copyPackage, packageFiles, verifyPackage } from './package';

const ROOT = process.cwd(),
  BASE = resolve(ROOT, '.meshdrop-artifacts/preview-canary'),
  PUBLIC = join(BASE, 'public');
const env = process.env;
const [command, directoryArg] = process.argv.slice(2);
const wrangler = resolve(ROOT, 'apps/signaling/node_modules/wrangler/bin/wrangler.js');
async function save(name: string, value: unknown) {
  await mkdir(PUBLIC, { recursive: true, mode: 0o700 });
  await writeFile(join(PUBLIC, name), canonical(value), { mode: 0o600 });
}
async function output(values: Record<string, string>) {
  if (!env.GITHUB_OUTPUT) return;
  for (const [k, v] of Object.entries(values)) {
    requireRelease(/^[a-z-]+$/.test(k) && /^[A-Za-z0-9_./-]+$/.test(v), 'PREVIEW_OUTPUT_INVALID');
    await writeFile(env.GITHUB_OUTPUT, `${k}=${v}\n`, { flag: 'a' });
  }
}
async function inspect() {
  const identity = runtime(env),
    pins = configured(env);
  requireRelease(env.GITHUB_TOKEN, 'PREVIEW_GITHUB_METADATA_CREDENTIAL_REQUIRED');
  async function get(path: string) {
    const r = await fetch(`https://api.github.com/repos/Shreshtha280407/MeshDrop/${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });
    requireRelease(r.status === 200 && !r.redirected, 'PREVIEW_GITHUB_CONFIGURATION_UNVERIFIED');
    requireRelease(r.body, 'PREVIEW_GITHUB_CONFIGURATION_UNVERIFIED');
    const reader = r.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const v = await reader.read();
        if (v.done) break;
        size += v.value.byteLength;
        requireRelease(size <= 1024 * 1024, 'PREVIEW_METADATA_LIMIT');
        chunks.push(v.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel();
    }
  }
  const environment = await get(`environments/${ENVIRONMENT}`);
  requireRelease(
    String(environment.id) === pins.target.githubEnvironmentId &&
      environment.name === ENVIRONMENT &&
      environment.deployment_branch_policy?.custom_branch_policies === true,
    'PREVIEW_ENVIRONMENT_ID_MISMATCH',
  );
  const rules = await get(`environments/${ENVIRONMENT}/deployment-branch-policies?per_page=100`);
  requireRelease(
    rules.total_count === 1 &&
      rules.branch_policies?.length === 1 &&
      rules.branch_policies[0].name === 'main' &&
      rules.branch_policies[0].type === 'branch',
    'PREVIEW_MAIN_REF_POLICY_REQUIRED',
  );
  const runs = await get(`actions/runs?head_sha=${identity.sourceCommit}&event=push&per_page=100`);
  requireRelease(
    runs.workflow_runs?.some(
      (r: Record<string, unknown>) =>
        r.path === '.github/workflows/ci.yml' &&
        r.head_sha === identity.sourceCommit &&
        r.status === 'completed' &&
        r.conclusion === 'success',
    ),
    'PREVIEW_SOURCE_CI_NOT_SUCCESSFUL',
  );
  await output({ 'environment-name': ENVIRONMENT });
  console.log(
    canonical({
      status: 'PREVIEW_CONFIGURATION_PRESENT — NOT PUBLICATION AUTHORIZATION',
      ...identity,
      ...CAPABILITIES,
    }).trim(),
  );
}
async function prepared() {
  const identity = runtime(env),
    pins = configured(env);
  requireRelease(directoryArg, 'PREVIEW_EXPLICIT_PACKAGE_REQUIRED');
  const directory = await realpath(resolve(ROOT, directoryArg));
  requireRelease(
    directory.startsWith(BASE + sep) &&
      (await lstat(resolve(ROOT, directoryArg))).isDirectory() &&
      !(await lstat(resolve(ROOT, directoryArg))).isSymbolicLink(),
    'PREVIEW_PACKAGE_PATH_REJECTED',
  );
  for (const name of ['manifest.json', 'worker.json', 'wrangler.json']) {
    const s = await lstat(join(directory, name));
    requireRelease(s.isFile() && !s.isSymbolicLink(), 'PREVIEW_PACKAGE_METADATA_REJECTED');
  }
  const m = parseManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
  const worker = JSON.parse(await readFile(join(directory, 'worker.json'), 'utf8')),
    pages = JSON.parse(await readFile(join(directory, 'wrangler.json'), 'utf8'));
  manifestGate(m, pins, identity.sourceCommit, env.PREVIEW_CANARY_MANIFEST_ID ?? '', worker, pages);
  requireRelease(
    collectSource(ROOT).sourceCommit === identity.sourceCommit,
    'PREVIEW_SOURCE_CHANGED',
  );
  await verifyPackage(directory, m);
  return { identity, pins, directory, manifest: m };
}
async function cli(args: string[], cwd: string, account?: string, token?: string) {
  // stdout/stderr may contain provider metadata: discard both, never upload them.
  try {
    await promisify(execFile)(process.execPath, [wrangler, ...args], {
      cwd,
      timeout: 180000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: env.PATH,
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
        ...(account && token
          ? { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token }
          : {}),
      },
    });
  } catch {
    throw new ReleaseError('PREVIEW_WRANGLER_FAILED — RECONCILE_BEFORE_RETRY');
  }
}
async function dryRun() {
  const p = await prepared(),
    temporary = await mkdtemp(join(tmpdir(), 'meshdrop-preview-dry-'));
  try {
    await copyPackage(p.directory, join(temporary, 'package'), p.manifest);
    await cli(
      [
        'deploy',
        '--config',
        'worker.json',
        '--dry-run',
        '--outdir',
        join(temporary, 'output'),
        '--no-bundle',
      ],
      join(temporary, 'package'),
    );
    await verifyPreparedArtifacts(p.directory, p.manifest);
    const files = packageFiles(p.manifest);
    await mkdir(PUBLIC, { recursive: true, mode: 0o700 });
    execFileSync('tar', ['-cf', join(PUBLIC, 'package.tar'), '--', ...files], {
      cwd: p.directory,
      stdio: 'ignore',
    });
    await save('manifest.json', p.manifest);
    await save('preparation.json', {
      state: 'PREPARED',
      manifestId: p.manifest.id,
      sourceCommit: p.identity.sourceCommit,
      providerConfirmed: false,
      ...CAPABILITIES,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function publish() {
  const p = await prepared(),
    token = env.PREVIEW_CANARY_API_TOKEN;
  requireRelease(token, 'PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED');
  const provider = new PreviewReadback(p.pins, token);
  // Before a byte is written: existing v2 namespaces, paused admission, same-origin
  // private Worker binding and separate account must be independently read back.
  const before = await provider.observe();
  requireRelease(before.observation.providerConfirmed, 'PREVIEW_AUTHENTICATED_PREFLIGHT_REQUIRED');
  await mkdir(PUBLIC, { recursive: true, mode: 0o700 });
  await writeFile(
    join(p.directory, 'publication-intent.json'),
    canonical({
      manifestId: p.manifest.id,
      ...p.identity,
      previous: before.expected,
      ...CAPABILITIES,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const privateDirectory = await mkdtemp(join(tmpdir(), 'meshdrop-preview-publish-'));
  let state = 'WORKER_INTENT',
    failure: string | null = null;
  let observed = before;
  const record = async () =>
    save('publication.json', {
      schemaVersion: 1,
      scope: 'isolated-preview-only',
      state,
      failure,
      manifestId: p.manifest.id,
      ...p.identity,
      origin: p.pins.target.origin,
      worker: p.pins.target.worker,
      project: p.pins.target.project,
      provider: observed.expected,
      providerTimestamps: {
        workerCreatedAt: observed.workerCreatedAt,
        pagesCreatedAt: observed.pagesCreatedAt,
        observedAt: observed.observation.observedAt,
      },
      accepted: false,
      sourceCorrelation:
        'frozen-local-upload-intent-and-provider-annotations; not independent artifact attestation',
      ...CAPABILITIES,
    });
  try {
    const copy = join(privateDirectory, 'package');
    await copyPackage(p.directory, copy, p.manifest);
    await verifyPreparedArtifacts(copy, p.manifest);
    await record();
    await cli(
      [
        'deploy',
        '--config',
        'worker.json',
        '--name',
        p.pins.target.worker,
        '--no-bundle',
        '--message',
        p.manifest.id,
      ],
      copy,
      p.pins.target.accountId,
      token,
    );
    observed = await provider.observe(p.manifest, false);
    state = 'PAGES_INTENT';
    await record();
    await cli(
      [
        'pages',
        'deploy',
        'web',
        '--project-name',
        p.pins.target.project,
        '--branch',
        'release',
        '--commit-hash',
        p.manifest.sourceCommit,
        '--commit-dirty=false',
      ],
      copy,
      p.pins.target.accountId,
      token,
    );
    observed = await provider.observe(p.manifest);
    await verifyPreparedArtifacts(p.directory, p.manifest);
    state = 'PUBLISHED_NOT_ACCEPTED';
    await record();
    await save('browser.json', await previewBrowser(p.pins));
    const report = await runHostedCanary(p.pins, p.manifest.protocolVersion);
    await save('canary.json', { manifestId: p.manifest.id, ...p.identity, ...report });
    validateCanary(report);
    const final = await provider.observe(p.manifest);
    requireRelease(sameContent(final.expected, observed.expected), 'PREVIEW_CHANGED_DURING_CANARY');
    observed = final;
    await record();
    await save('rollback.json', {
      status: 'ROLLBACK_DRILL_NOT_RUN — NO VERIFIED PREVIEW BASELINE',
      automaticRollback: false,
      ...CAPABILITIES,
    });
    await save('coverage.json', {
      pairedSession: 'NOT_RUN — NEEDS AUTHORIZED PREEXISTING PREVIEW SESSION',
      signalingAndTransfer: 'NOT_RUN',
      natTurn: 'NOT_RUN',
      fullFunctionalCoverage: false,
      ...CAPABILITIES,
    });
  } catch (e) {
    failure = e instanceof ReleaseError ? e.code : 'PREVIEW_STEP_FAILED_RECONCILE';
    state = 'INCOMPLETE';
    await record();
    throw new ReleaseError(failure);
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
try {
  requireRelease(
    process.argv.slice(2).length === (['dry-run', 'publish'].includes(command ?? '') ? 2 : 1),
    'PREVIEW_COMMAND_NOT_ALLOWED',
  );
  if (command === 'inspect') await inspect();
  else if (command === 'prepare') {
    const identity = runtime(env),
      pins = configured(env),
      source = collectSource(ROOT);
    requireRelease(source.sourceCommit === identity.sourceCommit, 'PREVIEW_SOURCE_CHANGED');
    const result = await buildPreparedRelease({
      root: ROOT,
      target: 'preview',
      values: buildValues(pins.target),
      source,
      preparedAt: new Date().toISOString(),
      artifactRoot: BASE,
      journalRoot: join(BASE, 'journals'),
    });
    await output({
      directory: relative(ROOT, result.directory),
      'manifest-id': result.manifest.id,
    });
    console.log(
      canonical({
        state: 'PREPARED',
        manifestId: result.manifest.id,
        providerConfirmed: false,
        ...CAPABILITIES,
      }).trim(),
    );
  } else if (command === 'dry-run') await dryRun();
  else if (command === 'publish') await publish();
  else throw new ReleaseError('PREVIEW_COMMAND_NOT_ALLOWED');
} catch (e) {
  console.log(
    canonical({
      status: e instanceof ReleaseError ? e.code : 'PREVIEW_STEP_FAILED',
      ...CAPABILITIES,
    }).trim(),
  );
  process.exitCode = 1;
}
