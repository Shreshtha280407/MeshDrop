import { exportCancelled, namedExportFile } from './IosExportAdapter';
import type { ExportOutcome } from './IosExportAdapter';
interface SaveHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}
type PickerWindow = typeof globalThis & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle>;
};
/** Picker opens before any await, retaining the click's transient activation. Stream file-backed bytes. */
export async function saveVerifiedFileWithPicker(file: File, path: string): Promise<ExportOutcome> {
  const picker = (globalThis as PickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function')
    return {
      status: 'unsupported',
      route: 'save-picker',
      nativeExportVerified: false,
      message: 'Choose-location save is unavailable. Use Save download or the system share flow.',
    };
  try {
    const handle = await picker.call(globalThis, {
      suggestedName: namedExportFile(file, path).name,
    });
    await file.stream().pipeTo(await handle.createWritable());
    return {
      status: 'saved',
      route: 'save-picker',
      nativeExportVerified: false,
      message:
        'The selected destination finished writing. Check the saved copy separately; its bytes have not been independently verified.',
    };
  } catch (error) {
    return exportCancelled(error)
      ? {
          status: 'cancelled',
          route: 'save-picker',
          nativeExportVerified: false,
          message: 'Save cancelled. The verified browser copy remains available.',
        }
      : {
          status: 'failed',
          route: 'save-picker',
          nativeExportVerified: false,
          message:
            'The destination write did not finish. Check its free space and try again; the verified browser copy is retained.',
        };
  }
}
