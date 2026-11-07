import { requireRelease, fingerprint, ReleaseError } from '../deploy/release-record';
import { CAPABILITIES, isolation } from './contract';
import type { Isolation } from './contract';

export type Attempt = { attempt: number; pass: boolean; failure: string | null };
const hosted = new WeakMap<object, string>();
/** No retries. The caller selects the only allowed origin through validated pins. */
export async function pausedProbe(
  pins: Isolation,
  transport: typeof fetch = fetch,
  protocolVersion?: number,
) {
  const { target: t } = isolation(pins.target, pins.deny);
  async function request(path: string, method = 'GET', body?: unknown, origin = t.origin) {
    const r = await transport(t.origin + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Origin: origin,
        'Cache-Control': 'no-store',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireRelease(
      !r.redirected && (!r.url || new URL(r.url).origin === t.origin),
      'PREVIEW_PROBE_REDIRECT',
    );
    return r;
  }
  async function status(path: string, method = 'GET', body?: unknown, origin = t.origin) {
    const r = await request(path, method, body, origin);
    await r.body?.cancel();
    return r.status;
  }
  async function json(r: Response) {
    requireRelease(r.body, 'PREVIEW_JSON_REQUIRED');
    const reader = r.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const v = await reader.read();
        if (v.done) break;
        size += v.value.byteLength;
        requireRelease(size <= 65536, 'PREVIEW_RESPONSE_LIMIT');
        chunks.push(v.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel();
    }
  }
  const shell = await request('/');
  requireRelease(
    shell.status === 200 &&
      shell.headers.get('content-security-policy')?.includes("script-src 'self'"),
    'PREVIEW_SHELL_FAILED',
  );
  await shell.body?.cancel();
  if (protocolVersion !== undefined) {
    const protocol = await request('/v1/protocol');
    requireRelease(
      Number.isSafeInteger(protocolVersion) &&
        protocolVersion > 0 &&
        protocol.status === 200 &&
        (await json(protocol)).version === protocolVersion,
      'PREVIEW_PROTOCOL_MISMATCH',
    );
  }
  const health = await request('/health');
  requireRelease(
    health.status === 200 && (await json(health)).sessionsAvailable === false,
    'PREVIEW_HEALTH_ADMISSION_FAILED',
  );
  const ready = await request('/ready');
  requireRelease(
    ready.status === 503 && (await json(ready)).ready === false,
    'PREVIEW_DRAIN_READINESS_FAILED',
  );
  requireRelease((await status('/v1/sessions', 'POST', {})) === 503, 'PREVIEW_ADMISSION_OPEN');
  requireRelease(
    (await status('/v1/sessions', 'POST', {}, 'https://untrusted.invalid')) === 403,
    'PREVIEW_ORIGIN_CHECK_FAILED',
  );
  requireRelease(
    (await status('/v1/sessions/not-a-uuid/status')) === 400,
    'PREVIEW_MALFORMED_SESSION_FAILED',
  );
  requireRelease((await status('/ops/metrics')) === 401, 'PREVIEW_OPERATOR_AUTH_FAILED');
  const room = '/v1/sessions/00000000-0000-4000-8000-000000000001';
  requireRelease(
    (await status(room + '/status')) === 401 &&
      (await status(room + '/join', 'POST', {})) === 401 &&
      (await status(room + '/connection', 'POST', {})) === 401,
    'PREVIEW_SESSION_AUTH_FAILED',
  );
}
async function executeCanary(pins: Isolation, probe: () => Promise<void>, live: boolean) {
  isolation(pins.target, pins.deny);
  const attempts: Attempt[] = [];
  for (let attempt = 1; attempt <= 50; attempt++) {
    // Existing CREATE_LIMITER is 30/minute. Cadence is not a retry or a timeout extension.
    if (live && attempt > 1) await new Promise((resolve) => setTimeout(resolve, 2300));
    try {
      await probe();
      attempts.push({ attempt, pass: true, failure: null });
    } catch (e) {
      attempts.push({
        attempt,
        pass: false,
        failure:
          e instanceof ReleaseError && /^[A-Z0-9_]{1,80}$/.test(e.code)
            ? e.code
            : 'PREVIEW_SMOKE_FAILED',
      });
    }
  }
  const payload = {
    schemaVersion: 1,
    purpose: 'paused-preview-canary',
    scope: live ? 'hosted-preview' : 'local-fixture',
    origin: pins.target.origin,
    attempts,
    attemptCount: 50,
    firstAttemptSuccessCount: attempts.filter((a) => a.pass).length,
    failureCount: attempts.filter((a) => !a.pass).length,
    retries: 0,
    admissionPaused: true,
    coverage: 'shell-health-paused-admission-authorization-only',
    pairingAndTransfer: 'NOT_RUN — NEEDS AUTHORIZED PREEXISTING PREVIEW SESSION',
    natTurn: 'NOT_RUN',
    ...CAPABILITIES,
  };
  const result = { ...payload, digest: fingerprint(payload) };
  if (live) hosted.set(result, result.digest);
  return result;
}
/** Injected probes always stay fixtures, regardless of what their response claims. */
export const runCanary = (pins: Isolation, probe: () => Promise<void>) =>
  executeCanary(pins, probe, false);
export const runHostedCanary = (pins: Isolation, protocolVersion: number) =>
  executeCanary(pins, () => pausedProbe(pins, undefined, protocolVersion), true);
export function validateCanary(value: Awaited<ReturnType<typeof runCanary>>) {
  const { digest, ...body } = value;
  requireRelease(
    hosted.get(value) === digest &&
      digest === fingerprint(body) &&
      value.scope === 'hosted-preview' &&
      value.attemptCount === 50 &&
      value.attempts.length === 50 &&
      value.attempts.every(
        (a, i) => a.attempt === i + 1 && a.pass === true && a.failure === null,
      ) &&
      value.firstAttemptSuccessCount === 50 &&
      value.failureCount === 0 &&
      value.retries === 0 &&
      value.admissionPaused === true &&
      Object.entries(CAPABILITIES).every(([k, v]) => body[k as keyof typeof body] === v),
    'PREVIEW_CANARY_INCOMPLETE_OR_UNTRUSTED',
  );
  return { smokePassed: true, fullFunctionalCoverage: false, ...CAPABILITIES };
}
