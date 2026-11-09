import { expect, it, vi } from 'vitest';
import { PeerSession, INITIAL_PEER } from '../../packages/peer-connection/src/PeerSession';
import { createIdentity, verify } from '../../packages/peer-connection/src/PairingVerification';
import { fileControlSchema } from '@meshdrop/protocol';
import { deferred, until } from '../helpers/streaming-transfer';

it.each(['before-queue', 'during-signature'] as const)(
  'cancelled transfer control cannot escape %s, while a signed cancel remains allowed',
  async (phase) => {
    const identity = await createIdentity();
    const sent: string[] = [];
    const session = new PeerSession({
      roomId: '11111111-1111-4111-8111-111111111111',
      peerId: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
      sendSignal() {},
      onChange() {},
    });
    // A local, already-paired fixture. Actual ECDSA signing/verification runs below.
    Object.assign(session, {
      identity,
      channel: {
        readyState: 'open',
        bufferedAmount: 0,
        send: (wire: string) => sent.push(wire),
        close() {},
      },
      view: {
        ...INITIAL_PEER,
        epoch: 1,
        state: 'connected',
        ready: true,
        verification: 'verified',
        remoteVerified: true,
        fingerprint: 'f'.repeat(64),
        capabilities: { maxMessageBytes: 65536 },
      },
    });
    const gate = deferred();
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let signing = false;
    const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      signing = true;
      await gate.promise;
      return sign(...args);
    });
    const controller = new AbortController();
    const input = {
      type: 'RECEIPT_ACK' as const,
      transferId: '33333333-3333-4333-8333-333333333333',
      payload: {
        receiptId: '44444444-4444-4444-8444-444444444444',
        manifestDigest: 'a'.repeat(64),
      },
    };
    try {
      if (phase === 'before-queue') controller.abort();
      const sending = session.sendFileControl(input, controller.signal);
      const rejected = expect(sending).rejects.toThrow();
      if (phase === 'during-signature') {
        await until(() => signing);
        controller.abort();
      }
      gate.release();
      await rejected;
      expect(sent).toHaveLength(0);
      if (phase === 'before-queue') expect(spy).not.toHaveBeenCalled();
      await session.sendFileControl({
        type: 'TRANSFER_CANCEL',
        transferId: input.transferId,
        payload: { reason: 'user' },
      });
      expect(sent).toHaveLength(1);
      const message = JSON.parse(sent[0]!);
      expect(fileControlSchema.parse(message.control).type).toBe('TRANSFER_CANCEL');
      expect(await verify(message.control, message.signature, identity.publicKey)).toBe(true);
    } finally {
      gate.release();
      spy.mockRestore();
      session.close();
    }
  },
);
