import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { sessionCreatedSchema, sessionStatusSchema } from '@meshdrop/protocol';
import { cloudflareToken } from './auth';
import { deploymentConfig } from './config';
import { pagesClient } from './pages-rollback';
import {
  exerciseProductRollback,
  validateRelease,
  workerDeploymentClient,
} from './product-rollback';
import type { ReleasePair } from './product-rollback';
import { publicTransferSmoke } from './transfer-smoke';

if (process.argv[2] !== 'preview') throw new Error('This drill is restricted to preview.');
const path = 'infrastructure/cloudflare/preview/.env';
if ((await stat(path)).mode & 0o077) throw new Error('Set the preview .env mode to 0600.');
const values = parseEnv(await readFile(path, 'utf8'));
const config = deploymentConfig('preview', values, process.cwd());
const directory = '.meshdrop-artifacts/phase-9/product-rollback';
await mkdir(directory, { recursive: true });
const report: Record<string, unknown> = {
  phase: 'P9',
  scope: 'coordinated public preview Pages/Worker rollback and restoration',
  origin: config.origin,
  pass: false,
  error: 'PRODUCT_PREFLIGHT_FAILED',
  transfers: {},
  stage: 'authentication',
};
let room: ReturnType<typeof sessionCreatedSchema.parse> | undefined;
const api = (route: string, method = 'GET', capability?: string, body?: unknown) =>
  fetch(`${config.origin}${route}`, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: config.origin,
      ...(capability ? { Authorization: `Bearer ${capability}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function fingerprint() {
  const response = await api('/');
  if (
    !response.ok ||
    !response.headers.get('Content-Security-Policy')?.includes("script-src 'self'")
  )
    throw new Error('PRODUCT_SHELL_POLICY_FAILED');
  const module = (await response.text()).match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  if (!module) throw new Error('PRODUCT_CLIENT_MODULE_MISSING');
  const asset = await api(module);
  if (!asset.ok) throw new Error('PRODUCT_CLIENT_MODULE_UNAVAILABLE');
  return {
    module,
    sha256: createHash('sha256')
      .update(await asset.text())
      .digest('hex'),
  };
}
async function persistedRoom() {
  const ready = await api('/ready');
  if (!ready.ok || (await ready.json()).ready !== true) throw new Error('PRODUCT_NOT_READY');
  const response = await api(`/v1/sessions/${room!.roomId}/status`, 'GET', room!.ownerCapability);
  if (!response.ok) throw new Error('PRODUCT_PERSISTED_ROOM_UNAVAILABLE');
  const status = sessionStatusSchema.parse(await response.json());
  if (status.state !== 'approved' || status.approval !== 'approved')
    throw new Error('PRODUCT_PERSISTED_ROOM_CHANGED');
}
try {
  const token = await cloudflareToken(values);
  const pages = pagesClient(values.CLOUDFLARE_ACCOUNT_ID ?? '', config.project, token);
  report.stage = 'component-evidence';
  // v2 namespaces make the historical v1-only Worker an unsafe target.
  // Require a recorded compatible pair rather than silently selecting old evidence.
  const recordPath = process.argv[3];
  if (
    !recordPath?.startsWith('.meshdrop-artifacts/') ||
    recordPath.split('/').includes('..') ||
    (await stat(recordPath)).mode & 0o077
  )
    throw new Error('PRODUCT_PRIVATE_V2_RELEASE_RECORD_REQUIRED');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.migration !== 'v2') throw new Error('PRODUCT_V2_RELEASE_RECORD_REQUIRED');
  const recorded = validateRelease(record.release);
  if (
    recorded.origin !== config.origin ||
    recorded.project !== config.project ||
    recorded.workerName !== config.workerName
  )
    throw new Error('PRODUCT_RECORDED_RELEASE_SCOPE_MISMATCH');
  if (
    record.allowedSecretChanges !== undefined &&
    (!Array.isArray(record.allowedSecretChanges) ||
      record.allowedSecretChanges.some((name: unknown) => typeof name !== 'string'))
  )
    throw new Error('PRODUCT_INVALID_SECRET_CHANGE_RECORD');
  const worker = workerDeploymentClient(
    values.CLOUDFLARE_ACCOUNT_ID ?? '',
    config.workerName,
    token,
    fetch,
    { allowedSecretChanges: record.allowedSecretChanges ?? [] },
  );
  const active = async () => {
    const [workerVersion, page] = await Promise.all([worker.active(), pages.active()]);
    return { workerVersion, pagesDeployment: page.id };
  };
  async function compatibleActors(version: string) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${values.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${config.workerName}/versions/${version}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      },
    );
    const data = await response.json();
    const names = new Set(
      (data.result?.resources?.bindings ?? [])
        .filter((binding: { type?: string }) => binding.type === 'durable_object_namespace')
        .map((binding: { class_name?: string }) => binding.class_name),
    );
    if (
      !response.ok ||
      data.success !== true ||
      !['SessionRoom', 'RelayPool', 'OperationsMonitor'].every((name) => names.has(name))
    )
      throw new Error('PRODUCT_V2_ACTOR_TARGET_REQUIRED');
  }
  report.stage = 'deployment-preflight';
  const preflight = await Promise.allSettled([
    pages.active(),
    worker.active(),
    pages.history(),
    fingerprint(),
  ] as const);
  report.preflight = preflight.map((item, index) => ({
    check: ['active-pages', 'active-worker', 'pages-history', 'public-assets'][index],
    ok: item.status === 'fulfilled',
    ...(item.status === 'rejected'
      ? {
          code:
            item.reason?.cause?.code ??
            item.reason?.message?.match(/(?:PRODUCT|PAGES)_[A-Z_]+/)?.[0] ??
            'UNAVAILABLE',
        }
      : {}),
  }));
  if (preflight.some((item) => item.status === 'rejected'))
    throw new Error('PRODUCT_PREFLIGHT_UNAVAILABLE');
  const latestPages = (
    preflight[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof pages.active>>>
  ).value;
  const latestWorker = (preflight[1] as PromiseFulfilledResult<string>).value;
  const history = (preflight[2] as PromiseFulfilledResult<unknown[]>).value;
  const originalAssets = (
    preflight[3] as PromiseFulfilledResult<Awaited<ReturnType<typeof fingerprint>>>
  ).value;
  const previousPages = history.find(
    (item) => (item as { id?: string }).id === recorded.pages.id,
  ) as ReleasePair['pages'] | undefined;
  if (!previousPages) throw new Error('PRODUCT_RECORDED_PAGES_TARGET_REQUIRED');
  const common = { origin: config.origin, project: config.project, workerName: config.workerName };
  const latest = validateRelease({
    ...common,
    workerVersion: latestWorker,
    pages: latestPages,
    assets: originalAssets,
  });
  const previous = validateRelease({
    ...common,
    workerVersion: recorded.workerVersion,
    pages: previousPages,
    assets: recorded.assets,
  });
  await Promise.all([
    compatibleActors(latest.workerVersion),
    compatibleActors(previous.workerVersion),
  ]);
  const transferResults: Record<string, Awaited<ReturnType<typeof publicTransferSmoke>>> = {};
  report.transfers = transferResults;
  report.stage = 'before-transfer';
  console.log(
    'Checking the current public pair with a fresh synthetic transfer and exported receipt.',
  );
  transferResults.before = await publicTransferSmoke(config.origin, directory, 'before');
  report.stage = 'persisted-room';
  const created = await api('/v1/sessions', 'POST', undefined, {});
  if (created.status !== 201) throw new Error('PRODUCT_ROOM_CREATE_FAILED');
  room = sessionCreatedSchema.parse(await created.json());
  const guest = { peerId: randomUUID(), peerCapability: randomBytes(32).toString('base64url') };
  const base = `/v1/sessions/${room.roomId}`;
  if (
    !(await api(`${base}/join`, 'POST', room.inviteCapability, guest)).ok ||
    !(
      await api(`${base}/decisions`, 'POST', room.ownerCapability, {
        candidatePeerId: guest.peerId,
        decision: 'approve',
      })
    ).ok
  )
    throw new Error('PRODUCT_ROOM_APPROVAL_FAILED');
  await persistedRoom();
  // Recoverable restore target is durable before the first remote mutation.
  await writeFile(
    `${directory}/restore-target.json`,
    JSON.stringify({ latest, previous }, null, 2),
  );
  async function waitForPair(expected: ReleasePair) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const actual = await active();
      if (
        actual.workerVersion === expected.workerVersion &&
        actual.pagesDeployment === expected.pages.id
      )
        return;
      await setTimeout(1000);
    }
    throw new Error('PRODUCT_DEPLOYMENT_PROPAGATION_FAILED');
  }
  const result = await exerciseProductRollback({
    latest,
    previous,
    active,
    async promoteWorker(version) {
      try {
        await worker.promote(version);
      } catch (error) {
        report.providerFailure = { component: 'worker', version, detail: (error as Error).cause };
        throw error;
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await worker.active()) === version) return;
        await setTimeout(1000);
      }
      throw new Error('PRODUCT_WORKER_PROPAGATION_FAILED');
    },
    async promotePages(deployment) {
      try {
        await pages.promote(deployment);
      } catch (error) {
        report.providerFailure = {
          component: 'pages',
          deployment: deployment.id,
          detail: (error as Error).cause,
        };
        throw error;
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await pages.active()).id === deployment.id) return;
        await setTimeout(1000);
      }
      throw new Error('PRODUCT_PAGES_PROPAGATION_FAILED');
    },
    async verify(stage, expected) {
      report.stage = stage;
      console.log(
        `Checking ${stage} pair: exact client, persisted room, fresh transfer, saved bytes and receipt.`,
      );
      await waitForPair(expected);
      let matches = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const actual = await fingerprint();
        if (actual.module === expected.assets.module && actual.sha256 === expected.assets.sha256) {
          matches = true;
          break;
        }
        await setTimeout(1000);
      }
      if (!matches) throw new Error('PRODUCT_ASSET_FINGERPRINT_MISMATCH');
      await persistedRoom();
      transferResults[stage] = await publicTransferSmoke(config.origin, directory, stage);
      await waitForPair(expected);
      report[`${stage}Assets`] = expected.assets;
    },
  });
  Object.assign(report, result);
  report.candidateProvenance =
    'explicit previously verified component IDs; compatibility verified together in this drill, not inferred from timestamps or claimed as a historical source-matched release';
  report.originalAssets = originalAssets;
} catch (error) {
  report.error =
    error instanceof Error
      ? (error.message.match(/(?:PRODUCT|PAGES)_[A-Z_]+/)?.[0] ?? 'PRODUCT_ROLLBACK_GATE_FAILED')
      : 'PRODUCT_ROLLBACK_GATE_FAILED';
  report.pass = false;
  report.failureCode =
    error instanceof Error
      ? ((error.cause as { code?: string } | undefined)?.code ??
        error.message.match(/net::ERR_[A-Z_]+|Timeout \d+ms|Executable doesn't exist/)?.[0] ??
        'UNAVAILABLE')
      : 'UNAVAILABLE';
} finally {
  if (room) {
    const closed = await api(`/v1/sessions/${room.roomId}`, 'DELETE', room.ownerCapability).catch(
      () => null,
    );
    report.roomClosed = Boolean(closed?.ok);
    if (!closed?.ok) {
      report.pass = false;
      if (!report.error) report.error = 'PRODUCT_ROOM_CLEANUP_FAILED';
    }
  }
  report.recordedAt = new Date().toISOString();
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
process.exitCode = report.pass === true ? 0 : 1;
