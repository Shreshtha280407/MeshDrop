import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Checkpoint, TransferRecord } from '../../packages/storage/src/ReceiverStore';
import { startStoreHarness, storeRequest } from '../helpers/storage';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
for (const mode of ['foreign-receipt', 'corrupt-bytes', 'wrong-manifest'])
  test(`real OPFS/IndexedDB ${mode} cannot restore trusted completion after reload`, async ({
    page,
  }) => {
    await page.goto('/foundation');
    await startStoreHarness(page);
    const bytes = Buffer.from([3, 1, 4]);
    const transferId = randomUUID(),
      fileId = randomUUID();
    const manifest = {
      version: 1,
      revision: 1,
      transferId,
      blockBytes: 1048576,
      files: [
        {
          fileId,
          path: 'safe.bin',
          size: 3,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
      totalBytes: 3,
    };
    await storeRequest(page, 'prepare', { manifest });
    await storeRequest(page, 'commit', {
      fileId,
      index: 0,
      bytes: [...bytes],
      digest: manifest.files[0]!.sha256,
    });
    await storeRequest(page, 'close');
    await page.evaluate(
      async ({ transferId, manifest, mode }) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('meshdrop-checkpoints-v1', 1);
          request.onerror = () => reject(Error('Test database unavailable'));
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction(['transfers', 'manifests'], 'readwrite'),
              get = tx.objectStore('transfers').get(transferId);
            get.onsuccess = () => {
              const record = get.result as TransferRecord;
              record.state = 'complete';
              record.finalizedFiles = [manifest.files[0]!.fileId];
              record.receipt = {
                receiptId: crypto.randomUUID(),
                transferId: mode === 'foreign-receipt' ? crypto.randomUUID() : transferId,
                manifestDigest: record.manifestDigest,
                epoch: 1,
                totalBytes: 3,
                files: manifest.files,
                destination: 'browser-temporary',
                completedAt: new Date().toISOString(),
              };
              tx.objectStore('transfers').put(record);
              if (mode === 'wrong-manifest')
                tx.objectStore('manifests').put({
                  ...manifest,
                  files: [{ ...manifest.files[0]!, path: 'changed.bin' }],
                });
            };
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(Error('Test database aborted'));
            };
          };
        });
      },
      { transferId, manifest, mode },
    );
    if (mode === 'corrupt-bytes')
      await storeRequest(page, 'mutate', { transferId, fileId, index: 0 });
    await page.evaluate(() => window.storageHarness.stop());
    await page.reload();
    await startStoreHarness(page);
    try {
      if (mode === 'wrong-manifest') {
        let denied = false;
        try {
          await storeRequest(page, 'reconcile', { transferId });
        } catch {
          denied = true;
        }
        expect(denied).toBe(true);
      } else {
        const checkpoint = await storeRequest<Checkpoint>(page, 'reconcile', { transferId });
        expect(checkpoint.record.receipt).toBeNull();
        expect(checkpoint.record.state).toBe('interrupted');
        expect(checkpoint.committedBytes).toBe(mode === 'foreign-receipt' ? 3 : 0);
        expect(checkpoint.files[0]!.finalized).toBe(mode === 'foreign-receipt');
      }
    } finally {
      await page.evaluate(() => window.storageHarness.stop());
    }
  });
