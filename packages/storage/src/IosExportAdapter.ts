import { relativePathSchema } from '@meshdrop/protocol';
export type ExportOutcome = {
  status: 'saved' | 'started' | 'cancelled' | 'unsupported' | 'failed';
  route: 'download' | 'save-picker' | 'system-share';
  // A resolved picker/share/download action cannot independently hash the destination.
  nativeExportVerified: false;
  message: string;
};
export function exportCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}
export function namedExportFile(file: File, path: string): File {
  relativePathSchema.parse(path);
  const name = path.split('/').at(-1)!;
  const types: Record<string, string> = {
    txt: 'text/plain',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    mp4: 'video/mp4',
    zip: 'application/zip',
    json: 'application/json',
  };
  const extension = name.split('.').at(-1)!.toLowerCase();
  return new File([file], name, {
    type: Object.hasOwn(types, extension) ? types[extension]! : 'application/octet-stream',
  });
}
export function canShareFile(file: File, path: string): boolean {
  try {
    return (
      typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [namedExportFile(file, path)] }) === true
    );
  } catch {
    return false;
  }
}
/** Call directly from a user action with an already verified file; do not await worker reads first. */
export async function shareVerifiedFile(file: File, path: string): Promise<ExportOutcome> {
  if (!canShareFile(file, path))
    return {
      status: 'unsupported',
      route: 'system-share',
      nativeExportVerified: false,
      message: 'System file sharing is unavailable for this file. Use Save download instead.',
    };
  try {
    await navigator.share({ files: [namedExportFile(file, path)] });
    return {
      status: 'started',
      route: 'system-share',
      nativeExportVerified: false,
      message:
        'The system share flow returned. Check Files or the app you chose for your saved copy.',
    };
  } catch (error) {
    return exportCancelled(error)
      ? {
          status: 'cancelled',
          route: 'system-share',
          nativeExportVerified: false,
          message: 'Sharing cancelled. The verified browser copy is still available.',
        }
      : {
          status: 'failed',
          route: 'system-share',
          nativeExportVerified: false,
          message:
            'System sharing did not finish. Your verified copy remains here; try Save download.',
        };
  }
}
