import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { deploymentConfig, environment } from './config';
import { sessionCreatedSchema } from '@meshdrop/protocol';

const [command, targetValue] = process.argv.slice(2);
const target = environment(targetValue);
const path = `infrastructure/cloudflare/${target}/.env`;
if ((await stat(path)).mode & 0o077) throw new Error('Deployment .env must use mode 0600.');
const values = parseEnv(await readFile(path, 'utf8'));
const config = deploymentConfig(target, values, process.cwd());
async function api(
  route: string,
  method = 'GET',
  body?: unknown,
  token: string | null | undefined = values.OPS_REVOKE_SECRET,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.origin}${route}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: config.origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Operations request failed (${response.status}).`);
  if (!response.body) throw new Error('Missing operations response.');
  const reader = response.body.getReader();
  let text = '',
    bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 8192) {
      void reader.cancel().catch(() => {});
      throw new Error('Operations response exceeded its limit.');
    }
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as Record<string, unknown>;
}
try {
  let result: unknown;
  if (command === 'status')
    result = {
      metrics: await api('/ops/metrics'),
      alerts: await api('/ops/alerts'),
      relay: await api('/ops/relay'),
    };
  else if (command === 'warm') {
    if (config.worker.vars.TURN_PROVIDER !== 'metered')
      throw new Error('Warmup requires the explicitly configured free Metered pool.');
    result = await api('/ops/relay/warm', 'POST', {});
  } else if (command === 'evaluate') result = await api('/ops/alerts/evaluate', 'POST', {});
  else if (command === 'test-alert') result = await api('/ops/alerts/test', 'POST', {});
  else if (command === 'verify') {
    const started = Date.now();
    const room = sessionCreatedSchema.parse(await api('/v1/sessions', 'POST', {}, null));
    let closed = false;
    try {
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`${config.origin}/v1/sessions/${room.roomId}/join`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Origin: config.origin,
            Authorization: `Bearer ${randomBytes(32).toString('base64url')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            peerId: randomUUID(),
            peerCapability: randomBytes(32).toString('base64url'),
          }),
        });
        void response.body?.cancel().catch(() => {});
        if (response.status !== 403) throw new Error('FAILED_JOIN_DENIAL_GATE');
      }
      for (let i = 0; i < 30; i++) {
        const counts = await api('/ops/metrics');
        if (Number(counts.failedJoinsLastFiveMinutes) >= 10) break;
        if (i === 29) throw new Error('FAILED_JOIN_COUNTER_GATE');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await api('/ops/alerts/evaluate', 'POST', {});
      const journal = await api('/ops/alerts');
      const delivered = (
        journal.alerts as { kind: string; observedAt: number; value: number }[]
      ).some(
        (alert) =>
          alert.kind === 'failed_joins' && alert.observedAt >= started && alert.value >= 10,
      );
      if (!delivered) throw new Error('AUTHENTICATED_WEBHOOK_DELIVERY_GATE');
      result = {
        pass: true,
        environment: target,
        origin: config.origin,
        scope:
          'actual failed-join control requests → aggregate monitor → HTTPS webhook → independent journal actor',
        attemptedFailedJoins: 10,
        deliveryVerified: true,
        emailSent: false,
        billingChanges: false,
      };
    } finally {
      try {
        await api(`/v1/sessions/${room.roomId}`, 'DELETE', undefined, room.ownerCapability);
        closed = true;
      } catch {
        /* Report cleanup failure without credentials. */
      }
    }
    if (!closed) throw new Error('OPERATIONS_TEST_ROOM_CLEANUP_GATE');
    await mkdir('.meshdrop-artifacts/audit-2026-10-25', { recursive: true });
    await writeFile(
      `.meshdrop-artifacts/audit-2026-10-25/operations-${target}.json`,
      JSON.stringify(result, null, 2) + '\n',
    );
  } else
    throw new Error(
      'Use status, warm, evaluate, test-alert or verify, followed by preview|production.',
    );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Operations check failed.');
  process.exitCode = 1;
}
