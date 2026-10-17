import { namedExportFile } from './IosExportAdapter';
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
      message: 'Choose-location save is unavailable. Use Save download or the system share flow.',
    };
  try {
    const handle = await picker.call(globalThis, {
      suggestedName: namedExportFile(file, path).name,
    });
    await file.stream().pipeTo(await handle.createWritable());
    return {
      status: 'saved',
      message: 'The selected destination finished writing your verified file.',
    };
  } catch (error) {
    return error instanceof DOMException && error.name === 'AbortError'
      ? {
          status: 'cancelled',
          message: 'Save cancelled. The verified browser copy remains available.',
        }
      : {
          status: 'failed',
          message:
            'The destination write did not finish. Check its free space and try again; the verified browser copy is retained.',
        };
  }
}
