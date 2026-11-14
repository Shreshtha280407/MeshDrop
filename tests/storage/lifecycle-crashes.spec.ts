import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TransferManifest } from '@meshdrop/protocol';
import type { RecoveryListing, TransferRecord } from '../../packages/storage/src/ReceiverStore';
import { startStoreHarness, storeRequest } from '../helpers/storage';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const NOW = 2000000000000;
const bytes = [3, 1, 4];
const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
function manifest(): TransferManifest {
  return {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: 1048576,
    totalBytes: bytes.length,
    files: [{ fileId: randomUUID(), path: 'crash.bin', size: bytes.length, sha256: digest }],
  };
}
async function start(page: Page) {
  await page.goto('/foundation');
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'clock', { now: NOW });
}
async function interrupt(page: Page, operation: string, payload: unknown, stage: string) {
  await storeRequest(page, 'arm', { stage });
  await page.evaluate(
    ({ operation, payload }) => {
      void window.storageHarness.request(operation, payload).catch(() => {});
    },
    { operation, payload },
  );
  await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe(stage);
  await page.evaluate(() => window.storageHarness.stop());
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'clock', { now: NOW });
  await expect
    .poll(async () => (await storeRequest<RecoveryListing>(page, 'list')).unavailable.length)
    .toBe(0);
}
for (const stage of [
  'before-metadata',
  'after-metadata',
  'before-parent',
  'after-parent',
  'after-transfer-directory',
  'after-storage-directory',
  'during-file-creation',
])
  test(`prepare termination at ${stage} retains only discoverable partial state until expiry`, async ({
    page,
  }) => {
    await start(page);
    const m = manifest();
    await interrupt(page, 'prepare', { manifest: m }, stage);
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect(result.checkpoints.length).toBe(stage === 'before-metadata' ? 0 : 1);
    expect(
      result.checkpoints.every((c) => c.committedBytes === 0 && c.record.receipt === null),
    ).toBe(true);
    if (stage !== 'before-metadata') {
      expect(result.checkpoints[0]!.record.expiresAt).toBe(NOW + 86400000);
      await storeRequest(page, 'clock', { now: NOW + 86400000 });
      expect((await storeRequest<RecoveryListing>(page, 'list')).cleaned).toBe(1);
    }
    expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
    expect(await storeRequest(page, 'entries')).toEqual([]);
  });
for (const stage of [
  'before-tombstone',
  'after-tombstone',
  'before-opfs-remove',
  'after-opfs-remove',
  'before-idb-remove',
  'after-idb-remove',
])
  test(`deletion termination at ${stage} is conservative, retryable and idempotent`, async ({
    page,
  }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'prepare', { manifest: m });
    await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
    await storeRequest(page, 'close');
    await interrupt(page, 'purge', { transferId: m.transferId }, stage);
    const result = await storeRequest<RecoveryListing>(page, 'list');
    // Before a tombstone commits there is no durable deletion intent. Never
    // guess that an otherwise valid checkpoint should be destroyed.
    expect(result.checkpoints.length).toBe(stage === 'before-tombstone' ? 1 : 0);
    if (stage === 'before-tombstone')
      expect(result.checkpoints[0]!.committedBytes).toBe(bytes.length);
    await storeRequest(page, 'purge', { transferId: m.transferId });
    await storeRequest(page, 'purge', { transferId: m.transferId });
    expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
    expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
    expect(await storeRequest(page, 'entries')).toEqual([]);
  });
for (const kind of ['ledger-callback', 'reconcile-callback'])
  test(`a delayed ${kind} cannot undo explicit deletion`, async ({ page }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'prepare', { manifest: m });
    if (kind === 'reconcile-callback') {
      await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
      await storeRequest(page, 'close');
    }
    await storeRequest(page, 'arm', { stage: kind });
    const completed = await page.evaluate(() => window.storageHarness.completed);
    await page.evaluate(
      ({ kind, manifest, bytes, digest }) => {
        void window.storageHarness
          .request(kind === 'ledger-callback' ? 'commit' : 'reconcile', {
            transferId: manifest.transferId,
            fileId: manifest.files[0]!.fileId,
            bytes,
            digest,
          })
          .catch(() => {});
      },
      { kind, manifest: m, bytes, digest },
    );
    await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe(kind);
    await storeRequest(page, 'close');
    await storeRequest(page, 'purge', { transferId: m.transferId });
    await storeRequest(page, 'release');
    await expect
      .poll(() =>
        page.evaluate(
          () => window.storageHarness.completed + Number(Boolean(window.storageHarness.lastError)),
        ),
      )
      .toBe(completed + 4);
    expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
    expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
  });
test('a deletion tombstone survives damaged metadata and worker termination', async ({ page }) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await storeRequest(page, 'patch-record', {
    transferId: m.transferId,
    patch: { retention: 'invalid-policy' },
  });
  await interrupt(page, 'purge', { transferId: m.transferId }, 'after-tombstone');
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.checkpoints).toEqual([]);
  expect(result.unavailable).toEqual([]);
  expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
  expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
  expect(await storeRequest(page, 'entries')).toEqual([]);
});
test('missing OPFS with a surviving ledger becomes an empty interrupted checkpoint without a receipt', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await storeRequest(page, 'remove-opfs', { transferId: m.transferId });
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.checkpoints[0]!.committedBytes).toBe(0);
  expect(result.checkpoints[0]!.discardedBlocks).toBe(1);
  expect(result.checkpoints[0]!.record.receipt).toBeNull();
  expect(result.checkpoints[0]!.record.state).toBe('interrupted');
  expect(
    (await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId })).expiresAt,
  ).toBe(NOW + 86400000);
});
