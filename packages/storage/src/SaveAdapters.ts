import { relativePathSchema } from '@meshdrop/protocol';
/** File-backed download: no whole-file arrayBuffer/Blob reconstruction or universal picker assumption. */
export function startFileDownload(file: File, path: string): () => void {
  relativePathSchema.parse(path);
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = path.split('/').at(-1)!;
  anchor.rel = 'noopener';
  anchor.click();
  return () => URL.revokeObjectURL(url);
}
