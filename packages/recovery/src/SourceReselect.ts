import type { TransferManifest } from '@meshdrop/protocol';
/** Reuse the original stable IDs, never generate new transfer/file IDs during reselection. */
export function sourceReselectEntries(manifest: TransferManifest, files: readonly File[]) {
  if (files.length !== manifest.files.length) throw new Error('Reselect every original file.');
  const names = new Set<string>();
  return manifest.files.map((meta) => {
    const file = files.find((file) => file.name === meta.path.split('/').at(-1));
    if (!file || file.size !== meta.size || names.has(file.name))
      throw new Error('Source name or size changed.');
    names.add(file.name);
    return { fileId: meta.fileId, path: meta.path, file };
  });
}
