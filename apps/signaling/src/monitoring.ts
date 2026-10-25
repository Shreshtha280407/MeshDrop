import type { Env } from './env';
import { HttpError } from './http-error';
export const CONTROL_OPERATIONS = ['create', 'join', 'ws', 'revoke', 'control', 'other'] as const;
export const ALERT_KINDS = [
  'failed_joins',
  'server_errors',
  'control_request_budget',
  'account_worker_request_budget',
  'account_durable_request_budget',
  'relay_quota',
  'delivery_test',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export interface OperationalAlert {
  id: string;
  kind: AlertKind;
  environment: 'preview' | 'production';
  observedAt: number;
  value: number;
  threshold: number;
}
export function validatedAlert(value: unknown): OperationalAlert {
  if (!value || typeof value !== 'object')
    throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid operational alert.');
  const alert = value as OperationalAlert;
  if (
    Object.keys(value).sort().join(',') !== 'environment,id,kind,observedAt,threshold,value' ||
    !ALERT_KINDS.includes(alert.kind) ||
    !new RegExp(`^${alert.kind}:\\d{1,15}$`).test(alert.id) ||
    !['preview', 'production'].includes(alert.environment) ||
    !Number.isSafeInteger(alert.observedAt) ||
    alert.observedAt < 0 ||
    !Number.isFinite(alert.value) ||
    alert.value < 0 ||
    !Number.isFinite(alert.threshold) ||
    alert.threshold <= 0
  )
    throw new HttpError(400, 'INVALID_MESSAGE', 'Invalid operational alert.');
  return alert;
}
export async function monitorRequest(
  env: Env,
  path: string,
  body?: unknown,
  journal = false,
): Promise<Response> {
  if (!env.OPERATIONS_MONITOR)
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Monitoring is not configured.');
  return env.OPERATIONS_MONITOR.get(
    env.OPERATIONS_MONITOR.idFromName(journal ? 'journal' : 'counters'),
  ).fetch(
    new Request(`https://monitor.internal${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${env.OPS_REVOKE_SECRET ?? ''}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
export async function recordOperation(env: Env, operation: string, status: number): Promise<void> {
  if (!env.OPERATIONS_MONITOR || !env.OPS_REVOKE_SECRET) return;
  await monitorRequest(env, '/record', {
    operation: CONTROL_OPERATIONS.includes(operation as (typeof CONTROL_OPERATIONS)[number])
      ? operation
      : 'other',
    status,
  });
}
