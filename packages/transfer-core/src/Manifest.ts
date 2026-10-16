import { manifestSchema, safeRelativePath, VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { TransferManifest } from '@meshdrop/protocol';

export function sourceEntries(
  files: readonly File[],
): { fileId: string; path: string; file: File }[] {
  const entries = files.map((file) => ({
    fileId: crypto.randomUUID(),
    path: (file.webkitRelativePath || file.name).normalize('NFC'),
    file,
  }));
  if (
    !entries.length ||
    entries.length > 16 ||
    entries.some((entry) => !safeRelativePath(entry.path)) ||
    new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length
  )
    throw new Error(
      'Choose 1–16 files with distinct safe relative names; rename unsupported names before sharing.',
    );
  return entries;
}
export async function manifestDigest(input: TransferManifest): Promise<string> {
  const manifest = manifestSchema.parse(input);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(manifest)),
  );
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
export function blockLength(size: number, index: number): number {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= Math.ceil(size / VERIFICATION_BLOCK_BYTES)
  )
    throw new Error('Block index is outside the file.');
  return Math.min(VERIFICATION_BLOCK_BYTES, size - index * VERIFICATION_BLOCK_BYTES);
}
