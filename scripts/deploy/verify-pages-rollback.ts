import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { sessionCreatedSchema, sessionStatusSchema } from '@meshdrop/protocol';
import { cloudflareToken } from './auth';
import { deploymentConfig } from './config';
import { exercisePagesRollback, pagesClient, previousDeployment } from './pages-rollback';
import type { PagesDeployment } from './pages-rollback';

if (process.argv[2] !== 'preview') throw new Error('This drill is restricted to preview.');
const path = 'infrastructure/cloudflare/preview/.env';
if ((await stat(path)).mode & 0o077) throw new Error('Set the preview .env mode to 0600.');
const values = parseEnv(await readFile(path, 'utf8'));
const config = deploymentConfig('preview', values, process.cwd());
const directory = '.meshdrop-artifacts/phase-9';
await mkdir(directory, { recursive: true });
const report: Record<string, unknown> = {
  phase: 'P9',
  scope: 'public preview Pages rollback and restoration; Worker version unchanged',
  origin: config.origin,
  pass: false,
  error: 'PAGES_PREFLIGHT_FAILED',
};
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
let room: ReturnType<typeof sessionCreatedSchema.parse> | undefined;
async function fingerprint() {
  const shell = await api('/');
  if (!shell.ok || !shell.headers.get('Content-Security-Policy')?.includes("script-src 'self'"))
    throw new Error('PAGES_SHELL_POLICY_FAILED');
  const html = await shell.text();
  const module = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/)?.[1];
  if (!module) throw new Error('PAGES_CLIENT_MODULE_MISSING');
  const response = await api(module);
  if (!response.ok) throw new Error('PAGES_CLIENT_MODULE_UNAVAILABLE');
  return {
    module,
    sha256: createHash('sha256')
      .update(await response.text())
      .digest('hex'),
  };
}
async function healthy() {
  const ready = await api('/ready');
  if (!ready.ok || (await ready.json()).ready !== true) throw new Error('PAGES_NOT_READY');
  const response = await api(`/v1/sessions/${room!.roomId}/status`, 'GET', room!.ownerCapability);
  if (!response.ok) throw new Error('PAGES_ROOM_UNAVAILABLE');
  const status = sessionStatusSchema.parse(await response.json());
  if (status.state !== 'approved' || status.approval !== 'approved')
    throw new Error('PAGES_ROOM_STATE_CHANGED');
}
try {
  const client = pagesClient(
    values.CLOUDFLARE_ACCOUNT_ID ?? '',
    config.project,
    await cloudflareToken(values),
  );
  const latest = await client.active();
  const previous = previousDeployment(latest, await client.history());
  const original = await fingerprint();
  report.originalAssets = original;
  const created = await api('/v1/sessions', 'POST', undefined, {});
  if (created.status !== 201) throw new Error();
  room = sessionCreatedSchema.parse(await created.json());
  const guest = { peerId: randomUUID(), peerCapability: randomBytes(32).toString('base64url') };
  const base = `/v1/sessions/${room.roomId}`;
  if (!(await api(`${base}/join`, 'POST', room.inviteCapability, guest)).ok) throw new Error();
  if (
    !(
      await api(`${base}/decisions`, 'POST', room.ownerCapability, {
        candidatePeerId: guest.peerId,
        decision: 'approve',
      })
    ).ok
  )
    throw new Error();
  await healthy();
  // Persist the restore target before changing the stable alias. No credentials/room IDs.
  await writeFile(
    `${directory}/pages-restore-target.json`,
    JSON.stringify({ origin: config.origin, latest, previous, original }, null, 2),
  );
  async function promote(target: PagesDeployment) {
    await client.promote(target);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await client.active()).id === target.id) return;
      await setTimeout(1000);
    }
    throw new Error('PAGES_ALIAS_SWITCH_TIMEOUT');
  }
  Object.assign(
    report,
    await exercisePagesRollback({
      latest,
      previous,
      active: client.active,
      promote,
      async verify(stage) {
        // The provider alias can update before all edge locations serve the new assets.
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            await healthy();
            const assets = await fingerprint();
            if ((assets.sha256 === original.sha256) !== (stage === 'restored')) throw new Error();
            report[`${stage}Assets`] = assets;
            return;
          } catch {
            if (attempt === 19) throw new Error('PAGES_PUBLIC_VERIFICATION_FAILED');
            await setTimeout(1000);
          }
        }
      },
    }),
  );
} catch {
  // Preserve a restoration failure classification if the drill reached that stage.
} finally {
  if (room) {
    try {
      const closed = await api(`/v1/sessions/${room.roomId}`, 'DELETE', room.ownerCapability);
      report.roomClosed = closed.ok;
      if (!closed.ok) {
        report.pass = false;
        report.error ||= 'PAGES_ROOM_CLEANUP_FAILED';
      }
    } catch {
      report.roomClosed = false;
      report.pass = false;
      report.error ||= 'PAGES_ROOM_CLEANUP_FAILED';
    }
  }
  report.recordedAt = new Date().toISOString();
  await writeFile(`${directory}/pages-rollback.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
process.exitCode = report.pass ? 0 : 1;
