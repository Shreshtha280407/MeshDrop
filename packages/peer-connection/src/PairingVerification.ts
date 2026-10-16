import { peerHelloSchema } from '@meshdrop/protocol';
import type { PeerHello, SignedHello } from '@meshdrop/protocol';

const encoder = new TextEncoder();
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes instanceof Uint8Array ? bytes : bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
/** Field ordering is part of the signed wire format; schemas reject unknown fields. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical(value)))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function createIdentity(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
    'verify',
  ]);
  return {
    privateKey: keys.privateKey,
    publicKey: base64url(await crypto.subtle.exportKey('raw', keys.publicKey)),
  };
}
export async function sign(value: unknown, key: CryptoKey): Promise<string> {
  return base64url(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      encoder.encode(canonical(value)),
    ),
  );
}
export async function verify(
  value: unknown,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decode(publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decode(signature),
      encoder.encode(canonical(value)),
    );
  } catch {
    return false;
  }
}
export function dtlsFingerprint(sdp: string): string {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(
    (match) => match[1]!.replaceAll(':', '').toLowerCase(),
  );
  const unique = [...new Set(fingerprints)];
  if (unique.length !== 1 || !/^[a-f0-9]{64}$/.test(unique[0]!))
    throw new Error('A single SHA-256 DTLS fingerprint is required.');
  return unique[0]!;
}
export async function authenticateHello(
  signed: SignedHello,
  expected: {
    roomId: string;
    epoch: number;
    peerId: string;
    role: 'owner' | 'receiver';
    fingerprint: string;
  },
): Promise<PeerHello> {
  const hello = peerHelloSchema.parse(signed.hello);
  if (
    hello.roomId !== expected.roomId ||
    hello.epoch !== expected.epoch ||
    hello.peerId !== expected.peerId ||
    hello.role !== expected.role ||
    hello.dtlsFingerprint !== expected.fingerprint ||
    !(await verify(hello, signed.signature, hello.publicKey))
  )
    throw new Error('Peer identity or transport binding did not match.');
  return hello;
}
export async function pairingTranscript(
  local: PeerHello,
  remote: PeerHello,
): Promise<{ fingerprint: string; code: string }> {
  if (
    local.roomId !== remote.roomId ||
    local.epoch !== remote.epoch ||
    local.role === remote.role ||
    local.peerId === remote.peerId
  )
    throw new Error('Pairing context does not match.');
  const owner = local.role === 'owner' ? local : remote;
  const receiver = local.role === 'receiver' ? local : remote;
  const fingerprint = await digest({ domain: 'meshdrop-pairing-v1', owner, receiver });
  return { fingerprint, code: fingerprint.slice(0, 16).toUpperCase().match(/.{4}/g)!.join('-') };
}
export function comparisonMatches(
  code: string,
  entered: string,
  independentConfirmation: boolean,
): boolean {
  return (
    independentConfirmation &&
    /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code) &&
    code === entered.trim().toUpperCase().replaceAll(' ', '-')
  );
}
