import { expect, it } from 'vitest';
import type { FileControl, PeerHello } from '@meshdrop/protocol';
import { INITIAL_PEER, PeerSession } from '../../packages/peer-connection/src/PeerSession';
import type { PeerView } from '../../packages/peer-connection/src/PeerSession';
import {
  authenticateHello,
  createIdentity,
  pairingTranscript,
  sign,
  verify,
} from '../../packages/peer-connection/src/PairingVerification';
import { seeded } from '../helpers/control-load';

const keys = await Promise.all([createIdentity(), createIdentity(), createIdentity()]);
async function fixture(epoch = 9) {
  const roomId = crypto.randomUUID(),
    localId = crypto.randomUUID(),
    remoteId = crypto.randomUUID();
  const capabilities = {
    protocolVersion: 1 as const,
    preferredFrameBytes: 16384,
    maxMessageBytes: 16384,
    supportedHashes: ['SHA-256'] as ['SHA-256'],
    storageModes: ['opfs'] as ['opfs'],
    resumeMode: 'persistent' as const,
  };
  const local: PeerHello = {
    version: 1,
    type: 'HELLO',
    roomId,
    peerId: localId,
    epoch,
    role: 'owner',
    nonce: 'a'.repeat(43),
    publicKey: keys[0]!.publicKey,
    dtlsFingerprint: 'a'.repeat(64),
    capabilities,
  };
  const remote: PeerHello = {
    ...local,
    role: 'receiver',
    peerId: remoteId,
    nonce: 'b'.repeat(43),
    publicKey: keys[1]!.publicKey,
    dtlsFingerprint: 'b'.repeat(64),
  };
  const authenticated = await authenticateHello(
    { hello: remote, signature: await sign(remote, keys[1]!.privateKey) },
    { roomId, epoch, peerId: remoteId, role: 'receiver', fingerprint: remote.dtlsFingerprint },
  );
  const transcript = await pairingTranscript(local, authenticated);
  const delivered: FileControl[] = [];
  const session = new PeerSession({
    roomId,
    peerId: localId,
    role: 'owner',
    sendSignal() {},
    onChange() {},
    onFileControl: async (c) => {
      delivered.push(c);
    },
  });
  // Controlled post-handshake transport seam, with real keys, signed hellos,
  // transcript derivation and the actual incoming signature/context validator.
  // Actual browser DTLS/pairing is covered by the retained browser suite.
  const scope = session as unknown as {
    view: PeerView;
    identity: (typeof keys)[number];
    localHello: PeerHello;
    remoteHello: PeerHello;
    remotePeerId: string;
    remoteSequence: number;
    channel: RTCDataChannel;
    receiveData(raw: unknown, generation: number): Promise<void>;
  };
  Object.assign(scope, {
    identity: keys[0],
    localHello: local,
    remoteHello: authenticated,
    remotePeerId: remoteId,
    channel: { readyState: 'open', bufferedAmount: 0, send() {}, close() {} },
  });
  scope.view = {
    ...INITIAL_PEER,
    state: 'connected',
    epoch,
    ready: true,
    remoteVerified: true,
    verification: 'verified',
    fingerprint: transcript.fingerprint,
    code: transcript.code,
  };
  const control: Extract<FileControl, { type: 'FLOW_STATE' }> = {
    version: 1,
    type: 'FLOW_STATE',
    roomId,
    peerId: remoteId,
    epoch,
    transcript: transcript.fingerprint,
    messageId: crypto.randomUUID(),
    seq: 0,
    transferId: crypto.randomUUID(),
    payload: { paused: false },
  };
  return { session, scope, delivered, control };
}
const mutations = [
  'room',
  'peer',
  'old-epoch',
  'future-epoch',
  'transcript',
  'sequence',
  'overflow',
  'payload',
  'signature',
  'another-key',
  'local-unpaired',
  'remote-unpaired',
] as const;
for (const seed of [7, 17, 97, 2027])
  it(`seed ${seed}: 500 real-signature adversarial schedules preserve context, pairing and replay invariants`, async () => {
    const random = seeded(seed),
      seen = new Set<string>();
    const plans = Array.from(
      { length: 500 },
      () => mutations[(random() >>> 16) % mutations.length]!,
    );
    for (const mutation of plans) {
      seen.add(mutation);
      const f = await fixture();
      try {
        const initial = {
          control: f.control,
          signature: await sign(f.control, keys[1]!.privateKey),
        };
        await f.scope.receiveData(JSON.stringify(initial), 0);
        expect(f.delivered).toHaveLength(1);
        const control = structuredClone(f.control);
        control.seq = 1;
        control.messageId = crypto.randomUUID();
        if (mutation === 'room') control.roomId = crypto.randomUUID();
        if (mutation === 'peer') control.peerId = crypto.randomUUID();
        if (mutation === 'old-epoch') control.epoch--;
        if (mutation === 'future-epoch') control.epoch++;
        if (mutation === 'transcript') control.transcript = '0'.repeat(64);
        if (mutation === 'sequence') control.seq = 0;
        if (mutation === 'overflow') control.seq = 0x100000000;
        if (mutation === 'local-unpaired')
          f.scope.view = { ...f.scope.view, verification: 'unverified' };
        if (mutation === 'remote-unpaired')
          f.scope.view = { ...f.scope.view, remoteVerified: false };
        let signature = await sign(control, keys[mutation === 'another-key' ? 2 : 1]!.privateKey);
        if (mutation === 'payload') control.payload.paused = true;
        if (mutation === 'signature')
          signature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
        let rejected = false;
        try {
          await f.scope.receiveData(JSON.stringify({ control, signature }), 0);
        } catch {
          rejected = true;
        }
        expect(rejected || mutation === 'old-epoch').toBe(true);
        expect(f.delivered).toHaveLength(1);
        expect(f.scope.remoteSequence).toBe(0);
      } finally {
        f.session.close();
      }
    }
    expect(seen.size).toBe(mutations.length);
  });

it('one-sided signed pairing confirmation never authorizes file data', async () => {
  const f = await fixture();
  try {
    f.scope.view = { ...f.scope.view, verification: 'unverified', remoteVerified: false };
    const ping = {
      version: 1,
      type: 'PAIRING_CONFIRMED',
      roomId: f.control.roomId,
      peerId: f.control.peerId,
      epoch: f.control.epoch,
      transcript: f.control.transcript,
      messageId: crypto.randomUUID(),
      seq: 0,
    };
    await f.scope.receiveData(
      JSON.stringify({ ping, signature: await sign(ping, keys[1]!.privateKey) }),
      0,
    );
    expect(f.session.snapshot.remoteVerified).toBe(true);
    expect(f.session.canTransfer).toBe(false);
    f.session.confirmComparison(f.session.snapshot.code, false);
    expect(f.session.canTransfer).toBe(false);
    f.session.confirmComparison(f.session.snapshot.code, true);
    expect(f.session.canTransfer).toBe(true);
  } finally {
    f.session.close();
  }
});
it('rejects substitution of every signed receipt field and signing context', async () => {
  const f = await fixture();
  try {
    const receipt = {
      receiptId: crypto.randomUUID(),
      transferId: f.control.transferId,
      manifestDigest: 'a'.repeat(64),
      epoch: f.control.epoch,
      totalBytes: 3,
      files: [{ fileId: crypto.randomUUID(), path: 'safe.bin', size: 3, sha256: 'b'.repeat(64) }],
      destination: 'browser-temporary',
      completedAt: '2026-11-12T00:00:00.000Z',
    };
    const control = { ...f.control, type: 'TRANSFER_RECEIPT', payload: receipt };
    const signature = await sign(control, keys[1]!.privateKey);
    expect(await verify(control, signature, keys[1]!.publicKey)).toBe(true);
    for (const field of Object.keys(receipt)) {
      const altered = structuredClone(control);
      (altered.payload as Record<string, unknown>)[field] =
        field === 'files'
          ? [{ ...receipt.files[0], path: 'changed.bin' }]
          : field === 'epoch' || field === 'totalBytes'
            ? 999
            : crypto.randomUUID();
      expect(await verify(altered, signature, keys[1]!.publicKey)).toBe(false);
    }
    for (const field of [
      'roomId',
      'peerId',
      'epoch',
      'transcript',
      'transferId',
      'seq',
      'messageId',
    ]) {
      const altered = {
        ...control,
        [field]: field === 'epoch' || field === 'seq' ? 77 : crypto.randomUUID(),
      };
      expect(await verify(altered, signature, keys[1]!.publicKey)).toBe(false);
    }
    expect(await verify(control, signature, keys[2]!.publicKey)).toBe(false);
  } finally {
    f.session.close();
  }
});
