import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashLocalFile } from '../../packages/storage/src/integrity';

describe('streaming full-file verification', () => {
  it.each([0, 1, 2 * 1024 ** 2 + 17])(
    'hashes %i bytes using an independent SHA-256 oracle',
    async (size) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
      const file = new File([bytes], 'synthetic.bin');
      vi.spyOn(file, 'slice').mockImplementation(() => {
        throw new Error('Must stream.');
      });
      expect(await hashLocalFile(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
    },
  );
  it('supports Blob streams without BYOB readers and propagates read errors', async () => {
    const bytes = new Uint8Array([17, 41, 93]);
    const file = new File([bytes], 'fallback.bin');
    vi.spyOn(file, 'stream').mockImplementation(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    );
    expect(await hashLocalFile(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
    vi.spyOn(file, 'stream').mockImplementation(
      () =>
        new ReadableStream({
          start(controller) {
            controller.error(new Error('Read failed.'));
          },
        }),
    );
    await expect(hashLocalFile(file)).rejects.toThrow('Read failed.');
  });
});
