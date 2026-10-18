/** Only fixed classifications and status; no URLs, identifiers or client data. */
export function audit(
  env: { AUDIT_LOGS?: string; ENVIRONMENT?: string },
  operation: string,
  status: number,
): void {
  if (env.AUDIT_LOGS !== 'true') return;
  const allowed = ['create', 'join', 'ws', 'revoke', 'control', 'other'];
  console.log(
    JSON.stringify({
      event: 'meshdrop.control',
      environment: env.ENVIRONMENT === 'production' ? 'production' : 'preview',
      operation: allowed.includes(operation) ? operation : 'other',
      status,
    }),
  );
}
