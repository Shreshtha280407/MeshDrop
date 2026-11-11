import type { ProbeState } from './CapabilityProbe';

/** Exercise the protocol's algorithms with throwaway keys, without permissions or identities. */
export async function probeRequiredCrypto(): Promise<ProbeState> {
  const api = globalThis.crypto;
  const subtle = api?.subtle;
  if (
    typeof api?.randomUUID !== 'function' ||
    typeof api?.getRandomValues !== 'function' ||
    !subtle ||
    !(['digest', 'generateKey', 'exportKey', 'importKey', 'sign', 'verify'] as const).every(
      (method) => typeof subtle[method] === 'function',
    )
  )
    return 'unsupported';
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        api.randomUUID(),
      )
    )
      return 'unavailable';
    api.getRandomValues(new Uint8Array(1));
    const input = new TextEncoder().encode('MeshDrop capability probe');
    const digest = new Uint8Array(await subtle.digest('SHA-256', input));
    if (
      [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') !==
      'bd7fdd76e40ac13c1dc7e7ad05637965504ccf89f4aef4b4821985cf731c78f4'
    )
      return 'unavailable';
    const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const raw = await subtle.exportKey('raw', keys.publicKey);
    const publicKey = await subtle.importKey(
      'raw',
      raw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, input);
    return (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, input))
      ? 'available'
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
