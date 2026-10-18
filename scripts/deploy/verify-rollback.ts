import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { approve, create, join as admit, request, runtime } from '../../tests/integration/harness';

const baseline =
  process.env.MESHDROP_ROLLBACK_BASELINE ?? 'e108e7a1f59bc37f41ba703240e08f176d47b33c';
if (!/^[a-f0-9]{40}$/.test(baseline)) throw new Error('Use an exact baseline commit SHA.');
const root = resolve('.meshdrop-artifacts/phase-9-rollback');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'run-'));
// Read-only Git operations. Old source is extracted only into a generated directory.
const paths = execFileSync(
  'git',
  ['ls-tree', '-r', '--name-only', baseline, 'apps/signaling/src'],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n');
if (!paths.includes('apps/signaling/src/index.ts'))
  throw new Error('Baseline source is unavailable; fetch its history first.');
for (const path of paths) {
  if (!/^apps\/signaling\/src\/[A-Za-z0-9_./-]+\.ts$/.test(path) || path.includes('..'))
    throw new Error('Unexpected baseline path.');
  const output = join(directory, 'baseline', path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, execFileSync('git', ['show', `${baseline}:${path}`]));
}
const old = await build({
  entryPoints: [join(directory, 'baseline/apps/signaling/src/index.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['cloudflare:workers'],
});
const persist = join(directory, 'state');
let worker = await runtime({ persist });
const report = {
  phase: 'P9',
  scope: 'local workerd SQLite code rollback; not Cloudflare remote rollout',
  baseline,
  pass: false,
  stages: [] as string[],
};
try {
  const room = await create(worker);
  const { guest } = await admit(worker, room);
  if (!(await approve(worker, room, guest.peerId)).ok) throw new Error('Initial approval failed.');
  report.stages.push('P9 create/admit/approve');
  await worker.dispose();
  worker = await runtime({ persist, script: old.outputFiles[0]!.text });
  const rolledBack = await request(worker, `/v1/sessions/${room.roomId}/status`, {
    token: room.ownerCapability,
  });
  if (!rolledBack.ok || ((await rolledBack.json()) as { state?: string }).state !== 'approved')
    throw new Error('Baseline cannot read the persisted approved room.');
  report.stages.push('P8 reads same persisted approved room');
  await worker.dispose();
  worker = await runtime({ persist, bindings: { ADMISSION_PAUSED: 'true' } });
  if ((await request(worker, '/v1/sessions', { method: 'POST', body: {} })).status !== 503)
    throw new Error('Admission drain failed.');
  if (
    !(await request(worker, `/v1/sessions/${room.roomId}/status`, { token: room.ownerCapability }))
      .ok
  )
    throw new Error('Existing room failed after roll-forward.');
  if (
    !(
      await request(worker, `/v1/sessions/${room.roomId}`, {
        method: 'DELETE',
        token: room.ownerCapability,
      })
    ).ok
  )
    throw new Error('Existing room cannot close during drain.');
  report.stages.push('P9 roll-forward, drain denies new room, existing room readable and closable');
  report.pass = true;
} finally {
  await worker.dispose();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
