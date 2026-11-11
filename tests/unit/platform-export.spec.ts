import { afterEach, expect, it, vi } from 'vitest';
import { shareVerifiedFile } from '../../packages/storage/src/IosExportAdapter';
import { saveVerifiedFileWithPicker } from '../../packages/storage/src/AndroidSaveAdapter';
import { startFileDownload } from '../../packages/storage/src/SaveAdapters';

afterEach(() => vi.unstubAllGlobals());
const file = () => new File([new Uint8Array([71, 0, 255, 18])], 'verified.bin');

it.each(['AbortError', 'NotAllowedError'] as const)(
  'handles cross-realm share %s without claiming saved bytes',
  async (name) => {
    const share = vi.fn(async () => {
      throw { name };
    });
    vi.stubGlobal('navigator', { canShare: () => true, share });
    const result = await shareVerifiedFile(file(), 'result.bin');
    expect(result).toMatchObject({
      status: name === 'AbortError' ? 'cancelled' : 'failed',
      route: 'system-share',
      nativeExportVerified: false,
    });
    expect(share).toHaveBeenCalledOnce();
  },
);
it('cannot certify export by resolving a system share sheet', async () => {
  vi.stubGlobal('navigator', { canShare: () => true, share: async () => {} });
  expect(await shareVerifiedFile(file(), 'result.bin')).toMatchObject({
    status: 'started',
    nativeExportVerified: false,
  });
});
it('keeps export unsupported when a Safari file type is not shareable', async () => {
  const share = vi.fn();
  vi.stubGlobal('navigator', { canShare: () => false, share });
  expect(await shareVerifiedFile(file(), 'result.bin')).toMatchObject({
    status: 'unsupported',
    nativeExportVerified: false,
  });
  expect(share).not.toHaveBeenCalled();
});
it('treats a Windows destination close failure as failed export', async () => {
  vi.stubGlobal('showSaveFilePicker', async () => ({
    createWritable: async () =>
      new WritableStream({
        close() {
          throw Error('Destination disconnected');
        },
      }),
  }));
  expect(await saveVerifiedFileWithPicker(file(), 'result.bin')).toMatchObject({
    status: 'failed',
    route: 'save-picker',
    nativeExportVerified: false,
  });
});
it('does not confuse a completed picker stream with independent native verification', async () => {
  const saved: Uint8Array[] = [];
  vi.stubGlobal('showSaveFilePicker', async () => ({
    createWritable: async () =>
      new WritableStream<Uint8Array>({
        write(b) {
          saved.push(b.slice());
        },
      }),
  }));
  const result = await saveVerifiedFileWithPicker(file(), 'result.bin');
  expect(Buffer.concat(saved)).toEqual(Buffer.from([71, 0, 255, 18]));
  expect(result).toMatchObject({ status: 'saved', nativeExportVerified: false });
});
it('recognizes serialized picker cancellation without retrying or opening a download', async () => {
  const picker = vi.fn(async () => {
    throw { name: 'AbortError' };
  });
  vi.stubGlobal('showSaveFilePicker', picker);
  expect(await saveVerifiedFileWithPicker(file(), 'result.bin')).toMatchObject({
    status: 'cancelled',
    nativeExportVerified: false,
  });
  expect(picker).toHaveBeenCalledOnce();
});
it('retains a successful download URL until its owner releases it', () => {
  const revoke = vi.fn(),
    remove = vi.fn(),
    click = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:task13-export', revokeObjectURL: revoke });
  vi.stubGlobal('document', { createElement: () => ({ click, remove }), body: { append() {} } });
  const release = startFileDownload(file(), 'result.bin');
  expect(click).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  release();
  expect(revoke).toHaveBeenCalledWith('blob:task13-export');
});
