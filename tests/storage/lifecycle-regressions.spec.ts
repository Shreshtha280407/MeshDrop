import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TransferManifest } from '@meshdrop/protocol';
import type {
  Checkpoint,
  RecoveryListing,
  TransferRecord,
} from '../../packages/storage/src/ReceiverStore';
import { startStoreHarness, storeRequest } from '../helpers/storage';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const NOW = 2000000000000;
const bytes = Buffer.from([3, 1, 4]);
function manifest(): TransferManifest {
  return {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: 1048576,
    totalBytes: bytes.length,
    files: [
      {
        fileId: randomUUID(),
        path: 'lifecycle.bin',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
}
async function start(page: Page) {
  await page.goto('/foundation');
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'clock', { now: NOW });
}
async function prepare(page: Page, m = manifest()) {
  await storeRequest(page, 'prepare', { manifest: m });
  return m;
}
const commit = (page: Page, m: TransferManifest) =>
  storeRequest(page, 'commit', {
    fileId: m.files[0]!.fileId,
    bytes: [...bytes],
    digest: m.files[0]!.sha256,
  });
test('direct reopen cannot expose an expired checkpoint without going through a listing', async ({
  page,
}) => {
  await start(page);
  const m = await prepare(page);
  await commit(page, m);
  const record = await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId });
  await storeRequest(page, 'close');
  await storeRequest(page, 'clock', { now: record.expiresAt });
  await expect(
    storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }),
  ).rejects.toThrow();
});
test('a delayed real receipt transaction cannot recreate metadata after explicit deletion', async ({
  page,
}) => {
  await start(page);
  const m = await prepare(page);
  await commit(page, m);
  await storeRequest(page, 'finalize', { fileId: m.files[0]!.fileId });
  const record = await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId });
  await storeRequest(page, 'arm', { stage: 'receipt' });
  await page.evaluate(
    ({ record, manifest }) => {
      void window.storageHarness
        .request('receipt', {
          receipt: {
            receiptId: crypto.randomUUID(),
            transferId: manifest.transferId,
            manifestDigest: record.manifestDigest,
            epoch: 1,
            totalBytes: manifest.totalBytes,
            files: manifest.files,
            destination: 'browser-temporary',
            completedAt: new Date().toISOString(),
          },
        })
        .catch(() => {});
    },
    { record, manifest: m },
  );
  await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe('receipt');
  await storeRequest(page, 'close');
  await storeRequest(page, 'purge', { transferId: m.transferId });
  await storeRequest(page, 'release');
  // Observe the actual worker reply, so the assertion cannot race the delayed transaction.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.storageHarness.completed + Number(Boolean(window.storageHarness.lastError)),
      ),
    )
    .toBeGreaterThanOrEqual(10);
  expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
});
test('cleanup rechecks renewed retention after a stale catalog snapshot and acquiring the store lock', async ({
  page,
  context,
}) => {
  await start(page);
  const m = await prepare(page);
  const cleaner = await context.newPage();
  try {
    await start(cleaner);
    await storeRequest(cleaner, 'clock', { now: NOW + 86400000 });
    await storeRequest(cleaner, 'arm', { stage: 'catalog' });
    await cleaner.evaluate(() => {
      void window.storageHarness.request('list', null).catch(() => {});
    });
    await expect.poll(() => cleaner.evaluate(() => window.storageHarness.stage)).toBe('catalog');
    await storeRequest(page, 'clock', { now: NOW + 86400000 });
    await commit(page, m);
    await storeRequest(page, 'close');
    await storeRequest(cleaner, 'release');
    await expect.poll(() => cleaner.evaluate(() => window.storageHarness.completed)).toBe(5);
    expect(await storeRequest(page, 'record', { transferId: m.transferId })).not.toBeNull();
    const listing = await storeRequest<RecoveryListing>(cleaner, 'list');
    expect(listing.checkpoints[0]!.committedBytes).toBe(bytes.length);
    expect(listing.cleaned).toBe(0);
  } finally {
    await cleaner.close();
  }
});
test('two independent clients cannot admit records 64 and 65 from the same count snapshot', async ({
  page,
  context,
}) => {
  await start(page);
  await storeRequest(page, 'seed', { manifests: Array.from({ length: 63 }, manifest) });
  const second = await context.newPage();
  try {
    await start(second);
    const m = manifest(),
      n = manifest();
    for (const [current, input] of [
      [page, m],
      [second, n],
    ] as const) {
      await storeRequest(current, 'arm', { stage: 'catalog' });
      await current.evaluate((manifest) => {
        void window.storageHarness.request('prepare', { manifest }).catch(() => {});
      }, input);
    }
    for (const current of [page, second])
      await expect.poll(() => current.evaluate(() => window.storageHarness.stage)).toBe('catalog');
    await Promise.all([storeRequest(page, 'release'), storeRequest(second, 'release')]);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.storageHarness.completed + Number(Boolean(window.storageHarness.lastError)),
        ),
      )
      .toBe(5);
    await expect
      .poll(() =>
        second.evaluate(
          () => window.storageHarness.completed + Number(Boolean(window.storageHarness.lastError)),
        ),
      )
      .toBe(4);
    expect((await storeRequest<TransferRecord[]>(page, 'records')).length).toBe(64);
    const admitted = await Promise.all(
      [m, n].map((x) => storeRequest(page, 'record', { transferId: x.transferId })),
    );
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect((await storeRequest<{ name: string }[]>(page, 'entries')).length).toBe(1);
    await storeRequest(page, 'close');
    await storeRequest(second, 'close');
    const winner = admitted[0] ? m : n;
    const loser = admitted[0] ? n : m;
    await storeRequest(page, 'purge', { transferId: winner.transferId });
    expect((await storeRequest<TransferRecord[]>(page, 'records')).length).toBe(63);
    await storeRequest(page, 'prepare', { manifest: loser });
    expect((await storeRequest<TransferRecord[]>(page, 'records')).length).toBe(64);
  } finally {
    await second.close();
  }
});
