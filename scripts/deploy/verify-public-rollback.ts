import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { sessionCreatedSchema, sessionStatusSchema } from '@meshdrop/protocol';
import { cloudflareToken } from './auth';
import { deploymentConfig } from './config';

if (process.argv[2] !== 'preview') throw new Error('This drill is restricted to preview.');
const values = parseEnv(await readFile('infrastructure/cloudflare/preview/.env', 'utf8'));
const config = deploymentConfig('preview', values, process.cwd());
if (!/^[a-f0-9]{32}$/.test(values.CLOUDFLARE_ACCOUNT_ID ?? ''))
  throw new Error('Set the preview Cloudflare account.');
const token = await cloudflareToken(values);
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${values.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${config.workerName}/deployments`;
const report = {
  phase: 'P9',
  scope: 'public preview Worker rollback and roll-forward; Pages assets unchanged',
  origin: config.origin,
  pass: false,
  checks: [] as string[],
  latestVersion: '',
  rollbackVersion: '',
  restored: false,
  error: '',
};
async function provider(method = 'GET', body?: unknown) {
  const response = await fetch(endpoint, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = (await response.json()) as {
    success?: boolean;
    result?: { deployments?: { versions: { version_id: string; percentage: number }[] }[] };
  };
  if (!response.ok || !result.success) throw new Error('Provider deployment operation failed.');
  return result.result;
}
async function deploy(version: string) {
  if (!/^[a-f0-9-]{36}$/.test(version)) throw new Error('Invalid recorded version.');
  await provider('POST', {
    strategy: 'percentage',
    versions: [{ version_id: version, percentage: 100 }],
    annotations: { 'workers/message': 'MeshDrop preview rollback acceptance drill' },
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const active = (await provider())?.deployments?.[0]?.versions;
    if (active?.length === 1 && active[0]?.version_id === version && active[0].percentage === 100)
      return;
    await setTimeout(1000);
  }
  throw new Error('Recorded version did not become active.');
}
const api = (path: string, method = 'GET', capability?: string, body?: unknown) =>
  fetch(`${config.origin}${path}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: config.origin,
      ...(capability ? { Authorization: `Bearer ${capability}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
let room: ReturnType<typeof sessionCreatedSchema.parse> | undefined;
let restorationRequired = false;
async function restoreLatest() {
  await deploy(report.latestVersion);
  if (!(await api('/ready')).ok) throw new Error('Restored readiness failed.');
  if (room) {
    const status = sessionStatusSchema.parse(
      await (await api(`/v1/sessions/${room.roomId}/status`, 'GET', room.ownerCapability)).json(),
    );
    if (status.state !== 'approved') throw new Error('Restored room unavailable.');
  }
}
try {
  const deployments = (await provider())?.deployments ?? [];
  const current = deployments[0]?.versions;
  if (current?.length !== 1 || current[0]?.percentage !== 100)
    throw new Error('Require one active preview version.');
  report.latestVersion = current[0].version_id;
  report.rollbackVersion =
    deployments
      .slice(1)
      .find(
        (item) =>
          item.versions.length === 1 &&
          item.versions[0]?.percentage === 100 &&
          item.versions[0].version_id !== report.latestVersion,
      )?.versions[0]?.version_id ?? '';
  if (!report.rollbackVersion) throw new Error('A previous recorded version is required.');
  room = sessionCreatedSchema.parse(
    await (await api('/v1/sessions', 'POST', undefined, {})).json(),
  );
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
  report.checks.push('current Worker creates and approves a synthetic room');
  restorationRequired = true; // Restore even if a deployment response is lost.
  await deploy(report.rollbackVersion);
  const status = sessionStatusSchema.parse(
    await (await api(`${base}/status`, 'GET', room.ownerCapability)).json(),
  );
  if (status.state !== 'approved' || status.approval !== 'approved') throw new Error();
  report.checks.push('recorded previous Worker reads the same approved SQLite room');
} catch {
  report.error = 'PUBLIC_ROLLBACK_GATE_FAILED';
} finally {
  if (restorationRequired) {
    try {
      await restoreLatest();
      report.restored = true;
      report.checks.push('latest recorded Worker restored; readiness and same room verified');
    } catch {
      report.error = 'PUBLIC_ROLL_FORWARD_REQUIRES_ATTENTION';
    }
  }
  if (room)
    await api(`/v1/sessions/${room.roomId}`, 'DELETE', room.ownerCapability).catch(() => {});
  report.pass = !report.error && report.restored && report.checks.length === 3;
  await mkdir('.meshdrop-artifacts/phase-9', { recursive: true });
  await writeFile(
    '.meshdrop-artifacts/phase-9/public-rollback.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
process.exitCode = report.pass ? 0 : 1;
