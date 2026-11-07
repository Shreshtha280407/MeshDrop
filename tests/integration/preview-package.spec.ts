import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import {
  buildPreparedRelease,
  sourceFingerprint,
  verifyPreparedArtifacts,
} from '../../scripts/deploy/release-preparation';
import { buildValues, manifestGate } from '../../scripts/preview/contract';
import { pausedProbe } from '../../scripts/preview/canary';
import { previewFixture } from '../fixtures/preview-canary';
import { copyPackage, packageFiles } from '../../scripts/preview/package';

it('packages the real current Worker/gateway/frontend and verifies paused behavior without hosted access', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'meshdrop-preview-package-'));
  let worker: Miniflare | undefined;
  try {
    const f = previewFixture(),
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // Explicit fixture boundary, not a clean-source hosted release or attestation.
    const p = await buildPreparedRelease({
      root: process.cwd(),
      target: 'preview',
      values: buildValues(f.pins.target),
      source: { sourceCommit: commit, sourceTreeSha256: sourceFingerprint(process.cwd(), commit) },
      preparedAt: new Date().toISOString(),
      artifactRoot: join(temp, 'packages'),
      journalRoot: join(temp, 'journals'),
    });
    const config = JSON.parse(await readFile(join(p.directory, 'worker.json'), 'utf8')),
      pages = JSON.parse(await readFile(join(p.directory, 'wrangler.json'), 'utf8'));
    manifestGate(p.manifest, f.pins, commit, p.manifest.id, config, pages);
    await verifyPreparedArtifacts(p.directory, p.manifest);
    await writeFile(join(p.directory, '.env'), 'PRIVATE_FIXTURE=must-not-be-copied');
    const frozen = join(temp, 'private-copy');
    await copyPackage(p.directory, frozen, p.manifest);
    expect(await readdir(frozen)).not.toContain('.env');
    expect(packageFiles(p.manifest).some((n) => n.includes('.env'))).toBe(false);
    execFileSync(
      process.execPath,
      [
        resolve('apps/signaling/node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--config',
        join(frozen, 'worker.json'),
        '--dry-run',
        '--outdir',
        join(temp, 'dry-run'),
        '--no-bundle',
        '--message',
        p.manifest.id,
      ],
      {
        cwd: temp,
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          WRANGLER_SEND_METRICS: 'false',
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
          XDG_CONFIG_HOME: join(temp, 'xdg'),
        },
      },
    );
    expect(config.vars.ADMISSION_PAUSED).toBe('true');
    expect(config.vars.TURN_PROVIDER).toBe('direct');
    worker = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: 'gateway-fixture',
            modules: true,
            script: await readFile(join(p.directory, 'web/_worker.js'), 'utf8'),
            compatibilityDate: '2026-07-01',
            bindings: { PUBLIC_ORIGIN: f.pins.target.origin },
            serviceBindings: {
              SIGNALING: f.pins.target.worker,
              ASSETS: async () =>
                new Response(await readFile(join(p.directory, 'web/index.html'), 'utf8')),
            },
          },
          {
            name: f.pins.target.worker,
            modules: true,
            script: await readFile(join(p.directory, 'worker/index.js'), 'utf8'),
            compatibilityDate: '2026-07-01',
            bindings: { ...config.vars, OPS_REVOKE_SECRET: 'f'.repeat(43) },
            durableObjects: {
              SESSION_ROOMS: { className: 'SessionRoom', useSQLite: true },
              RELAY_POOLS: { className: 'RelayPool', useSQLite: true },
              OPERATIONS_MONITOR: { className: 'OperationsMonitor', useSQLite: true },
            },
            ratelimits: {
              CREATE_LIMITER: { namespace_id: '1001', simple: { limit: 30, period: 60 } },
              REQUEST_LIMITER: { namespace_id: '1002', simple: { limit: 300, period: 60 } },
            },
            outboundService: () => new Response(null, { status: 503 }),
          },
        ],
      }),
    );
    await worker.ready;
    await pausedProbe(f.pins, async (input, init) => {
      const response = await worker!.dispatchFetch(String(input), {
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
    const unauthorized = await worker.dispatchFetch(
      f.pins.target.origin + '/v1/sessions/00000000-0000-4000-8000-000000000001/status',
      { headers: { Origin: f.pins.target.origin } },
    );
    expect(unauthorized.status).toBe(401);
    expect(JSON.parse(await readFile(join(p.directory, 'release.json'), 'utf8')).state).toBe(
      'PREPARED',
    );
    await writeFile(join(p.directory, 'worker/index.js'), 'changed after packaging');
    await expect(verifyPreparedArtifacts(p.directory, p.manifest)).rejects.toThrow(
      'PREPARED_ARTIFACT_MISMATCH',
    );
  } finally {
    try {
      await worker?.dispose();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 60000);
