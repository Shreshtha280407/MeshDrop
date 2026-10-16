import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes, randomUUID } from 'node:crypto';
import NetworkWebSocket from 'ws';
import {
  parseSignalingMessage,
  sessionCreatedSchema,
  sessionStatusSchema,
  socketTicketSchema,
} from '@meshdrop/protocol';
import type { SessionCreated, SignalingEnvelope } from '@meshdrop/protocol';

export const ORIGIN = 'http://127.0.0.1:5173';
export const API = 'https://api.meshdrop.test';
export const capability = () => randomBytes(32).toString('base64url');
let bundle: string | undefined;
export async function runtime(
  options: {
    bindings?: Record<string, string>;
    createLimit?: number;
    requestLimit?: number;
    persist?: string;
  } = {},
): Promise<Miniflare> {
  if (!bundle) {
    const result = await build({
      entryPoints: ['apps/signaling/src/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      external: ['cloudflare:workers'],
    });
    bundle = result.outputFiles?.[0]?.text;
  }
  if (!bundle) throw new Error('Missing Worker bundle.');
  return new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      unsafeInspectDurableObjects: true,
      ...(options.persist ? { resourcePersistencePath: options.persist } : {}),
      name: 'meshdrop-p1-test',
      modules: true,
      script: bundle,
      compatibilityDate: '2026-07-01',
      bindings: {
        ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
        ROOM_TTL_SECONDS: '900',
        INVITE_TTL_SECONDS: '300',
        WS_TICKET_TTL_SECONDS: '30',
        CLOSED_TOMBSTONE_SECONDS: '60',
        ...options.bindings,
      },
      durableObjects: { SESSION_ROOMS: { className: 'SessionRoom', useSQLite: true } },
      ratelimits: {
        CREATE_LIMITER: {
          namespace_id: '1001',
          simple: { limit: options.createLimit ?? 500, period: 60 },
        },
        REQUEST_LIMITER: {
          namespace_id: '1002',
          simple: { limit: options.requestLimit ?? 3000, period: 60 },
        },
      },
    }),
  );
}
export function request(
  mf: Miniflare,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = {
    Origin: options.origin ?? ORIGIN,
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };
  return mf.dispatchFetch(`${API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
export async function create(mf: Miniflare): Promise<SessionCreated> {
  const response = await request(mf, '/v1/sessions', { method: 'POST', body: {} });
  if (response.status !== 201)
    throw new Error(`Creation failed: ${response.status} ${JSON.stringify(await response.json())}`);
  return sessionCreatedSchema.parse(await response.json());
}
export function candidate() {
  return { peerId: randomUUID(), peerCapability: capability() };
}
export async function join(mf: Miniflare, room: SessionCreated, guest = candidate()) {
  const response = await request(mf, `/v1/sessions/${room.roomId}/join`, {
    method: 'POST',
    token: room.inviteCapability,
    body: guest,
  });
  if (!response.ok) throw new Error(`Join failed: ${response.status}`);
  return { guest, status: sessionStatusSchema.parse(await response.json()) };
}
export async function approve(mf: Miniflare, room: SessionCreated, peerId: string) {
  return request(mf, `/v1/sessions/${room.roomId}/decisions`, {
    method: 'POST',
    token: room.ownerCapability,
    body: { candidatePeerId: peerId, decision: 'approve' },
  });
}
export async function ticket(mf: Miniflare, roomId: string, token: string) {
  const response = await request(mf, `/v1/sessions/${roomId}/ws-ticket`, {
    method: 'POST',
    token,
    body: {},
  });
  if (!response.ok)
    throw new Error(`Ticket failed: ${response.status} ${JSON.stringify(await response.json())}`);
  return socketTicketSchema.parse(await response.json());
}
export async function upgrade(mf: Miniflare, roomId: string, value: string, origin = ORIGIN) {
  return request(mf, `/v1/sessions/${roomId}/ws`, {
    origin,
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${value}`,
    },
  });
}
export type TestSocket = NonNullable<Awaited<ReturnType<typeof upgrade>>['webSocket']>;
export class Inbox {
  readonly events: SignalingEnvelope[] = [];
  closed = false;
  constructor(readonly socket: TestSocket | NetworkWebSocket) {
    const receive = (data: unknown) => {
      if (typeof data === 'string' && data !== 'pong')
        this.events.push(parseSignalingMessage(data));
    };
    if (socket instanceof NetworkWebSocket) {
      socket.on('message', (data, binary) => {
        if (!binary) receive(data.toString());
      });
      socket.on('close', () => {
        this.closed = true;
      });
    } else {
      socket.addEventListener('message', (event) => receive(event.data));
      socket.addEventListener('close', () => {
        this.closed = true;
      });
      socket.accept();
    }
  }
  async next(type: SignalingEnvelope['type']): Promise<SignalingEnvelope> {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const index = this.events.findIndex((event) => event.type === type);
      if (index !== -1) return this.events.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} event received.`);
  }
  close() {
    if (!this.closed) {
      try {
        this.socket.close(1000);
      } catch {
        /* Already closed. */
      }
    }
  }
}
export async function connect(mf: Miniflare, roomId: string, token: string) {
  const issued = await ticket(mf, roomId, token);
  // Real TCP/WebSocket close semantics. Miniflare's fetch-returned socket adapter
  // can lose close notifications initiated by a separate request or alarm.
  const url = new URL(`/v1/sessions/${roomId}/ws`, await mf.ready);
  url.protocol = 'ws:';
  // The client waits only after an actual Close frame or close initiation.
  // Keep that TCP handshake grace period bounded for local tests.
  const socketOptions = { origin: ORIGIN, closeTimeout: 250 };
  const socket = new NetworkWebSocket(
    url,
    ['meshdrop.v1', `meshdrop.ticket.${issued.ticket}`],
    socketOptions,
  );
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await inbox.next('JOINED');
  return inbox;
}
export function signal(
  room: SessionCreated,
  peerId: string,
  seq = 0,
  extra: Partial<SignalingEnvelope> = {},
): string {
  return JSON.stringify({
    version: 1,
    type: 'SDP_OFFER',
    roomId: room.roomId,
    peerId,
    messageId: randomUUID(),
    epoch: 0,
    seq,
    sentAt: new Date().toISOString(),
    payload: { sdp: 'synthetic-p1-signaling-probe' },
    ...extra,
  });
}
export async function storage(mf: Miniflare, roomId: string) {
  return mf.unsafeGetDurableObjectStorage('meshdrop-p1-test', 'SessionRoom', { name: roomId });
}
