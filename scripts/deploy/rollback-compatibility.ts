import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { deploymentConfig } from './config';
import {
  bytesHash,
  fingerprint,
  parseManifest,
  parseRecord,
  requireAccepted,
} from './release-record';
import type { Manifest, ReleaseRecord } from './release-record';

const INPUTS = [
  'apps',
  'packages',
  'infrastructure',
  '.github/workflows/deploy.yml',
  'scripts/deploy/config.ts',
  'scripts/deploy/cloudflare.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'tsconfig.base.json',
  'tsconfig.json',
];
const sha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type Issue = { code: string; message: string };
export class CompatibilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function requireValue(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new CompatibilityError(code, message);
}
function object(value: unknown): Record<string, unknown> {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_METADATA',
    'Expected a release/configuration object.',
  );
  return value as Record<string, unknown>;
}
function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function source(commit: string, path: string): string {
  return git(['show', `${commit}:${path}`]);
}
function toolchain(text: string): unknown {
  const value = object(JSON.parse(text));
  // Only this read-only command's registration is excluded. All other package
  // metadata and commands, including build/publish/audit behavior, remain pinned.
  delete object(value.scripts)['verify:rollback-target'];
  return value;
}
export function bindings(value: unknown): { name: string; class_name: string }[] {
  requireValue(
    Array.isArray(value) && value.length > 0,
    'INVALID_BINDINGS',
    'Durable Object bindings must be a nonempty list.',
  );
  const names = new Set(),
    classes = new Set();
  return value
    .map((entry: unknown) => {
      const item = object(entry);
      requireValue(
        Object.keys(item).sort().join(',') === 'class_name,name' &&
          typeof item.name === 'string' &&
          /^[A-Z][A-Z0-9_]*$/.test(item.name) &&
          typeof item.class_name === 'string' &&
          /^[A-Za-z][A-Za-z0-9]*$/.test(item.class_name) &&
          !names.has(item.name) &&
          !classes.has(item.class_name),
        'INVALID_BINDINGS',
        'Use unique local binding names/classes; external namespaces require separate review.',
      );
      names.add(item.name);
      classes.add(item.class_name);
      return { name: item.name, class_name: item.class_name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function migrations(value: unknown): { tag: string; new_sqlite_classes: string[] }[] {
  requireValue(
    Array.isArray(value) && value.length > 0,
    'UNSUPPORTED_MIGRATIONS',
    'A reviewed SQLite migration history is required.',
  );
  const tags = new Set(),
    classes = new Set();
  return value.map((entry: unknown) => {
    const item = object(entry);
    requireValue(
      Object.keys(item).sort().join(',') === 'new_sqlite_classes,tag' &&
        typeof item.tag === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(item.tag) &&
        !tags.has(item.tag) &&
        Array.isArray(item.new_sqlite_classes) &&
        item.new_sqlite_classes.length > 0 &&
        item.new_sqlite_classes.every(
          (name: unknown) =>
            typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(name) && !classes.has(name),
        ) &&
        new Set(item.new_sqlite_classes).size === item.new_sqlite_classes.length,
      'UNSUPPORTED_MIGRATIONS',
      'Only unique additive SQLite histories are supported; changes, deletes, renames, transfers or storage changes require forward recovery review.',
    );
    tags.add(item.tag);
    const names = item.new_sqlite_classes as string[];
    names.forEach((name) => classes.add(name));
    return { tag: item.tag, new_sqlite_classes: [...names].sort() };
  });
}
export type CommitSnapshot = {
  commit: string;
  exports: string[];
  bindings: ReturnType<typeof bindings>;
  migrations: ReturnType<typeof migrations>;
  protocol: number;
  inputs: string;
  workerScript: string;
  gatewayScript: string;
};

/** Compile Git source without evaluating historical deployment code or reading .env files. */
export async function inspectCommit(commit: string): Promise<CommitSnapshot> {
  requireValue(sha.test(commit), 'INVALID_COMMIT', 'Supply an exact 40-character commit SHA.');
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    throw new CompatibilityError(
      'MISSING_COMMIT',
      'Commit unavailable locally; do not substitute another target.',
    );
  }
  const root = process.cwd();
  const cache = new Map<string, string>();
  const load = (path: string) => {
    if (!cache.has(path)) cache.set(path, source(commit, path));
    return cache.get(path)!;
  };
  const parsed = ts.parseConfigFileTextToJson(
    'wrangler.jsonc',
    load('apps/signaling/wrangler.jsonc'),
  );
  requireValue(!parsed.error, 'INVALID_CONFIG', 'Historical Wrangler configuration is invalid.');
  const config = object(parsed.config);
  requireValue(
    !config.exports,
    'UNSUPPORTED_MIGRATIONS',
    'Declarative class lifecycle configuration requires a separate compatibility review.',
  );
  const configured = bindings(object(config.durable_objects).bindings);
  const history = migrations(config.migrations);
  requireValue(
    isDeepStrictEqual(
      history.flatMap((item) => item.new_sqlite_classes).sort(),
      configured.map((item) => item.class_name).sort(),
    ),
    'INVALID_BINDINGS',
    'Every configured class must have exactly one SQLite creation migration.',
  );
  const constants = ts.createSourceFile(
    'constants.ts',
    load('packages/protocol/src/constants.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  let protocol: number | undefined;
  for (const statement of constants.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(constants) !== 'PROTOCOL_VERSION' || !declaration.initializer)
        continue;
      const value = ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (ts.isNumericLiteral(value)) protocol = Number(value.text);
    }
  }
  requireValue(
    Number.isSafeInteger(protocol) && protocol! > 0,
    'INVALID_PROTOCOL',
    'Protocol version must be an explicit positive integer.',
  );
  async function bundle(path: string, external: string[] = []) {
    const result = await build({
      entryPoints: [resolve(path)],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external,
      logLevel: 'silent',
      plugins: [
        {
          name: 'read-only-git-source',
          setup(builder) {
            builder.onLoad({ filter: /\.(ts|tsx|js|json)$/ }, ({ path: file }) => {
              const name = relative(root, file).replaceAll('\\', '/');
              if (name.startsWith('node_modules/') || name.startsWith('../')) return undefined;
              return {
                contents: load(name),
                loader: name.endsWith('.tsx') ? 'tsx' : name.endsWith('.json') ? 'json' : 'ts',
                resolveDir: resolve(file, '..'),
              };
            });
          },
        },
      ],
    });
    return {
      script: result.outputFiles[0]!.text,
      exports: Object.values(result.metafile.outputs)
        .flatMap((item) => item.exports)
        .sort(),
    };
  }
  const worker = await bundle('apps/signaling/src/index.ts', ['cloudflare:workers']);
  // P8 predates the Pages gateway; missing source is a closed gate, not a replacement.
  let gatewayScript = '';
  try {
    load('infrastructure/cloudflare/pages-worker.ts');
  } catch {
    /* Required export/migration diagnostics still explain this known old target. */
  }
  if (cache.has('infrastructure/cloudflare/pages-worker.ts'))
    gatewayScript = (await bundle('infrastructure/cloudflare/pages-worker.ts')).script;
  return {
    commit,
    exports: worker.exports,
    bindings: configured,
    migrations: history,
    protocol: protocol!,
    inputs: createHash('sha256')
      .update(git(['ls-tree', '-r', commit, '--', ...INPUTS]))
      .update(JSON.stringify(toolchain(load('package.json'))))
      .digest('hex'),
    workerScript: worker.script,
    gatewayScript,
  };
}

export function compareSnapshots(current: CommitSnapshot, target: CommitSnapshot): Issue[] {
  const issues: Issue[] = [];
  for (const item of current.bindings)
    if (!target.exports.includes(item.class_name))
      issues.push({ code: 'MISSING_EXPORT', message: `Target must export ${item.class_name}.` });
  if (!target.exports.includes('default'))
    issues.push({ code: 'MISSING_ENTRY', message: 'Target must export the Worker entry point.' });
  if (!target.gatewayScript)
    issues.push({ code: 'MISSING_GATEWAY', message: 'Target must include the Pages gateway.' });
  if (!isDeepStrictEqual(current.bindings, target.bindings))
    issues.push({
      code: 'BINDING_MISMATCH',
      message: 'Target must retain every current binding and local class mapping.',
    });
  if (!isDeepStrictEqual(current.migrations, target.migrations))
    issues.push({
      code: 'MIGRATION_MISMATCH',
      message: 'Rollback cannot cross a class lifecycle/migration history change.',
    });
  if (current.protocol !== target.protocol)
    issues.push({ code: 'PROTOCOL_MISMATCH', message: 'Client/server protocol versions differ.' });
  if (current.inputs !== target.inputs)
    issues.push({
      code: 'UNREVIEWED_SOURCE_CHANGE',
      message:
        'Runtime, persistence, security, client, configuration or locked build inputs differ; separate compatibility proof is required.',
    });
  return issues;
}

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export async function artifactHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  async function visit(path: string, prefix = '') {
    requireValue(
      (await lstat(path)).isDirectory(),
      'INVALID_ARTIFACT',
      'Artifact root must be a real directory.',
    );
    for (const entry of await readdir(path, { withFileTypes: true })) {
      requireValue(
        !entry.isSymbolicLink() && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name),
        'INVALID_ARTIFACT',
        'Artifacts must be regular files/directories without hidden files or links.',
      );
      const name = prefix + entry.name,
        file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file, name + '/');
      else {
        requireValue(entry.isFile(), 'INVALID_ARTIFACT', 'Unsupported artifact file type.');
        hashes[name] = digest(await readFile(file));
      }
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

export type Archive = {
  environment: 'preview' | 'production';
  origin: string;
  worker: string;
  workerVersion: string | null;
  pagesDeployment: string | null;
  manifest?: Manifest;
  record?: ReleaseRecord;
  workerConfig: unknown;
  pagesConfig: unknown;
};
async function json(path: string): Promise<unknown> {
  requireValue(
    (await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(),
    'INVALID_METADATA',
    'Release metadata/configuration must be regular local files.',
  );
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function validateArchive(
  directory: string,
  snapshot: CommitSnapshot,
  web: Record<string, string>,
): Promise<Archive> {
  const record = object(await json(join(directory, 'manifest.json')));
  const versioned = record.schemaVersion === 2 ? parseManifest(record) : undefined;
  if (!versioned) {
    requireValue(
      record.schemaVersion === 1 &&
        record.sourceCommit === snapshot.commit &&
        ['preview', 'production'].includes(String(record.environment)) &&
        typeof record.origin === 'string' &&
        typeof record.worker === 'string' &&
        typeof record.workerVersion === 'string' &&
        uuid.test(record.workerVersion) &&
        typeof record.pagesDeployment === 'string' &&
        uuid.test(record.pagesDeployment),
      'INCOMPLETE_RELEASE_RECORD',
      'Require schemaVersion 1, exact sourceCommit, scope and recorded Worker/Pages IDs. Legacy manifests are insufficient.',
    );
  }
  requireValue(
    record.sourceCommit === snapshot.commit,
    'SOURCE_IDENTITY_MISMATCH',
    'Archive source does not match the exact target commit.',
  );
  requireValue(
    typeof record.origin === 'string' && typeof record.worker === 'string',
    'INVALID_RELEASE_SCOPE',
    'Release origin and Worker identity are required.',
  );
  requireValue(
    record.protocolVersion === snapshot.protocol,
    'PROTOCOL_MISMATCH',
    'Release client/server protocol metadata does not match source.',
  );
  const worker = object(await json(join(directory, 'worker.json')));
  const pages = object(await json(join(directory, 'wrangler.json')));
  const vars = object(worker.vars);
  const environment = record.environment as Archive['environment'];
  const provider = vars.TURN_PROVIDER;
  requireValue(
    ['direct', 'coturn', 'cloudflare', 'metered'].includes(String(provider)),
    'INVALID_CONFIG',
    'A supported explicit relay provider is required.',
  );
  const expected = deploymentConfig(
    environment,
    {
      PAGES_PROJECT: typeof pages.name === 'string' ? pages.name : '',
      PUBLIC_ORIGIN: record.origin,
      OPS_REVOKE_SECRET: 'a'.repeat(43),
      TURN_PROVIDER: String(provider),
      TURN_URLS: typeof vars.TURN_URLS === 'string' ? vars.TURN_URLS : '',
      ADMISSION_PAUSED: typeof vars.ADMISSION_PAUSED === 'string' ? vars.ADMISSION_PAUSED : '',
      ...(provider === 'coturn' ? { TURN_SHARED_SECRET: 'c'.repeat(32) } : {}),
      ...(provider === 'cloudflare'
        ? { CLOUDFLARE_TURN_KEY_ID: 'a'.repeat(32), CLOUDFLARE_TURN_API_TOKEN: 'a'.repeat(64) }
        : {}),
      ...(provider === 'metered'
        ? {
            METERED_DOMAIN: String(vars.METERED_DOMAIN),
            METERED_FREE_ONLY: 'true',
            METERED_SECRET_KEY: 'm'.repeat(32),
          }
        : {}),
      ...(vars.CLOUDFLARE_ACCOUNT_ID
        ? {
            CLOUDFLARE_ACCOUNT_ID: String(vars.CLOUDFLARE_ACCOUNT_ID),
            CLOUDFLARE_ANALYTICS_API_TOKEN: 'a'.repeat(40),
          }
        : {}),
    },
    process.cwd(),
  );
  requireValue(
    record.worker === expected.workerName &&
      isDeepStrictEqual(worker, expected.worker) &&
      isDeepStrictEqual(pages, expected.pages),
    'CONFIG_MISMATCH',
    'Archive configuration must match the actual generator, origin, bindings, rate limits, security controls, relay mode and schedule.',
  );
  const actualWeb = await artifactHashes(join(directory, 'web'));
  const actualWorker = await artifactHashes(join(directory, 'worker'));
  const expectedWeb = {
    ...web,
    '_worker.js': digest(snapshot.gatewayScript),
    '_routes.json': digest(JSON.stringify({ version: 1, include: ['/*'], exclude: [] })),
  };
  requireValue(
    isDeepStrictEqual(record.files, actualWeb) &&
      isDeepStrictEqual(record.workerFiles, actualWorker) &&
      isDeepStrictEqual(actualWeb, expectedWeb) &&
      isDeepStrictEqual(actualWorker, { 'index.js': digest(snapshot.workerScript) }),
    'ARTIFACT_MISMATCH',
    'Missing, extra or changed artifacts; archived Worker, gateway and client must match the frozen sources and local rebuild.',
  );
  let release: ReleaseRecord | undefined;
  if (versioned) {
    const rootPackage = JSON.parse(source(snapshot.commit, 'package.json')) as {
      packageManager: string;
      devDependencies: { esbuild: string };
    };
    const webPackage = JSON.parse(source(snapshot.commit, 'apps/web/package.json')) as {
      devDependencies: { vite: string };
    };
    requireValue(
      versioned.sourceTreeSha256 === bytesHash(git(['ls-tree', '-r', snapshot.commit])) &&
        versioned.configurationSha256 === fingerprint({ worker, pages }) &&
        versioned.migrationsSha256 ===
          fingerprint({
            bindings: expected.worker.durable_objects.bindings,
            migrations: expected.worker.migrations,
          }) &&
        versioned.toolchain.lockSha256 === bytesHash(source(snapshot.commit, 'pnpm-lock.yaml')) &&
        `pnpm@${versioned.toolchain.pnpm}` === rootPackage.packageManager &&
        versioned.toolchain.esbuild === rootPackage.devDependencies.esbuild &&
        versioned.toolchain.vite === webPackage.devDependencies.vite,
      'PROVENANCE_CONTENT_MISMATCH',
      'Source/configuration/migration/toolchain fingerprints differ from the release record.',
    );
    try {
      release = parseRecord(await json(join(directory, 'release.json')), versioned);
    } catch {
      throw new CompatibilityError(
        'RELEASE_STATE_REQUIRED',
        'A complete versioned lifecycle record is required.',
      );
    }
  }
  return {
    environment,
    origin: record.origin,
    worker: record.worker,
    workerVersion: versioned
      ? (release?.provider.workerVersion ?? null)
      : (record.workerVersion as string),
    pagesDeployment: versioned
      ? (release?.provider.pagesDeployment ?? null)
      : (record.pagesDeployment as string),
    ...(versioned ? { manifest: versioned } : {}),
    ...(release ? { record: release } : {}),
    workerConfig: worker,
    pagesConfig: pages,
  };
}
export function compareArchives(current: Archive, target: Archive): void {
  requireValue(
    current.workerVersion &&
      target.workerVersion &&
      current.pagesDeployment &&
      target.pagesDeployment,
    'RELEASE_IDENTITIES_UNVERIFIED',
    'Both provider identity fields are required; this content check does not authenticate them.',
  );
  requireValue(
    current.environment === target.environment &&
      current.origin === target.origin &&
      current.worker === target.worker &&
      isDeepStrictEqual(current.workerConfig, target.workerConfig) &&
      isDeepStrictEqual(current.pagesConfig, target.pagesConfig),
    'RELEASE_SCOPE_MISMATCH',
    'Keep the same environment, origin, namespaces, provider configuration and admission setting.',
  );
  requireValue(
    current.workerVersion !== target.workerVersion,
    'SAME_WORKER_VERSION',
    'Target must be a distinct recorded Worker version.',
  );
}

/** Content integrity only. Eligibility additionally requires authenticated accepted provenance. */
export async function verifyArchivePair(
  latest: CommitSnapshot,
  previous: CommitSnapshot,
  archives: { current: string; target: string },
): Promise<{ current: Archive; target: Archive }> {
  const temporary = await mkdtemp(join(tmpdir(), 'meshdrop-rollback-client-'));
  try {
    // Fixed local build only; never run deployment scripts or historical commands.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { build } from ${JSON.stringify(pathToFileURL(resolve('apps/web/node_modules/vite/dist/node/index.js')).href)};
          await build(${JSON.stringify({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), envFile: false, logLevel: 'silent', build: { outDir: join(temporary, 'web'), emptyOutDir: true } })});`,
      ],
      {
        cwd: resolve('apps/web'),
        stdio: ['ignore', 'pipe', 'pipe'],
        // No .env loading, VITE_* injection, provider credentials or NODE_OPTIONS.
        env: { PATH: process.env.PATH, NODE_ENV: 'production' },
      },
    );
    const web = await artifactHashes(join(temporary, 'web'));
    const pair = {
      current: await validateArchive(resolve(archives.current), latest, web),
      target: await validateArchive(resolve(archives.target), previous, web),
    };
    compareArchives(pair.current, pair.target);
    return pair;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function verifyPairProvenance(
  pair: { current: Archive; target: Archive },
  authenticate?: (manifest: Manifest, record: ReleaseRecord) => Promise<boolean>,
): Promise<void> {
  for (const archive of [pair.current, pair.target]) {
    requireValue(
      archive.manifest && archive.record,
      'RELEASE_PROVENANCE_REQUIRED',
      'Legacy hashes and UUID-shaped fields do not establish accepted release provenance.',
    );
    try {
      requireAccepted(archive.manifest, archive.record);
    } catch {
      throw new CompatibilityError(
        'UNVERIFIED_RELEASE_PROVENANCE',
        'Prepared, rejected, incomplete and offline-fixture releases are not eligible.',
      );
    }
    requireValue(
      authenticate && (await authenticate(archive.manifest, archive.record)),
      'PROVIDER_AUTHENTICATION_REQUIRED',
      'Independent authorized provider/journal authentication is required; unsigned JSON is not proof.',
    );
  }
}

export async function verifyRollbackTarget(
  current: string,
  target: string,
  archives?: { current: string; target: string },
  authenticate?: (manifest: Manifest, record: ReleaseRecord) => Promise<boolean>,
) {
  const report = {
    scope: 'offline source/artifact compatibility; no deployment authorization',
    pass: false,
    productionApproved: false,
    sourceCompatible: false,
    artifactsVerified: false,
    provenanceVerified: false,
    workingTreeVerified: false,
    current,
    target,
    issues: [] as Issue[],
  };
  try {
    requireValue(
      sha.test(current) && sha.test(target),
      'INVALID_COMMIT',
      'Supply exact 40-character current and target commit SHAs before any revision lookup.',
    );
    requireValue(
      git(['rev-parse', 'HEAD']).trim() === current,
      'CURRENT_HEAD_MISMATCH',
      'Current commit must equal this checkout HEAD.',
    );
    const latest = await inspectCommit(current),
      previous = await inspectCommit(target);
    const generated = deploymentConfig(
      'production',
      { PAGES_PROJECT: 'meshdrop-local-production', OPS_REVOKE_SECRET: 'a'.repeat(43) },
      process.cwd(),
    );
    requireValue(
      isDeepStrictEqual(latest.bindings, bindings(generated.worker.durable_objects.bindings)) &&
        isDeepStrictEqual(latest.migrations, migrations(generated.worker.migrations)),
      'CONFIG_MISMATCH',
      'Local Wrangler and production generator disagree.',
    );
    requireValue(
      compareSnapshots(latest, latest).length === 0,
      'INVALID_CURRENT_EXPORTS',
      'Current Worker lacks configured exports.',
    );
    report.issues.push(...compareSnapshots(latest, previous));
    try {
      git(['merge-base', '--is-ancestor', target, current]);
    } catch {
      report.issues.push({
        code: 'UNREVIEWED_LINEAGE',
        message: 'Target must be in the current release history.',
      });
    }
    if (report.issues.length) return report;
    report.sourceCompatible = true;
    requireValue(
      archives,
      'RELEASE_ARCHIVES_REQUIRED',
      'Supply both frozen current and target release directories with complete reviewed metadata.',
    );
    requireValue(
      !git(['status', '--porcelain', '--untracked-files=normal', '--', ...INPUTS]) &&
        isDeepStrictEqual(
          toolchain(await readFile('package.json', 'utf8')),
          toolchain(source(current, 'package.json')),
        ),
      'DIRTY_RELEASE_INPUTS',
      'Preserve and separately review local release-input changes before validation.',
    );
    report.workingTreeVerified = true;
    const pair = await verifyArchivePair(latest, previous, archives);
    report.artifactsVerified = true;
    await verifyPairProvenance(pair, authenticate);
    report.provenanceVerified = true;
    report.pass = true;
  } catch (error) {
    report.pass = false;
    report.issues.push(
      error instanceof CompatibilityError
        ? { code: error.code, message: error.message }
        : {
            code: 'LOCAL_INPUT_UNAVAILABLE',
            message:
              'Source, release files, local build or cleanup unavailable/invalid; no remote fallback was attempted.',
          },
    );
  }
  return report;
}
