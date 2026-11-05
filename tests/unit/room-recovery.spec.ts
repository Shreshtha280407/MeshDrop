import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionEpoch } from '@meshdrop/protocol';
import type { PeerSessionOptions, PeerView } from '../../packages/peer-connection/src';
import type * as PeerModule from '../../packages/peer-connection/src';
import { INITIAL_PEER } from '../../packages/peer-connection/src';
import { RoomClient } from '../../apps/web/src/features/pairing/RoomClient';

// Exercise the real admission/socket queue and retry controller. WebRTC handshake
// behavior is separately exercised by the real-browser regression.
const state = vi.hoisted(() => ({ peers: [] as FakePeer[] }));
vi.mock('../../packages/peer-connection/src', async (original) => ({
  ...(await original<typeof PeerModule>()),
  PeerSession: function (options: PeerSessionOptions) {
    return new FakePeer(options);
  },
}));
class FakePeer {
  snapshot: PeerView = { ...INITIAL_PEER };
  readonly canTransfer = false;
  readonly starts: number[] = [];
  constructor(private readonly options: PeerSessionOptions) {
    state.peers.push(this);
  }
  get epoch() {
    return this.snapshot.epoch;
  }
  async start(epoch: ConnectionEpoch) {
    this.starts.push(epoch.epoch);
    this.emit({ epoch: epoch.epoch, state: 'connected', ready: true });
  }
  emit(patch: Partial<PeerView>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChange(this.snapshot);
  }
  close() {
    this.emit({ state: 'closed', ready: false });
  }
  fail(error: string) {
    this.emit({ state: 'closed', ready: false, error });
  }
  rejectComparison() {
    this.emit({ state: 'closed', ready: false, verification: 'mismatch' });
  }
}
class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Socket.instances.push(this);
    void Promise.resolve().then(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const roomId = '00000000-0000-4000-8000-000000000001';
const ownerPeerId = '00000000-0000-4000-8000-000000000002';
const receiverPeerId = '00000000-0000-4000-8000-000000000003';
const clients: RoomClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function ice() {
  return Response.json({ iceServers: [], relayAvailable: false, expiresAt: Date.now() + 60000 });
}
async function fixture() {
  let serverEpoch = 2;
  let nextIce: ReturnType<typeof deferred<Response>> | undefined;
  const requests: { expectedEpoch: number; mode: string }[] = [];
  const status = () => ({
    roomId,
    peerId: ownerPeerId,
    role: 'owner',
    approval: 'approved',
    state: 'approved',
    epoch: serverEpoch,
    revision: serverEpoch,
    expiresAt: Date.now() + 60000,
    nextSeq: 0,
  });
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/v1/sessions')
      return Response.json({
        roomId,
        peerId: ownerPeerId,
        ownerCapability: 'a'.repeat(43),
        inviteCapability: 'b'.repeat(43),
        expiresAt: Date.now() + 60000,
        inviteExpiresAt: Date.now() + 30000,
        epoch: 0,
        revision: 0,
      });
    if (path.endsWith('/status')) return Response.json(status());
    if (path.endsWith('/ws-ticket'))
      return Response.json({
        ticket: 'c'.repeat(43),
        expiresAt: Date.now() + 30000,
        epoch: serverEpoch,
        nextSeq: 0,
      });
    if (path.endsWith('/ice-credentials')) return nextIce ? nextIce.promise : ice();
    if (path.endsWith('/connection')) {
      requests.push(JSON.parse(String(init.body)) as (typeof requests)[number]);
      return Response.json({ epoch: ++serverEpoch });
    }
    throw new Error('Unexpected local test endpoint.');
  });
  vi.stubGlobal('fetch', fetch);
  const client = new RoomClient();
  clients.push(client);
  await client.createRoom();
  expect(client.getSnapshot().connection).toBe('connected');
  const socket = Socket.instances.at(-1)!;
  const admit = (epoch: number) => {
    serverEpoch = Math.max(epoch, serverEpoch);
    socket.onmessage?.({
      data: JSON.stringify({
        version: 1,
        type: 'CONNECTION_EPOCH',
        roomId,
        peerId: ownerPeerId,
        epoch,
        seq: epoch,
        messageId: crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        payload: { epoch, mode: 'new-connection', ownerPeerId, receiverPeerId },
      }),
    });
  };
  admit(2);
  await vi.waitFor(() => expect(client.getSnapshot().peer.epoch).toBe(2));
  const peer = state.peers.at(-1)!;
  return {
    client,
    peer,
    requests,
    admit,
    fetch,
    delayIce() {
      nextIce = deferred<Response>();
      return nextIce;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  state.peers.length = 0;
  Socket.instances.length = 0;
  vi.stubGlobal('window', {
    location: { origin: 'http://meshdrop.test', host: 'meshdrop.test', protocol: 'http:' },
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('admitted epoch owns automatic recovery', () => {
  it.each(['closed', 'reconnecting'] as const)(
    'ignores retiring epoch %s during delayed replacement initialization',
    async (state) => {
      const f = await fixture(),
        pending = f.delayIce();
      f.admit(3);
      await vi.waitFor(() => expect(f.client.getSnapshot().status?.epoch).toBe(3));
      f.peer.emit({ state, ready: false });
      await vi.advanceTimersByTimeAsync(1100);
      expect(f.requests).toEqual([]);
      pending.resolve(ice());
      await vi.waitFor(() =>
        expect(f.client.getSnapshot().peer).toMatchObject({ epoch: 3, ready: true }),
      );
      expect(f.peer.starts).toEqual([2, 3]);
      expect(f.requests).toEqual([]);
    },
  );
  it('still recovers a current-epoch interruption exactly once despite duplicate callbacks', async () => {
    const f = await fixture();
    f.peer.emit({ state: 'reconnecting', ready: false });
    f.peer.emit({ state: 'closed', ready: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.requests).toEqual([{ expectedEpoch: 2, mode: 'ice-restart' }]);
  });
  it('still recovers when the newly admitted epoch fails to initialize', async () => {
    const f = await fixture(),
      pending = f.delayIce();
    f.admit(3);
    await vi.waitFor(() => expect(f.client.getSnapshot().status?.epoch).toBe(3));
    f.peer.emit({ state: 'closed', ready: false });
    pending.reject(new Error('Synthetic ICE configuration failure.'));
    await vi.waitFor(() =>
      expect(f.client.getSnapshot().error).toContain('Peer negotiation failed'),
    );
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.requests).toEqual([{ expectedEpoch: 3, mode: 'ice-restart' }]);
  });
  it('initializes duplicate epochs once and rejects out-of-order old epochs', async () => {
    const f = await fixture(),
      pending = f.delayIce();
    f.admit(3);
    f.admit(3);
    f.admit(1);
    pending.resolve(ice());
    await vi.waitFor(() => expect(f.client.getSnapshot().peer.epoch).toBe(3));
    await vi.advanceTimersByTimeAsync(200);
    expect(f.peer.starts).toEqual([2, 3]);
    expect(f.fetch.mock.calls.filter(([path]) => path.endsWith('/ice-credentials'))).toHaveLength(
      2,
    );
    expect(f.requests).toEqual([]);
  });
  it('does not revive initialization or recovery after component disposal', async () => {
    const f = await fixture(),
      pending = f.delayIce();
    f.admit(3);
    await vi.waitFor(() => expect(f.client.getSnapshot().status?.epoch).toBe(3));
    f.client.dispose();
    pending.resolve(ice());
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.peer.starts).toEqual([2]);
    expect(f.requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['success', 'failure'] as const)(
    'ignores late initialization %s from a replaced signaling socket',
    async (outcome) => {
      const f = await fixture(),
        pending = f.delayIce();
      f.admit(3);
      await vi.waitFor(() => expect(f.client.getSnapshot().status?.epoch).toBe(3));
      await f.client.reconnect();
      expect(Socket.instances).toHaveLength(2);
      if (outcome === 'success') pending.resolve(ice());
      else pending.reject(new Error('Retired socket initialization failed.'));
      await vi.advanceTimersByTimeAsync(1100);
      expect(state.peers).toHaveLength(1);
      expect(f.peer.starts).toEqual([2]);
      expect(f.requests).toEqual([]);
      expect(f.client.getSnapshot().error).toBe('');
    },
  );
  it('keeps comparison rejection from scheduling automatic recovery', async () => {
    const f = await fixture();
    f.client.rejectComparison();
    f.peer.emit({ state: 'closed', ready: false });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.requests).toEqual([]);
    expect(f.client.getSnapshot().peer.verification).toBe('mismatch');
  });
});
