import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deploymentConfig } from '../../scripts/deploy/config';
import {
  artifactHashes,
  bindings,
  compareArchives,
  compareSnapshots,
  inspectCommit,
  migrations,
  validateArchive,
  verifyRollbackTarget,
  verifyArchivePair,
} from '../../scripts/deploy/rollback-compatibility';
import type { Archive, CommitSnapshot } from '../../scripts/deploy/rollback-compatibility';

const cleanupFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args);
      if (cleanupFailure.enabled && String(args[0]).includes('meshdrop-rollback-client-')) {
        cleanupFailure.enabled = false;
        throw new Error('synthetic-private-cleanup-error');
      }
    },
  };
});

const previousCommit = 'b103d568d7d2bed62957f4c129dc238a5b7752f6';
const legacyCommit = 'e108e7a1f59bc37f41ba703240e08f176d47b33c';
let directory: string, current: CommitSnapshot, previous: CommitSnapshot;
let web: Record<string, string>, archive: string;
const config = deploymentConfig(
  'production',
  {
    PAGES_PROJECT: 'meshdrop-offline-production',
    OPS_REVOKE_SECRET: 'a'.repeat(43),
  },
  process.cwd(),
);
async function record() {
  return JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}
async function save(value: unknown, file = 'manifest.json') {
  await writeFile(join(archive, file), JSON.stringify(value));
}
async function createArchive(name: string, snapshot: CommitSnapshot, version: number) {
  const path = join(directory, name);
  await cp(join(directory, 'client'), join(path, 'web'), { recursive: true });
  await mkdir(join(path, 'worker'), { recursive: true });
  await writeFile(join(path, 'worker/index.js'), snapshot.workerScript);
  await writeFile(join(path, 'web/_worker.js'), snapshot.gatewayScript);
  await writeFile(
    join(path, 'web/_routes.json'),
    JSON.stringify({ version: 1, include: ['/*'], exclude: [] }),
  );
  await writeFile(join(path, 'worker.json'), JSON.stringify(config.worker));
  await writeFile(join(path, 'wrangler.json'), JSON.stringify(config.pages));
  await writeFile(
    join(path, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceCommit: snapshot.commit,
      protocolVersion: snapshot.protocol,
      environment: 'production',
      origin: config.origin,
      worker: config.workerName,
      // Synthetic IDs are only format fixtures, never evidence of hosted releases.
      workerVersion: `00000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
      pagesDeployment: `10000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
      files: await artifactHashes(join(path, 'web')),
      workerFiles: await artifactHashes(join(path, 'worker')),
    }),
  );
  return path;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meshdrop-release-test-'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  current = await inspectCommit(head);
  previous = await inspectCommit(previousCommit);
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { build } from ${JSON.stringify(pathToFileURL(resolve('apps/web/node_modules/vite/dist/node/index.js')).href)};
      await build(${JSON.stringify({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'), envFile: false, logLevel: 'silent', build: { outDir: join(directory, 'client'), emptyOutDir: true } })});`,
    ],
    {
      cwd: resolve('apps/web'),
      stdio: 'pipe',
      env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    },
  );
  web = await artifactHashes(join(directory, 'client'));
  await createArchive('current', current, 1);
  await createArchive('previous', previous, 2);
  await createArchive('same-source-previous', current, 2);
}, 30000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  archive = join(directory, 'candidate');
  await rm(archive, { recursive: true, force: true });
  await cp(join(directory, 'previous'), archive, { recursive: true });
});

describe('actual historical source compatibility', () => {
  it('rejects option-like current revisions before looking up source or creating artifacts', async () => {
    const result = await verifyRollbackTarget('--output=invalid', previousCommit);
    expect(result).toMatchObject({
      pass: false,
      productionApproved: false,
      sourceCompatible: false,
      artifactsVerified: false,
    });
    expect(result.issues).toEqual([
      { code: 'INVALID_COMMIT', message: expect.stringContaining('before any revision lookup') },
    ]);
  });
  it('accepts the real prior v2 source without substituting actor code', () => {
    expect(previous.exports).toEqual(
      expect.arrayContaining(['SessionRoom', 'RelayPool', 'OperationsMonitor', 'default']),
    );
  });
  it('retains the exact Task 03 historical source-compatibility proof', async () => {
    const baseline = await inspectCommit('31b8278a66811202e6b9e9bd48f24dae7c30a7e7');
    expect(compareSnapshots(baseline, previous)).toEqual([]);
  });
  it.each(['SessionRoom', 'RelayPool', 'OperationsMonitor'])('rejects missing %s', (name) => {
    expect(
      compareSnapshots(current, {
        ...previous,
        exports: previous.exports.filter((value) => value !== name),
      }),
    ).toContainEqual({ code: 'MISSING_EXPORT', message: `Target must export ${name}.` });
  });
  it('rejects a missing Worker entry', () => {
    expect(
      compareSnapshots(current, {
        ...previous,
        exports: previous.exports.filter((name) => name !== 'default'),
      }),
    ).toContainEqual(expect.objectContaining({ code: 'MISSING_ENTRY' }));
  });
  it('rejects changed class bindings', () => {
    expect(
      compareSnapshots(current, { ...previous, bindings: previous.bindings.slice(1) }),
    ).toContainEqual(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
  });
  it.each(
    [
      [],
      [{ name: 'SESSION_ROOMS', class_name: 'SessionRoom', script_name: 'foreign' }],
      [
        { name: 'SESSION_ROOMS', class_name: 'SessionRoom' },
        { name: 'SESSION_ROOMS', class_name: 'OtherRoom' },
      ],
    ].map((value) => ({ value })),
  )('rejects invalid or external binding configuration $value', ({ value }) => {
    expect(() => bindings(value)).toThrow();
  });
  it.each(
    [
      [],
      [{ tag: 'v1', new_classes: ['SessionRoom'] }],
      [{ tag: 'v1', deleted_classes: ['SessionRoom'] }],
      [{ tag: 'v1', renamed_classes: [{ from: 'SessionRoom', to: 'OtherRoom' }] }],
      [
        { tag: 'v1', new_sqlite_classes: ['SessionRoom'] },
        { tag: 'v1', new_sqlite_classes: ['RelayPool'] },
      ],
      [{ tag: 'v1', new_sqlite_classes: ['SessionRoom', 'SessionRoom'] }],
    ].map((value) => ({ value })),
  )('rejects unsupported migration history $value', ({ value }) => {
    expect(() => migrations(value)).toThrow();
  });
  it('rejects rollback across a migration boundary and changed persistent behavior', () => {
    const issues = compareSnapshots(current, {
      ...previous,
      migrations: previous.migrations.slice(0, 1),
      inputs: 'changed',
    });
    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(['MIGRATION_MISMATCH', 'UNREVIEWED_SOURCE_CHANGE']),
    );
  });
  it('rejects incompatible client/server protocol', () => {
    expect(
      compareSnapshots(current, { ...previous, protocol: previous.protocol + 1 }),
    ).toContainEqual(expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }));
  });
  it('rejects the real P8 baseline with missing v2 classes and migration history', async () => {
    const legacy = await inspectCommit(legacyCommit);
    const issues = compareSnapshots(current, legacy);
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: 'MISSING_EXPORT', message: 'Target must export RelayPool.' },
        { code: 'MISSING_EXPORT', message: 'Target must export OperationsMonitor.' },
        expect.objectContaining({ code: 'MIGRATION_MISMATCH' }),
      ]),
    );
  });
  it.each(['missing', '0'.repeat(40)])('rejects unavailable commit %s', async (commit) => {
    await expect(inspectCommit(commit)).rejects.toThrow(
      commit.length === 40 ? 'unavailable locally' : 'exact 40-character',
    );
  });
  it('fails closed when a source-compatible target has no frozen archives', async () => {
    const result = await verifyRollbackTarget(current.commit, current.commit);
    expect(result).toMatchObject({
      pass: false,
      sourceCompatible: true,
      productionApproved: false,
      artifactsVerified: false,
    });
    expect(result.issues.map((item) => item.code)).toContain('RELEASE_ARCHIVES_REQUIRED');
  });
});

describe('real local release archive integrity', () => {
  it('fails closed on cleanup failure after successful real artifact verification', async () => {
    cleanupFailure.enabled = true;
    try {
      await expect(
        verifyArchivePair(current, previous, {
          current: join(directory, 'current'),
          target: archive,
        }),
      ).rejects.toThrow('synthetic-private-cleanup-error');
      expect(cleanupFailure.enabled).toBe(false);
    } finally {
      cleanupFailure.enabled = false;
    }
  }, 30000);
  it('validates actual built client, Git Worker/gateway and generated configuration', async () => {
    const target = await validateArchive(archive, previous, web);
    const latest = await validateArchive(join(directory, 'current'), current, web);
    expect(() => compareArchives(latest, target)).not.toThrow();
  });
  it('never approves the old synthetic-ID record as verified provenance through the full CLI', () => {
    const cliResult = spawnSync(
      'pnpm',
      [
        'verify:rollback-target',
        current.commit,
        current.commit,
        join(directory, 'current'),
        join(directory, 'same-source-previous'),
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, NODE_ENV: 'development', VITE_ROLLBACK_CANARY: 'synthetic-only' },
      },
    );
    const output = cliResult.stdout;
    expect(cliResult.status).toBe(1);
    const result = JSON.parse(
      output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      pass: false,
      sourceCompatible: true,
      productionApproved: false,
      provenanceVerified: false,
    });
    expect(output).not.toContain('synthetic-only');
  }, 30000);
  it('returns nonzero and useful JSON for incompatible targets', () => {
    const result = spawnSync('pnpm', ['verify:rollback-target', current.commit, legacyCommit], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const report = JSON.parse(
      result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1),
    ) as {
      pass: boolean;
      issues: { code: string }[];
    };
    expect(report.pass).toBe(false);
    expect(report.issues.map((item) => item.code)).toContain('MISSING_EXPORT');
    expect(result.stdout).not.toContain('Authorization');
  });
  it('rejects legacy or incomplete metadata', async () => {
    const value = await record();
    delete value.sourceCommit;
    await save(value);
    await expect(validateArchive(archive, previous, web)).rejects.toThrow(
      'Legacy manifests are insufficient',
    );
  });
  it('rejects corrupt JSON', async () => {
    await writeFile(join(archive, 'manifest.json'), '{');
    await expect(validateArchive(archive, previous, web)).rejects.toThrow();
  });
  it('rejects protocol metadata inconsistent with actual source', async () => {
    await save({ ...(await record()), protocolVersion: 2 });
    await expect(validateArchive(archive, previous, web)).rejects.toThrow('protocol metadata');
  });
  it.each(['worker', 'binding', 'migration', 'rate-limit'])(
    'rejects changed deployment %s configuration',
    async (kind) => {
      const changed = structuredClone(config.worker);
      if (kind === 'worker') changed.name = 'other-worker';
      if (kind === 'binding') changed.durable_objects.bindings.pop();
      if (kind === 'migration') changed.migrations.pop();
      if (kind === 'rate-limit') changed.ratelimits[0]!.namespace_id = '1';
      await save(changed, 'worker.json');
      await expect(validateArchive(archive, previous, web)).rejects.toThrow(
        'Archive configuration',
      );
    },
  );
  it.each(['missing', 'changed', 'extra', 'forged-manifest', 'symlink'])(
    'rejects %s release artifacts',
    async (kind) => {
      if (kind === 'missing') await rm(join(archive, 'web/index.html'));
      if (kind === 'changed') await writeFile(join(archive, 'worker/index.js'), 'corrupt');
      if (kind === 'extra') await writeFile(join(archive, 'web/extra.txt'), 'unexpected');
      if (kind === 'forged-manifest') {
        await writeFile(join(archive, 'worker/index.js'), 'export class SessionRoom {}');
        await save({
          ...(await record()),
          workerFiles: await artifactHashes(join(archive, 'worker')),
        });
      }
      if (kind === 'symlink') {
        await rm(join(archive, 'worker/index.js'));
        await symlink(
          join(directory, 'previous/worker/index.js'),
          join(archive, 'worker/index.js'),
        );
      }
      await expect(validateArchive(archive, previous, web)).rejects.toThrow();
    },
  );
  it('rejects scope changes, drain changes and the current Worker version as target', async () => {
    const target = await validateArchive(archive, previous, web);
    const latest = await validateArchive(join(directory, 'current'), current, web);
    for (const changed of [
      { ...target, environment: 'preview' as const },
      { ...target, origin: 'https://other.test' },
      {
        ...target,
        workerConfig: {
          ...config.worker,
          vars: { ...config.worker.vars, ADMISSION_PAUSED: 'true' },
        },
      },
    ])
      expect(() => compareArchives(latest, changed as Archive)).toThrow('same environment');
    expect(() =>
      compareArchives(latest, { ...target, workerVersion: latest.workerVersion }),
    ).toThrow('distinct recorded');
  });
});
