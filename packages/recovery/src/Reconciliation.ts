import { sha256 } from '@noble/hashes/sha2.js';
import { VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { BlockProof, TransferManifest } from '@meshdrop/protocol';
export function proofKey(block: Pick<BlockProof, 'fileId' | 'index'>): string {
  return `${block.fileId}:${block.index}`;
}
export function proofBytes(manifest: TransferManifest, block: BlockProof): number {
  const file = manifest.files.find((file) => file.fileId === block.fileId);
  if (
    !file ||
    !Number.isInteger(block.index) ||
    block.index < 0 ||
    block.index >= Math.ceil(file.size / VERIFICATION_BLOCK_BYTES)
  )
    throw new Error('Block proof outside manifest.');
  return Math.min(VERIFICATION_BLOCK_BYTES, file.size - block.index * VERIFICATION_BLOCK_BYTES);
}
export function checkpointDigest(manifestDigest: string, blocks: readonly BlockProof[]): string {
  const hash = sha256.create();
  const encoder = new TextEncoder();
  hash.update(encoder.encode(`meshdrop-checkpoint-v1:${manifestDigest}\n`));
  const sorted = [...blocks].sort((a, b) =>
    a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.index - b.index,
  );
  for (const block of sorted)
    hash.update(encoder.encode(`${block.fileId}:${block.index}:${block.digest}\n`));
  return Array.from(hash.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
}
