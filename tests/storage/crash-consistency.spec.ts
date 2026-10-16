import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { TransferManifest } from '@meshdrop/protocol';
import type {
  Checkpoint,
  CommitStage,
  RecoveryListing,
} from '../../packages/storage/src/ReceiverStore';
import { startStoreHarness, storeRequest } from '../helpers/storage';
test.use({ trace: 'off', video: 'off' });
const blockBytes = 1024 ** 2;
const first = Buffer.alloc(blockBytes, 97),
  second = Buffer.alloc(blockBytes, 98);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function manifest(): TransferManifest {
  return {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes,
    files: [
      {
        fileId: randomUUID(),
        path: 'checkpoint.bin',
        size: 2 * blockBytes,
        sha256: digest(Buffer.concat([first, second])),
      },
    ],
    totalBytes: 2 * blockBytes,
  };
}
for (const stage of [
  'after-write',
  'after-digest',
  'after-flush',
  'before-ledger',
  'after-ledger',
] as CommitStage[]) {
  test(`terminated worker at ${stage} restores only rehashed ledger-backed blocks`, async ({
    page,
  }) => {
    test.setTimeout(45000);
    await page.goto('/foundation');
    await startStoreHarness(page);
    const m = manifest();
    const fileId = m.files[0]!.fileId;
    await storeRequest(page, 'prepare', { manifest: m });
    await storeRequest(page, 'commit', {
      fileId,
      index: 0,
      bytes: [...first],
      digest: digest(first),
    });
    await storeRequest(page, 'arm', { stage });
    await page.evaluate(
      ({ fileId, bytes, digest }) => {
        void window.storageHarness
          .request('commit', { fileId, index: 1, bytes, digest })
          .catch(() => {});
      },
      { fileId, bytes: [...second], digest: digest(second) },
    );
    await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe(stage);
    const responses = await page.evaluate(() => window.storageHarness.completed);
    expect(responses).toBe(3); // prepare, first commit, arm; the interrupted block never returned ACK eligibility.
    await page.evaluate(() => window.storageHarness.stop());
    await startStoreHarness(page);
    const checkpoint = await storeRequest<Checkpoint>(page, 'reconcile', {
      transferId: m.transferId,
    });
    expect(checkpoint.committedBytes).toBe(stage === 'after-ledger' ? 2 * blockBytes : blockBytes);
    expect(checkpoint.files[0]!.ranges).toEqual(stage === 'after-ledger' ? [[0, 1]] : [[0, 0]]);
    expect(checkpoint.record.receipt).toBeNull();
    // A page reload creates a new JS context and worker, without sending any more file data.
    await page.reload();
    await startStoreHarness(page);
    expect(
      (await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }))
        .committedBytes,
    ).toBe(checkpoint.committedBytes);
    await page.evaluate(() => window.storageHarness.stop());
  });
}
test('quota failure preserves prior blocks; changed, missing and orphaned ledger data is never trusted', async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.goto('/foundation');
  await startStoreHarness(page);
  const m = manifest();
  const fileId = m.files[0]!.fileId;
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', {
    fileId,
    index: 0,
    bytes: [...first],
    digest: digest(first),
  });
  await storeRequest(page, 'quota');
  await expect(
    storeRequest(page, 'commit', { fileId, index: 1, bytes: [...second], digest: digest(second) }),
  ).rejects.toThrow('QuotaExceededError');
  expect(await storeRequest(page, 'records', { transferId: m.transferId })).toHaveLength(1);
  await storeRequest(page, 'close');
  expect(
    (await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }))
      .committedBytes,
  ).toBe(blockBytes);
  await storeRequest(page, 'mutate', { transferId: m.transferId, fileId, index: 0 });
  expect(
    (await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }))
      .committedBytes,
  ).toBe(0);
  await storeRequest(page, 'forge-ledger', {
    transferId: m.transferId,
    fileId,
    index: 1,
    digest: digest(second),
  });
  await storeRequest(page, 'delete-file', { transferId: m.transferId, fileId });
  const missing = await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId });
  expect(missing.committedBytes).toBe(0);
  expect(missing.discardedBlocks).toBe(1);
  await page.evaluate(() => window.storageHarness.stop());
});
test('exclusive access prevents another tab from reopening or purging an active transfer', async ({
  page,
  context,
}) => {
  await page.goto('/foundation');
  await startStoreHarness(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  const other = await context.newPage();
  await other.goto('/foundation');
  await startStoreHarness(other);
  await expect(storeRequest(other, 'reconcile', { transferId: m.transferId })).rejects.toThrow(
    'StorageFailure',
  );
  const listing = await storeRequest<RecoveryListing>(other, 'list');
  expect(listing.unavailable[0]?.reason).toContain('another tab');
  await expect(storeRequest(other, 'purge', { transferId: m.transferId })).rejects.toThrow(
    'StorageFailure',
  );
  await storeRequest(page, 'close');
  expect(
    (await storeRequest<Checkpoint>(other, 'reconcile', { transferId: m.transferId }))
      .committedBytes,
  ).toBe(0);
  await page.evaluate(() => window.storageHarness.stop());
  await other.evaluate(() => window.storageHarness.stop());
});
test('expiry, discard policy and OPFS orphan cleanup are scoped to MeshDrop transfers', async ({
  page,
}) => {
  await page.goto('/foundation');
  await startStoreHarness(page);
  for (const kind of ['expired', 'discard', 'orphan']) {
    const m = manifest();
    await storeRequest(page, 'prepare', {
      manifest: m,
      retention: kind === 'discard' ? 'discard' : '24-hours',
    });
    await storeRequest(page, 'close');
    if (kind === 'expired') await storeRequest(page, 'expire', { transferId: m.transferId });
    if (kind === 'orphan') await storeRequest(page, 'remove-ledger', { transferId: m.transferId });
  }
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const unrelated = await root.getFileHandle('unrelated.txt', { create: true });
    const writer = await unrelated.createWritable();
    await writer.write('preserve');
    await writer.close();
  });
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.cleaned).toBe(3);
  expect(result.checkpoints).toEqual([]);
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return (await (await root.getFileHandle('unrelated.txt')).getFile()).text();
    }),
  ).toBe('preserve');
  await page.evaluate(() => window.storageHarness.stop());
});

test('aborting the real IndexedDB commit rolls back both the block row and transfer metadata', async ({
  page,
}) => {
  test.setTimeout(45000);
  await page.goto('/foundation');
  await startStoreHarness(page);
  const m = manifest();
  const fileId = m.files[0]!.fileId;
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', {
    fileId,
    index: 0,
    bytes: [...first],
    digest: digest(first),
  });
  await storeRequest(page, 'abort-ledger');
  const before = await storeRequest(page, 'record', { transferId: m.transferId });
  await expect(
    storeRequest(page, 'commit', { fileId, index: 1, bytes: [...second], digest: digest(second) }),
  ).rejects.toThrow();
  expect(await storeRequest(page, 'records', { transferId: m.transferId })).toHaveLength(1);
  expect(await storeRequest(page, 'record', { transferId: m.transferId })).toEqual(before);
  await storeRequest(page, 'close');
  const reopened = await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId });
  expect(reopened.committedBytes).toBe(blockBytes);
  expect(reopened.files[0]?.ranges).toEqual([[0, 0]]);
  await page.evaluate(() => window.storageHarness.stop());
});
