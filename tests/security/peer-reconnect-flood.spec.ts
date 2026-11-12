import { expect, it, vi } from 'vitest';
import { PeerSession } from '../../packages/peer-connection/src/PeerSession';
import type { PeerView } from '../../packages/peer-connection/src/PeerSession';
import { until } from '../helpers/streaming-transfer';

function channel() {
  const target = Object.assign(new EventTarget(), {
    label: 'meshdrop.v1',
    protocol: 'meshdrop.v1',
    ordered: true,
    maxRetransmits: null,
    maxPacketLifeTime: null,
    readyState: 'open',
    bufferedAmount: 512 * 1024,
    onmessage: null,
  });
  return Object.assign(target, {
    close: vi.fn(() => {
      target.readyState = 'closed';
      target.dispatchEvent(new Event('close'));
    }),
  }) as unknown as RTCDataChannel;
}
it.each(['binary', 'text'] as const)(
  'retired-channel %s callbacks cannot exhaust or close the replacement epoch during a reconnect flood',
  async (kind) => {
    const session = new PeerSession({
      roomId: crypto.randomUUID(),
      peerId: crypto.randomUUID(),
      role: 'owner',
      sendSignal() {},
      onChange() {},
    });
    // A controlled channel seam tests callback ownership, not handshake authentication.
    const harness = session as unknown as {
      attachChannel(c: RTCDataChannel): void;
      view: PeerView;
    };
    const old = channel();
    harness.attachChannel(old);
    const deliveredLate = old.onmessage!;
    session.close();
    harness.view = { ...session.snapshot, state: 'connected', epoch: 2, ready: true };
    const current = channel();
    harness.attachChannel(current);
    for (let i = 0; i < 10; i++)
      deliveredLate.call(old, {
        data: kind === 'binary' ? new ArrayBuffer(512 * 1024) : 'x'.repeat(512 * 1024),
      } as MessageEvent);
    await Promise.resolve();
    expect(session.snapshot.state).toBe('connected');
    expect(current.close).not.toHaveBeenCalled();
    expect(session.snapshot.peakReceiveQueueBytes).toBe(0);
    session.close();
  },
);

it('bounds active receive floods and settles their retained queue after closure', async () => {
  const session = new PeerSession({
    roomId: crypto.randomUUID(),
    peerId: crypto.randomUUID(),
    role: 'owner',
    sendSignal() {},
    onChange() {},
  });
  const scope = session as unknown as {
    attachChannel(c: RTCDataChannel): void;
    view: PeerView;
    queuedReceiveMessages: number;
    queuedReceiveBytes: number;
  };
  scope.view = { ...session.snapshot, state: 'connected', ready: true };
  const active = channel();
  scope.attachChannel(active);
  for (let i = 0; i < 100; i++)
    active.onmessage!.call(active, { data: new ArrayBuffer(64 * 1024) } as MessageEvent);
  expect(session.snapshot.state).toBe('closed');
  expect(session.snapshot.peakReceiveQueueBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  await until(() => scope.queuedReceiveMessages === 0);
  expect(scope.queuedReceiveBytes).toBe(0);
});

it('closes 25 pending drain waits with no retained timers or listeners', async () => {
  vi.useFakeTimers();
  const waits: Promise<void>[] = [],
    peers: PeerSession[] = [];
  const listeners: { add: ReturnType<typeof vi.spyOn>; remove: ReturnType<typeof vi.spyOn> }[] = [];
  try {
    for (let i = 0; i < 25; i++) {
      const session = new PeerSession({
        roomId: crypto.randomUUID(),
        peerId: crypto.randomUUID(),
        role: 'owner',
        sendSignal() {},
        onChange() {},
      });
      const scope = session as unknown as {
        attachChannel(c: RTCDataChannel): void;
        view: PeerView;
      };
      scope.view = {
        ...session.snapshot,
        state: 'connected',
        ready: true,
        verification: 'verified',
        remoteVerified: true,
      };
      const active = channel();
      scope.attachChannel(active);
      peers.push(session);
      listeners.push({
        add: vi.spyOn(active, 'addEventListener'),
        remove: vi.spyOn(active, 'removeEventListener'),
      });
      waits.push(session.waitForDrain(new AbortController().signal));
    }
    expect(vi.getTimerCount()).toBe(25);
    const done = Promise.allSettled(waits);
    peers.forEach((p) => p.close());
    expect((await done).every((r) => r.status === 'rejected')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (const item of listeners) {
      expect(item.add).toHaveBeenCalledTimes(2);
      expect(item.remove).toHaveBeenCalledTimes(2);
    }
  } finally {
    peers.forEach((p) => p.close());
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it('keeps the 64-control queue independent across 25 simultaneous peers and releases all rejected work', async () => {
  const peers = Array.from(
    { length: 25 },
    () =>
      new PeerSession({
        roomId: crypto.randomUUID(),
        peerId: crypto.randomUUID(),
        role: 'owner',
        sendSignal() {},
        onChange() {},
      }),
  );
  try {
    const results = await Promise.all(
      peers.map((peer) =>
        Promise.all(
          Array.from({ length: 80 }, () =>
            peer.ping().then(
              () => '',
              (error: Error) => error.message,
            ),
          ),
        ),
      ),
    );
    for (const messages of results) {
      expect(messages.filter((m) => m === 'Peer control queue is full.')).toHaveLength(16);
      expect(messages.filter((m) => m === 'Peer handshake is not ready.')).toHaveLength(64);
    }
    for (const peer of peers)
      await expect(peer.ping()).rejects.toThrow('Peer handshake is not ready.');
  } finally {
    peers.forEach((peer) => peer.close());
  }
});
