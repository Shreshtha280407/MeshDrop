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
  try {
    document.body.append(anchor);
    anchor.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    anchor.remove();
  }
  return () => URL.revokeObjectURL(url);
}
