import { expect, it } from 'vitest';
import { PeerSession } from '../../packages/peer-connection/src/PeerSession';

it('rejects control floods before retaining a 65th task and releases capacity after failure', async () => {
  const session = new PeerSession({
    roomId: crypto.randomUUID(),
    peerId: crypto.randomUUID(),
    role: 'owner',
    sendSignal() {},
    onChange() {},
  });
  // Queue all calls within one turn, before the first asynchronous sign/send can finish.
  const outcomes = Array.from({ length: 80 }, () =>
    session.ping().catch((error: Error) => error.message),
  );
  const messages = await Promise.all(outcomes);
  expect(messages.filter((message) => message === 'Peer control queue is full.')).toHaveLength(16);
  expect(messages.filter((message) => message === 'Peer handshake is not ready.')).toHaveLength(64);
  await expect(session.ping()).rejects.toThrow('Peer handshake is not ready.');
});
