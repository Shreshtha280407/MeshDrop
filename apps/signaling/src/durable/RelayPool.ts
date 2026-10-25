import { DurableObject } from 'cloudflare:workers';
import type { IceConfiguration } from '@meshdrop/protocol';
import type { Env } from '../env';
import { readJson } from '../limits';
import { errorResponse } from '../errors';
import { turnProvider } from '../turn-config';
import {
  createMeteredKey,
  meteredIce,
  meteredUsage,
  readyMeteredKey,
  METERED_ROTATION_MS,
} from '../routes/metered-turn';
import type { MeteredKey, MeteredUsage } from '../routes/metered-turn';

interface PoolState {
  keys: MeteredKey[];
  checkedAt: number;
  allowed: boolean;
  usage: MeteredUsage | null;
}
/** One SQLite-backed pool per deployment. No user, room, file or IP data. */
export class RelayPool extends DurableObject<Env> {
  private state: PoolState = { keys: [], checkedAt: 0, allowed: false, usage: null };
  private rotation: Promise<void> | undefined;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<PoolState>('pool')) ?? this.state;
    });
  }
  private maintain(): Promise<void> {
    this.rotation ??= this.rotate().finally(() => {
      this.rotation = undefined;
    });
    return this.rotation;
  }
  private async rotate(): Promise<void> {
    const now = Date.now();
    if (turnProvider(this.env) !== 'metered') return;
    this.state.keys = this.state.keys.filter((key) => key.expiresAt > now).slice(-2);
    try {
      this.state.usage = await meteredUsage(this.env);
      // Reserve 10% for in-flight allocations. The provider's verified free
      // plan hard stop is the spending boundary, not this lagging counter.
      this.state.allowed = this.state.usage.usageInGB < 0.45;
      const latest = this.state.keys.at(-1);
      if (this.state.allowed && (!latest || now - latest.createdAt >= METERED_ROTATION_MS)) {
        try {
          this.state.keys.push(await createMeteredKey(this.env));
        } catch {
          /* Keep an older usable key; never retry a free credential cap in a loop. */
        }
      }
    } catch {
      this.state.allowed = false;
      this.state.usage = null;
    }
    this.state.checkedAt = Date.now();
    await this.ctx.storage.put('pool', this.state);
    await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  override async alarm(): Promise<void> {
    await this.maintain();
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/warm' && request.method === 'POST') {
        if (Date.now() - this.state.checkedAt >= 60000) await this.maintain();
        return Response.json(this.snapshot());
      }
      if (path === '/status' && request.method === 'GET') return Response.json(this.snapshot());
      if (path !== '/credentials' || request.method !== 'POST')
        return new Response(null, { status: 404 });
      const body = (await readJson(request)) as { roomExpiresAt?: number };
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        !Number.isSafeInteger(body.roomExpiresAt) ||
        body.roomExpiresAt! <= Date.now() ||
        body.roomExpiresAt! > Date.now() + 3600000
      )
        return new Response(null, { status: 400 });
      if (Date.now() - this.state.checkedAt >= 60000) await this.maintain();
      const key = this.state.allowed
        ? readyMeteredKey(this.state.keys, body.roomExpiresAt!)
        : undefined;
      const fallback: IceConfiguration = {
        iceServers: [],
        relayAvailable: false,
        expiresAt: Math.min(body.roomExpiresAt!, Date.now() + 60000),
      };
      if (!key) return Response.json(fallback);
      try {
        return Response.json(await meteredIce(this.env, key));
      } catch {
        return Response.json(fallback);
      }
    } catch (error) {
      return errorResponse(error, crypto.randomUUID());
    }
  }
  private snapshot() {
    const now = Date.now();
    const key = this.state.allowed
      ? readyMeteredKey(this.state.keys, now + 3600000, now)
      : undefined;
    return {
      provider: turnProvider(this.env),
      ready: Boolean(key),
      freeOnly: true,
      checkedAt: this.state.checkedAt,
      usage: this.state.usage,
      expiresAt: key?.expiresAt ?? null,
      nextReadyAt: this.state.keys.find((key) => key.readyAt > now)?.readyAt ?? null,
    };
  }
}
