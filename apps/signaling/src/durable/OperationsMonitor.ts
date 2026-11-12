import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { allowedOrigins } from '../env';
import { errorResponse, HttpError } from '../errors';
import { readJson } from '../limits';
import { operatorAuthorized } from '../operations';
import { CONTROL_OPERATIONS, validatedAlert } from '../monitoring';
import type { OperationalAlert, AlertKind } from '../monitoring';
import {
  accountAnalyticsConfigured,
  accountUsage,
  ACCOUNT_USAGE_REFRESH_MS,
} from '../routes/account-usage';
import type { AccountUsage } from '../routes/account-usage';

export const MAX_PENDING_ALERTS = 128;

/** Free-plan monitor: bounded aggregate control counters and a redacted alert outbox.
 * Counts are application observations, not provider-wide billing measurements. */
export class OperationsMonitor extends DurableObject<Env> {
  private providerUsage: { lastCheckAt: number; value: AccountUsage | null } = {
    lastCheckAt: 0,
    value: null,
  };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS buckets(slot INTEGER,metric TEXT,count INTEGER,PRIMARY KEY(slot,metric));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY,payload TEXT,created_at INTEGER);`);
    void ctx.blockConcurrencyWhile(async () => {
      this.providerUsage =
        (await ctx.storage.get<typeof this.providerUsage>('account-usage')) ?? this.providerUsage;
    });
  }
  private total(metric: string, since: number): number {
    return this.ctx.storage.sql
      .exec<{
        total: number;
      }>(
        'SELECT COALESCE(SUM(count),0) AS total FROM buckets WHERE slot >= ? AND metric = ?',
        Math.floor(since / 60000),
        metric,
      )
      .one().total;
  }
  private snapshot() {
    const now = Date.now(),
      day = Math.floor(now / 86400000) * 86400000;
    return {
      scope: 'observed control-plane requests; excludes health checks and other account services',
      requestsToday: this.total('requests', day),
      failedJoinsLastFiveMinutes: this.total('failed_joins', now - 300000),
      serverErrorsLastFiveMinutes: this.total('server_errors', now - 300000),
      pendingDeliveries: this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox')
        .one().count,
      accountWorkerUsage: accountAnalyticsConfigured(this.env)
        ? {
            source:
              'Cloudflare account Workers/Pages/DO request analytics; may be sampled or delayed; not an invoice',
            available:
              this.providerUsage.value !== null &&
              this.providerUsage.value.dayStart === day &&
              now - this.providerUsage.value.checkedAt < ACCOUNT_USAGE_REFRESH_MS * 2,
            lastCheckAt: this.providerUsage.lastCheckAt,
            measured: this.providerUsage.value,
          }
        : null,
    };
  }
  private enqueue(kind: AlertKind, value: number, threshold: number, period: number): void {
    const observedAt = Date.now();
    const alert: OperationalAlert = {
      id: `${kind}:${Math.floor(observedAt / period)}`,
      kind,
      environment: this.env.ENVIRONMENT === 'production' ? 'production' : 'preview',
      observedAt,
      value,
      threshold,
    };
    this.ctx.storage.transactionSync(() => {
      this.pruneOutbox();
      if (this.ctx.storage.sql.exec('SELECT 1 FROM outbox WHERE id = ?', alert.id).toArray().length)
        return;
      if (
        this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox').one()
          .count >= MAX_PENDING_ALERTS
      )
        throw new HttpError(
          429,
          'RATE_LIMITED',
          'Pending alert queue is full. Retry after delivery.',
          true,
        );
      this.ctx.storage.sql.exec(
        'INSERT INTO outbox VALUES(?,?,?)',
        alert.id,
        JSON.stringify(alert),
        observedAt,
      );
    });
  }
  private pruneOutbox(): void {
    this.ctx.storage.sql.exec('DELETE FROM outbox WHERE created_at < ?', Date.now() - 86400000);
  }
  private async armAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  private async evaluate(): Promise<void> {
    const now = Date.now();
    if (
      accountAnalyticsConfigured(this.env) &&
      (now - this.providerUsage.lastCheckAt >= ACCOUNT_USAGE_REFRESH_MS ||
        (this.providerUsage.value !== null &&
          this.providerUsage.value.dayStart !== Math.floor(now / 86400000) * 86400000))
    ) {
      this.providerUsage.lastCheckAt = now;
      this.providerUsage.value = null;
      try {
        this.providerUsage.value = await accountUsage(this.env);
      } catch {
        /* Unknown is never reported as zero. */
      }
      await this.ctx.storage.put('account-usage', this.providerUsage);
    }
    try {
      const account = this.providerUsage.value;
      if (
        account &&
        now - account.checkedAt < ACCOUNT_USAGE_REFRESH_MS * 2 &&
        account.dayStart === Math.floor(now / 86400000) * 86400000 &&
        account.requestsToday >= 80000
      )
        this.enqueue('account_worker_request_budget', account.requestsToday, 80000, 86400000);
      if (
        account &&
        now - account.checkedAt < ACCOUNT_USAGE_REFRESH_MS * 2 &&
        account.dayStart === Math.floor(now / 86400000) * 86400000 &&
        account.durableRequestsToday >= 80000
      )
        this.enqueue(
          'account_durable_request_budget',
          account.durableRequestsToday,
          80000,
          86400000,
        );
      const metrics = this.snapshot();
      if (metrics.failedJoinsLastFiveMinutes >= 10)
        this.enqueue('failed_joins', metrics.failedJoinsLastFiveMinutes, 10, 300000);
      if (metrics.serverErrorsLastFiveMinutes >= 5)
        this.enqueue('server_errors', metrics.serverErrorsLastFiveMinutes, 5, 300000);
      if (metrics.requestsToday >= 80000)
        this.enqueue('control_request_budget', metrics.requestsToday, 80000, 86400000);
      if (this.env.TURN_PROVIDER === 'metered' && this.env.RELAY_POOLS) {
        let warningUsage: number | undefined;
        try {
          const response = await this.env.RELAY_POOLS.get(
            this.env.RELAY_POOLS.idFromName('deployment'),
          ).fetch('https://relay.internal/status');
          const state = (await response.json()) as {
            usage?: { usageInGB?: number };
            checkedAt?: number;
          };
          const usage = state.usage?.usageInGB;
          if (
            typeof usage === 'number' &&
            usage >= 0.4 &&
            Date.now() - (state.checkedAt ?? 0) < 120000
          )
            warningUsage = usage;
        } catch {
          /* The relay pool itself fails closed on unknown usage. */
        }
        // Provider read failure is unknown; queue admission failure is explicit.
        if (warningUsage !== undefined) this.enqueue('relay_quota', warningUsage, 0.4, 86400000);
      }
    } finally {
      // Even a full queue must keep draining; admission failure must not starve recovery.
      await this.deliver();
    }
  }
  private async deliver(): Promise<void> {
    this.pruneOutbox();
    const origins = allowedOrigins(this.env);
    if (origins.length !== 1 || !origins[0]!.startsWith('https://')) return;
    const rows = this.ctx.storage.sql
      .exec<{
        id: string;
        payload: string;
      }>('SELECT id,payload FROM outbox ORDER BY created_at LIMIT 5')
      .toArray();
    for (const row of rows) {
      try {
        // A real authenticated HTTPS webhook to this deployment's separate
        // journal actor. No mail, third-party notification service or billing.
        const response = await fetch(`${origins[0]}/ops/alerts/receive`, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: {
            Authorization: `Bearer ${this.env.OPS_REVOKE_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: row.payload,
        });
        if (!response.ok) throw new Error('Delivery failed.');
        const receipt = (await readJson(response)) as { delivered?: boolean };
        if (receipt.delivered !== true) throw new Error('Delivery unconfirmed.');
        this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id = ?', row.id);
      } catch {
        /* Keep the event for the next alarm. IDs make lost-response retries idempotent. */
      }
    }
    this.ctx.storage.sql.exec('DELETE FROM outbox WHERE created_at < ?', Date.now() - 86400000);
  }
  override async alarm(): Promise<void> {
    try {
      await this.evaluate();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60000);
    }
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      await operatorAuthorized(request, this.env);
      const path = new URL(request.url).pathname;
      if (path === '/summary' && request.method === 'GET') return Response.json(this.snapshot());
      if (path === '/journal' && request.method === 'GET')
        return Response.json({
          alerts: this.ctx.storage.sql
            .exec<{ payload: string }>(
              'SELECT payload FROM journal ORDER BY created_at DESC LIMIT 20',
            )
            .toArray()
            .map((row) => JSON.parse(row.payload)),
        });
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      if (path === '/record') {
        const body = (await readJson(request)) as { operation: string; status: number };
        if (
          !body ||
          Object.keys(body).length !== 2 ||
          !CONTROL_OPERATIONS.includes(body.operation as (typeof CONTROL_OPERATIONS)[number]) ||
          !Number.isInteger(body.status) ||
          body.status < 100 ||
          body.status > 599
        )
          return new Response(null, { status: 400 });
        const slot = Math.floor(Date.now() / 60000);
        for (const metric of [
          'requests',
          ...(body.operation === 'join' && body.status >= 400 ? ['failed_joins'] : []),
          ...(body.status >= 500 ? ['server_errors'] : []),
        ])
          this.ctx.storage.sql.exec(
            'INSERT INTO buckets VALUES(?,?,1) ON CONFLICT(slot,metric) DO UPDATE SET count=count+1',
            slot,
            metric,
          );
        this.ctx.storage.sql.exec('DELETE FROM buckets WHERE slot < ?', slot - 1440);
        await this.armAlarm();
        return Response.json({ recorded: true });
      }
      if (path === '/deliver') {
        const alert = validatedAlert(await readJson(request));
        if (
          alert.environment !== (this.env.ENVIRONMENT === 'production' ? 'production' : 'preview')
        )
          return new Response(null, { status: 400 });
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO journal VALUES(?,?,?)',
          alert.id,
          JSON.stringify(alert),
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          'DELETE FROM journal WHERE created_at < ?',
          Date.now() - 604800000,
        );
        this.ctx.storage.sql.exec(
          'DELETE FROM journal WHERE id NOT IN(SELECT id FROM journal ORDER BY created_at DESC LIMIT 128)',
        );
        return Response.json({ delivered: true });
      }
      if (path === '/evaluate') {
        await this.armAlarm();
        await this.evaluate();
        return Response.json(this.snapshot());
      }
      if (path === '/test') {
        await this.armAlarm();
        this.enqueue('delivery_test', 1, 1, 1000);
        await this.deliver();
        return Response.json(this.snapshot());
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return errorResponse(error, crypto.randomUUID());
    }
  }
}
