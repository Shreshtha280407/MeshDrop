import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { peerCapabilitiesSchema, peerHelloSchema } from '@meshdrop/protocol';
import type { PeerHello } from '@meshdrop/protocol';
import {
  authenticateHello,
  comparisonMatches,
  createIdentity,
  dtlsFingerprint,
  pairingTranscript,
  sign,
  verify,
} from '../../packages/peer-connection/src/PairingVerification';
import {
  IceManager,
  negotiateCapabilities,
  selectedIcePath,
} from '../../packages/peer-connection/src/IceManager';

const capabilities = peerCapabilitiesSchema.parse({
  protocolVersion: 1,
  preferredFrameBytes: 16384,
  maxMessageBytes: 65536,
  supportedHashes: ['SHA-256'],
  storageModes: ['memory'],
  resumeMode: 'unavailable',
});
const roomId = randomUUID();
async function hello(role: 'owner' | 'receiver') {
  const identity = await createIdentity();
  const message: PeerHello = {
    version: 1,
    type: 'HELLO',
    roomId,
    peerId: randomUUID(),
    epoch: 1,
    role,
    nonce: 'a'.repeat(43),
    publicKey: identity.publicKey,
    dtlsFingerprint: 'f'.repeat(64),
    capabilities,
  };
  return { identity, message, signature: await sign(message, identity.privateKey) };
}
describe('ephemeral peer identity and independent comparison', () => {
  it('creates non-extractable signing keys and authenticates a DTLS-bound hello', async () => {
    const peer = await hello('owner');
    expect(peer.identity.privateKey.extractable).toBe(false);
    expect(
      await authenticateHello(
        { hello: peer.message, signature: peer.signature },
        {
          ...peer.message,
          fingerprint: peer.message.dtlsFingerprint,
        },
      ),
    ).toEqual(peer.message);
    expect(
      await verify({ ...peer.message, epoch: 2 }, peer.signature, peer.message.publicKey),
    ).toBe(false);
  });
  it.each(['roomId', 'peerId', 'epoch', 'role', 'fingerprint'] as const)(
    'rejects a mismatched %s binding',
    async (field) => {
      const peer = await hello('owner');
      const expected = {
        roomId,
        peerId: peer.message.peerId,
        epoch: 1,
        role: 'owner' as const,
        fingerprint: peer.message.dtlsFingerprint,
      };
      const changed = {
        ...expected,
        [field]:
          field === 'epoch'
            ? 2
            : field === 'role'
              ? 'receiver'
              : field === 'fingerprint'
                ? '0'.repeat(64)
                : randomUUID(),
      };
      await expect(
        authenticateHello({ hello: peer.message, signature: peer.signature }, changed),
      ).rejects.toThrow();
    },
  );
  it('detects key substitution and modified capabilities', async () => {
    const a = await hello('owner');
    const b = await hello('owner');
    expect(await verify(a.message, a.signature, b.message.publicKey)).toBe(false);
    expect(
      await verify(
        { ...a.message, capabilities: { ...capabilities, resumeMode: 'persistent' } },
        a.signature,
        a.message.publicKey,
      ),
    ).toBe(false);
    expect(await verify(a.message, 'broken', a.message.publicKey)).toBe(false);
  });
  it('derives the same 64-bit comparison code at both peers and changes it for each epoch', async () => {
    const a = (await hello('owner')).message;
    const b = (await hello('receiver')).message;
    const first = await pairingTranscript(a, b);
    expect(first).toEqual(await pairingTranscript(b, a));
    expect(first.code).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
    expect(first.fingerprint).toHaveLength(64);
    expect(await pairingTranscript({ ...a, epoch: 2 }, { ...b, epoch: 2 })).not.toEqual(first);
    expect(await pairingTranscript(a, { ...b, nonce: 'b'.repeat(43) })).not.toEqual(first);
    await expect(pairingTranscript(a, { ...b, epoch: 2 })).rejects.toThrow();
    await expect(pairingTranscript(a, a)).rejects.toThrow();
  });
  it('requires an independent confirmation and exact comparison, never automatic verification', () => {
    expect(comparisonMatches('ABCD-1234-5678-90EF', 'abcd-1234-5678-90ef', true)).toBe(true);
    expect(comparisonMatches('ABCD-1234-5678-90EF', 'ABCD-1234-5678-90EF', false)).toBe(false);
    expect(comparisonMatches('ABCD-1234-5678-90EF', 'ABCD-1234-5678-90EE', true)).toBe(false);
    expect(comparisonMatches('', '', true)).toBe(false);
  });
  it('rejects ambiguous, missing or unsupported DTLS fingerprints', () => {
    const fp = 'AF:'.repeat(31) + 'AF';
    expect(dtlsFingerprint(`v=0\r\na=fingerprint:sha-256 ${fp}\r\n`)).toBe('af'.repeat(32));
    for (const sdp of [
      '',
      'a=fingerprint:sha-1 AF',
      `a=fingerprint:sha-256 ${fp}\na=fingerprint:sha-256 ${'00:'.repeat(31)}00`,
    ])
      expect(() => dtlsFingerprint(sdp)).toThrow();
  });
});
describe('ICE and capability limits', () => {
  it('queues candidates until remote SDP is ready and bounds the queue', async () => {
    const received: RTCIceCandidateInit[] = [];
    const pc = {
      addIceCandidate: async (candidate: RTCIceCandidateInit) => {
        received.push(candidate);
      },
    } as RTCPeerConnection;
    const ice = new IceManager();
    await ice.add(pc, { candidate: 'first' });
    await ice.add(pc, { candidate: 'second' });
    expect(received).toEqual([]);
    await ice.remoteReady(pc);
    await ice.add(pc, { candidate: 'third' });
    expect(received.map((candidate) => candidate.candidate)).toEqual(['first', 'second', 'third']);
    const overflow = new IceManager();
    for (let i = 0; i < 64; i++) await overflow.add(pc, {});
    await expect(overflow.add(pc, {})).rejects.toThrow('Too many');
  });
  it('negotiates frame bounds and honest storage/resume capabilities', () => {
    expect(
      negotiateCapabilities(capabilities, {
        ...capabilities,
        preferredFrameBytes: 8192,
        maxMessageBytes: 10000,
      }),
    ).toMatchObject({
      preferredFrameBytes: 8192,
      maxMessageBytes: 10000,
      resumeMode: 'unavailable',
      storageModes: ['memory'],
    });
    expect(() =>
      negotiateCapabilities(capabilities, { ...capabilities, storageModes: ['opfs'] }),
    ).toThrow();
    expect(peerCapabilitiesSchema.safeParse({ ...capabilities, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(
      peerCapabilitiesSchema.safeParse({ ...capabilities, preferredFrameBytes: 64 }).success,
    ).toBe(false);
    expect(peerHelloSchema.safeParse({ capabilities }).success).toBe(false);
  });
  it('reports selected path categories without candidate addresses', async () => {
    const stats = new Map([
      ['t', { type: 'transport', selectedCandidatePairId: 'p' }],
      ['p', { type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { candidateType: 'relay', protocol: 'udp', address: 'secret-address' }],
      ['r', { candidateType: 'host' }],
    ]);
    const pc = { getStats: async () => stats } as unknown as RTCPeerConnection;
    expect(await selectedIcePath(pc)).toEqual({
      kind: 'relay',
      localType: 'relay',
      remoteType: 'host',
      protocol: 'udp',
    });
  });
});
