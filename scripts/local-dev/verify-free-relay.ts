import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runtime, API, request } from '../../tests/integration/harness';
import { publicTransferSmoke } from '../deploy/transfer-smoke';

// Opt-in real-provider test: at most three 1 MiB synthetic transfers. Never
// changes provider subscriptions. The provider's Free hard stop is mandatory.
const path = '.meshdrop-artifacts/relay-cloud/.env';
if ((await stat(path)).mode & 0o077) throw new Error('Relay .env must use mode 0600.');
const values = parseEnv(await readFile(path, 'utf8'));
if (values.METERED_FREE_ONLY !== 'true')
  throw new Error(
    'Verify the provider Free hard stop, then explicitly set METERED_FREE_ONLY=true.',
  );
const blocked = process.env.MESHDROP_TEST_UDP_BLOCKED === 'true';
// This assertion is supplied by an external isolated firewall harness, never
// inferred from a browser flag. This runner does not change any firewall.
const transports = blocked ? (['tcp', 'tls'] as const) : (['udp', 'tcp', 'tls'] as const);
const directory = `.meshdrop-artifacts/free-relay/${Date.now()}`;
await mkdir(directory, { recursive: true });
const operator = randomBytes(32).toString('base64url');
const worker = await runtime({
  bindings: {
    OPS_REVOKE_SECRET: operator,
    ALLOWED_ORIGINS: 'http://127.0.0.1:5193',
    TURN_PROVIDER: 'metered',
    METERED_DOMAIN: values.METERED_DOMAIN!,
    METERED_SECRET_KEY: values.METERED_SECRET_KEY!,
    METERED_FREE_ONLY: 'true',
  },
});
const address = await worker.ready;
const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5193', '--strictPort'],
  {
    cwd: 'apps/web',
    env: { ...process.env, MESHDROP_SIGNAL_ORIGIN: address.origin },
    stdio: 'ignore',
  },
);
let startupFailed = false;
vite.once('error', () => {
  startupFailed = true;
});
vite.once('exit', () => {
  startupFailed = true;
});
const results: { transport: string; pass: boolean; [key: string]: unknown }[] = [];
const report = {
  checkedAt: new Date().toISOString(),
  scope:
    'real Metered Free provider; local Worker/SQLite authorization; complete MeshDrop browser transfer and exported-file verification',
  externallyAssertedUdpBlock: blocked,
  billingChanges: false,
  pass: false,
  results,
};
try {
  for (let n = 0; n < 30; n++) {
    if (startupFailed) throw new Error('LOCAL_WEB_START_FAILED');
    try {
      if ((await fetch('http://127.0.0.1:5193')).ok) break;
    } catch {
      /* Starting. */
    }
    if (n === 29) throw new Error('LOCAL_WEB_START_FAILED');
    await delay(1000);
  }
  const warm = await request(worker, '/ops/relay/warm', {
    method: 'POST',
    token: operator,
    body: {},
  });
  if (!warm.ok) throw new Error('RELAY_WARM_REQUEST_FAILED');
  console.log('Waiting for the provider propagation window.');
  let ready = false;
  for (let n = 0; n < 35; n++) {
    const response = await worker.dispatchFetch(`${API}/ops/relay`, {
      headers: { Authorization: `Bearer ${operator}` },
    });
    const state = (await response.json()) as { ready: boolean; nextReadyAt: number | null };
    if (state.ready) {
      ready = true;
      break;
    }
    if (n > 2 && state.nextReadyAt === null) throw new Error('FREE_PROVIDER_UNAVAILABLE');
    await delay(5000);
  }
  if (!ready) throw new Error('RELAY_PROPAGATION_TIMEOUT');
  for (const transport of transports) {
    try {
      const result = await publicTransferSmoke('http://127.0.0.1:5193', directory, transport, {
        relayOnly: true,
        relayTransport: transport,
        disableUdp: !blocked && transport !== 'udp',
      });
      results.push({ transport, pass: true, ...result });
    } catch (error) {
      results.push({
        transport,
        pass: false,
        error:
          error instanceof Error && /^PRODUCT_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'RELAY_TRANSFER_FAILED',
      });
    }
  }
  report.pass = results.length === transports.length && results.every((result) => result.pass);
} catch (error) {
  results.push({
    transport: 'setup',
    pass: false,
    error:
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : 'LIVE_RELAY_FAILED',
  });
} finally {
  vite.kill('SIGINT');
  await worker.dispose();
  await writeFile(`${directory}/summary.json`, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
