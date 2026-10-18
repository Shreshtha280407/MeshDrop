import { sha256 } from '@noble/hashes/sha2.js';
import { manifestSchema, VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { TransferManifest, TransferFile } from '@meshdrop/protocol';

export const hexDigest = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const digestBytes = (bytes: Uint8Array) => hexDigest(sha256(bytes));
export const digestManifest = (input: TransferManifest) =>
  digestBytes(new TextEncoder().encode(JSON.stringify(manifestSchema.parse(input))));
export function storedBlockLength(size: number, index: number): number {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= Math.ceil(size / VERIFICATION_BLOCK_BYTES)
  )
    throw new Error('Block outside manifest.');
  return Math.min(VERIFICATION_BLOCK_BYTES, size - index * VERIFICATION_BLOCK_BYTES);
}
export async function hashLocalFile(file: File): Promise<string> {
  const hash = sha256.create();
  const stream = file.stream();
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = stream.getReader({ mode: 'byob' });
  } catch {
    // Older browser Blob streams may not expose a byte reader.
  }
  if (byob) {
    let buffer = new ArrayBuffer(VERIFICATION_BLOCK_BYTES);
    try {
      for (;;) {
        const { value, done } = await byob.read(new Uint8Array(buffer));
        if (value?.byteLength) hash.update(value);
        if (done) break;
        // BYOB transfers ownership on each read. Reuse the returned backing
        // buffer instead of allocating a new MiB for every file block.
        buffer = value.buffer;
      }
    } finally {
      byob.releaseLock();
    }
  } else {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  return hexDigest(hash.digest());
}
export async function verifyReselectedSource(file: File, expected: TransferFile): Promise<string> {
  if (file.size !== expected.size || file.name.normalize('NFC') !== expected.path.split('/').at(-1))
    throw new Error('The selected source name or size does not match.');
  const digest = await hashLocalFile(file);
  if (digest !== expected.sha256) throw new Error('The selected source SHA-256 does not match.');
  return digest;
}
