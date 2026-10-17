import { namedExportFile } from './IosExportAdapter';
/** File-backed download: no whole-file arrayBuffer/Blob reconstruction or universal picker assumption. */
export function startFileDownload(file: File, path: string): () => void {
  const output = namedExportFile(file, path);
  const url = URL.createObjectURL(output);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = output.name;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return () => URL.revokeObjectURL(url);
}
