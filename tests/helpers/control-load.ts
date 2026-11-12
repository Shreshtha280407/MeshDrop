import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import NetworkWebSocket from 'ws';
import { sessionCreatedSchema, socketTicketSchema } from '@meshdrop/protocol';
import type { SessionCreated } from '@meshdrop/protocol';
import type { Miniflare } from 'miniflare';
import { Inbox, ORIGIN, candidate, request, runtime, signal } from '../integration/harness';

export const ROOM_COUNTS = [1, 10, 25, 50, 100] as const;
/** Bounded test-driver work, independent of how many rooms/sockets remain live. */
export async function parallel<T, R>(
  items: readonly T[],
  work: (value: T, index: number) => Promise<R>,
  slots = 8,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(slots, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index]!, index);
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}
export async function loadEvidence(
  label: string,
  metrics: Record<string, number | string | boolean>,
) {
  await mkdir('.meshdrop-artifacts/task14-load', { recursive: true });
  await appendFile(
    '.meshdrop-artifacts/task14-load/metrics.jsonl',
    JSON.stringify({ recordedAt: new Date().toISOString(), label, ...metrics }) + '\n',
    { mode: 0o600 },
  );
}
export type LoadRoom = {
  room: SessionCreated;
  guest: ReturnType<typeof candidate>;
  ip: string;
  epoch: number;
  seq: { owner: number; receiver: number };
  owner?: Inbox;
  receiver?: Inbox;
};
/** Real local workerd/SQLite and TCP WebSockets. No hosted or P2P capacity claim. */
export class ControlLoad {
  readonly rooms: LoadRoom[] = [];
  readonly sockets: Inbox[] = [];
  readonly latencies: number[] = [];
  requests = 0;
  messagesSent = 0;
  messagesReceived = 0;
  peakOpenSockets = 0;
  closedSockets = 0;
  forcedCleanup = 0;
  private serial = 0;
  private constructor(readonly worker: Miniflare) {}
  static async start(bindings: Record<string, string> = {}, script?: string) {
    // Match the repository's declared local rate settings, never raise them for load.
    return new ControlLoad(
      await runtime({
        createLimit: 30,
        requestLimit: 300,
        bindings,
        ...(script ? { script } : {}),
        outboundService: async () => new Response(null, { status: 503 }),
      }),
    );
  }
  async fetch(room: LoadRoom | null, suffix: string, options: Parameters<typeof request>[2] = {}) {
    const began = performance.now();
    try {
      this.requests++;
      return await request(
        this.worker,
        room ? `/v1/sessions/${room.room.roomId}${suffix}` : suffix,
        {
          ...options,
          headers: { 'CF-Connecting-IP': room?.ip ?? '2001:db8:14::ffff', ...options.headers },
        },
      );
    } finally {
      this.latencies.push(performance.now() - began);
    }
  }
  async create(): Promise<LoadRoom> {
    const ip = `2001:db8:14::${(++this.serial).toString(16)}`;
    const response = await this.fetch(null, '/v1/sessions', {
      method: 'POST',
      body: {},
      headers: { 'CF-Connecting-IP': ip },
    });
    assert.equal(response.status, 201, 'Isolated room creation rejected.');
    const item: LoadRoom = {
      room: sessionCreatedSchema.parse(await response.json()),
      guest: candidate(),
      ip,
      epoch: 0,
      seq: { owner: 0, receiver: 0 },
    };
    this.rooms.push(item);
    return item;
  }
  async admit(item: LoadRoom) {
    const joined = await this.fetch(item, '/join', {
      method: 'POST',
      token: item.room.inviteCapability,
      body: item.guest,
    });
    assert.equal(joined.status, 201, 'Synthetic peer admission rejected.');
    const approved = await this.fetch(item, '/decisions', {
      method: 'POST',
      token: item.room.ownerCapability,
      body: { candidatePeerId: item.guest.peerId, decision: 'approve' },
    });
    assert.equal(approved.status, 200, 'Owner approval rejected.');
  }
  async open(item: LoadRoom, role: 'owner' | 'receiver'): Promise<Inbox> {
    const issued = await this.fetch(item, '/ws-ticket', {
      method: 'POST',
      token: role === 'owner' ? item.room.ownerCapability : item.guest.peerCapability,
      body: {},
    });
    assert.equal(issued.status, 200, 'Socket ticket rejected.');
    const ticket = socketTicketSchema.parse(await issued.json());
    const url = new URL(`/v1/sessions/${item.room.roomId}/ws`, await this.worker.ready);
    url.protocol = 'ws:';
    const socketOptions = {
      origin: ORIGIN,
      headers: { 'CF-Connecting-IP': item.ip },
      closeTimeout: 250,
    };
    const ws = new NetworkWebSocket(
      url,
      ['meshdrop.v1', `meshdrop.ticket.${ticket.ticket}`],
      socketOptions,
    );
    const inbox = new Inbox(ws);
    this.sockets.push(inbox);
    ws.on('close', () => this.closedSockets++);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', () => reject(new Error('Local socket admission failed.')));
    });
    await inbox.next('JOINED');
    item[role] = inbox;
    this.peakOpenSockets = Math.max(
      this.peakOpenSockets,
      this.sockets.filter((s) => !s.closed).length,
    );
    return inbox;
  }
  async connect(item: LoadRoom) {
    await this.open(item, 'owner');
    await this.open(item, 'receiver');
  }
  async advance(item: LoadRoom) {
    const response = await this.fetch(item, '/connection', {
      method: 'POST',
      token: item.room.ownerCapability,
      body: { expectedEpoch: item.epoch, mode: 'new-connection' },
    });
    assert.equal(response.status, 200, 'Admitted epoch transition rejected.');
    item.epoch = ((await response.json()) as { epoch: number }).epoch;
  }
  async exchange(item: LoadRoom) {
    assert(item.owner && item.receiver, 'Both synthetic sockets are required.');
    const offer = signal(item.room, item.room.peerId, item.seq.owner++, { epoch: item.epoch });
    item.owner.socket.send(offer);
    this.messagesSent++;
    const received = await item.receiver.next('SDP_OFFER');
    assert.equal(received.roomId, item.room.roomId, 'Cross-room offer leakage.');
    assert.equal(received.peerId, item.room.peerId, 'Offer membership mismatch.');
    this.messagesReceived++;
    item.receiver.socket.send(
      signal(item.room, item.guest.peerId, item.seq.receiver++, {
        epoch: item.epoch,
        type: 'SDP_ANSWER',
        payload: { sdp: 'synthetic-load-answer' },
      }),
    );
    this.messagesSent++;
    const answer = await item.owner.next('SDP_ANSWER');
    assert.equal(answer.roomId, item.room.roomId, 'Cross-room answer leakage.');
    assert.equal(answer.peerId, item.guest.peerId, 'Answer membership mismatch.');
    this.messagesReceived++;
  }
  async settleClosed(sockets: Inbox[]) {
    const end = performance.now() + 5000;
    while (sockets.some((s) => !s.closed) && performance.now() < end) await delay(5);
    assert(
      sockets.every((s) => s.closed),
      'Local sockets did not complete close.',
    );
  }
  metrics() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      scope: 'local-workerd-sqlite-tcp-websockets',
      rooms: this.rooms.length,
      requests: this.requests,
      socketsOpened: this.sockets.length,
      socketsClosed: this.closedSockets,
      peakOpenSockets: this.peakOpenSockets,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      requestLatencyP50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
      requestLatencyP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      forcedCleanup: this.forcedCleanup,
    };
  }
  async close() {
    for (const s of this.sockets) s.close();
    try {
      await this.settleClosed(this.sockets);
    } catch {
      for (const s of this.sockets)
        if (!s.closed) {
          this.forcedCleanup++;
          (s.socket as NetworkWebSocket).terminate();
        }
    }
    await this.worker.dispose();
  }
}
