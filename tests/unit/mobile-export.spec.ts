import { afterEach, expect, it, vi } from 'vitest';
import {
  canShareFile,
  namedExportFile,
  shareVerifiedFile,
} from '../../packages/storage/src/IosExportAdapter';
import { saveVerifiedFileWithPicker } from '../../packages/storage/src/AndroidSaveAdapter';
afterEach(() => vi.unstubAllGlobals());
const file = () => new File([new Uint8Array([4, 8, 15, 16, 23, 42])], 'opfs-uuid');
it('keeps a file-backed export and safe basename without assuming Safari has a picker', async () => {
  const output = namedExportFile(file(), 'folder/evidence.txt');
  expect(output.name).toBe('evidence.txt');
  expect(output.type).toBe('text/plain');
  expect([...new Uint8Array(await output.arrayBuffer())]).toEqual([4, 8, 15, 16, 23, 42]);
  expect(() => namedExportFile(file(), '../unsafe.txt')).toThrow();
  vi.stubGlobal('navigator', {});
  expect(canShareFile(file(), 'evidence.txt')).toBe(false);
  expect((await shareVerifiedFile(file(), 'evidence.txt')).status).toBe('unsupported');
  vi.stubGlobal('showSaveFilePicker', undefined);
  expect((await saveVerifiedFileWithPicker(file(), 'evidence.txt')).status).toBe('unsupported');
});
it('invokes native sharing before yielding and never reports a returned share sheet as a proven saved file', async () => {
  const share = vi.fn(async () => {});
  vi.stubGlobal('navigator', { canShare: () => true, share });
  const pending = shareVerifiedFile(file(), 'result.txt');
  expect(share).toHaveBeenCalledTimes(1);
  expect((share.mock.calls[0] as unknown as [ShareData])[0].files?.[0]?.name).toBe('result.txt');
  expect((await pending).status).toBe('started');
});
it('treats share cancellation and rejection as retained-copy outcomes without a second automatic dialog', async () => {
  const share = vi.fn(async () => {
    throw new DOMException('Dismissed', 'AbortError');
  });
  vi.stubGlobal('navigator', { canShare: () => true, share });
  expect((await shareVerifiedFile(file(), 'result.txt')).status).toBe('cancelled');
  expect(share).toHaveBeenCalledTimes(1);
  share.mockRejectedValueOnce(new Error('Not allowed'));
  expect((await shareVerifiedFile(file(), 'result.txt')).status).toBe('failed');
});
it('opens a picker during the action and streams exact bytes through destination close', async () => {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const picker = vi.fn(async () => ({
    createWritable: async () =>
      new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk.slice());
        },
        close() {
          closed = true;
        },
      }),
  }));
  vi.stubGlobal('showSaveFilePicker', picker);
  const pending = saveVerifiedFileWithPicker(file(), 'folder/result.bin');
  expect(picker).toHaveBeenCalledWith({ suggestedName: 'result.bin' });
  expect((await pending).status).toBe('saved');
  expect(closed).toBe(true);
  expect([...Buffer.concat(chunks)]).toEqual([4, 8, 15, 16, 23, 42]);
});
it('does not claim a save when the picker is cancelled or its destination runs out of space', async () => {
  const picker = vi.fn(async (): Promise<unknown> => {
    throw new DOMException('Dismissed', 'AbortError');
  });
  vi.stubGlobal('showSaveFilePicker', picker);
  expect((await saveVerifiedFileWithPicker(file(), 'result.bin')).status).toBe('cancelled');
  picker.mockResolvedValueOnce({
    createWritable: async () =>
      new WritableStream({
        write() {
          throw new DOMException('Full', 'QuotaExceededError');
        },
      }),
  });
  expect((await saveVerifiedFileWithPicker(file(), 'result.bin')).status).toBe('failed');
});
