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
const bytes = [3, 1, 4];
const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
function manifest(): TransferManifest {
  return {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: 1048576,
    totalBytes: bytes.length,
    files: [{ fileId: randomUUID(), path: 'lifecycle.bin', size: bytes.length, sha256: digest }],
  };
}
async function start(page: Page) {
  await page.goto('/foundation');
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'clock', { now: NOW });
}
test('a failed deletion withdraws cached exports until deletion is reconciled', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await page.route('**/recovery.worker.ts*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        (await response.text()) +
        '\nconst task16Remove=FileSystemDirectoryHandle.prototype.removeEntry;FileSystemDirectoryHandle.prototype.removeEntry=function(name,options){if(this.name==="meshdrop-receiver-v1")return Promise.reject(new DOMException("Synthetic fixture denial","NotAllowedError"));return task16Remove.call(this,name,options);};\n',
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Export saved lifecycle.bin', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save lifecycle.bin', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete saved lifecycle.bin', exact: true }).click();
  await expect(page.getByTestId('saved-transfers')).toContainText('could not finish');
  await expect(page.getByRole('button', { name: 'Save lifecycle.bin', exact: true })).toHaveCount(
    0,
  );
  await page.unroute('**/recovery.worker.ts*');
  await page.reload();
  await expect(page.getByTestId('saved-checkpoint')).toHaveCount(0);
  await expect(page.getByTestId('saved-transfers')).toContainText('No retained transfers');
});
test('a completed empty file uses the preparation deadline and is never confused with an unverified empty checkpoint', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  m.totalBytes = 0;
  m.files[0]!.size = 0;
  m.files[0]!.sha256 = createHash('sha256').digest('hex');
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'finalize', { fileId: m.files[0]!.fileId });
  const record = await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId });
  await storeRequest(page, 'receipt', {
    receipt: {
      receiptId: randomUUID(),
      transferId: m.transferId,
      manifestDigest: record.manifestDigest,
      epoch: 1,
      totalBytes: 0,
      files: m.files,
      destination: 'browser-temporary',
      completedAt: new Date().toISOString(),
    },
  });
  await storeRequest(page, 'close');
  await storeRequest(page, 'clock', { now: NOW + 86400000 - 1 });
  const before = await storeRequest<RecoveryListing>(page, 'list');
  expect(before.checkpoints[0]!.record.state).toBe('complete');
  expect(before.checkpoints[0]!.record.expiresAt).toBe(NOW + 86400000);
  await storeRequest(page, 'clock', { now: NOW + 86400000 });
  expect((await storeRequest<RecoveryListing>(page, 'list')).checkpoints).toEqual([]);
});
test('only a successful block commit refreshes receiver expiry, not reads, finalization or receipt persistence', async ({
  page,
}) => {
  await start(page);
  const first = Buffer.alloc(1048576, 23),
    last = Buffer.from(bytes),
    all = Buffer.concat([first, last]);
  const m = manifest();
  m.totalBytes = all.length;
  m.files[0]!.size = all.length;
  m.files[0]!.sha256 = createHash('sha256').update(all).digest('hex');
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'clock', { now: NOW + 1000 });
  await storeRequest(page, 'commit', {
    fileId: m.files[0]!.fileId,
    bytes: [...first],
    digest: createHash('sha256').update(first).digest('hex'),
  });
  await storeRequest(page, 'close');
  await storeRequest(page, 'clock', { now: NOW + 2000 });
  expect((await storeRequest<RecoveryListing>(page, 'list')).checkpoints[0]!.record.expiresAt).toBe(
    NOW + 86400000 + 1000,
  );
  await storeRequest(page, 'open-write', { transferId: m.transferId });
  await storeRequest(page, 'clock', { now: NOW + 3000 });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, index: 1, bytes, digest });
  await storeRequest(page, 'clock', { now: NOW + 4000 });
  await storeRequest(page, 'finalize', { fileId: m.files[0]!.fileId });
  const record = await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId });
  await storeRequest(page, 'clock', { now: NOW + 5000 });
  await storeRequest(page, 'receipt', {
    receipt: {
      receiptId: randomUUID(),
      transferId: m.transferId,
      manifestDigest: record.manifestDigest,
      epoch: 1,
      totalBytes: m.totalBytes,
      files: m.files,
      destination: 'browser-temporary',
      completedAt: new Date().toISOString(),
    },
  });
  await storeRequest(page, 'close');
  expect((await storeRequest<RecoveryListing>(page, 'list')).checkpoints[0]!.record.expiresAt).toBe(
    NOW + 86400000 + 3000,
  );
});
test('failed byte revalidation removes previously prepared export controls', async ({ page }) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await page.goto('/');
  await expect(page.getByTestId('recovered-bytes')).toHaveText(String(bytes.length));
  await page.getByRole('button', { name: 'Export saved lifecycle.bin', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save lifecycle.bin', exact: true })).toBeVisible();
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'change-bytes', {
    transferId: m.transferId,
    fileId: m.files[0]!.fileId,
    bytes: [255],
  });
  await page.getByRole('button', { name: 'Check saved transfers', exact: true }).click();
  await expect(page.getByTestId('recovered-bytes')).toHaveText('0');
  await expect(page.getByRole('button', { name: 'Save lifecycle.bin', exact: true })).toHaveCount(
    0,
  );
});
test('orphan collection preserves a UUID-named regular file rather than treating it as a transfer directory', async ({
  page,
}) => {
  await start(page);
  const name = randomUUID();
  await storeRequest(page, 'orphan-file', { names: [name] });
  const listing = await storeRequest<RecoveryListing>(page, 'list');
  expect(listing.cleaned).toBe(0);
  expect(await storeRequest(page, 'entries')).toEqual([{ name, kind: 'file' }]);
});
test('direct source reselection cannot bypass source expiry by skipping the saved-transfers list', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'source', { manifest: m, expiresAt: 1 });
  await page.evaluate(() => window.storageHarness.stop());
  await startStoreHarness(page, '../../packages/storage/src/recovery.worker.ts');
  const denied = await page.evaluate(
    async ({ manifest, bytes }) => {
      try {
        await window.storageHarness.request('reselect', {
          transferId: manifest.transferId,
          fileId: manifest.files[0]!.fileId,
          file: new File([new Uint8Array(bytes)], 'lifecycle.bin'),
        });
        return false;
      } catch {
        return true;
      }
    },
    { manifest: m, bytes },
  );
  expect(denied).toBe(true);
});
for (const retention of ['24-hours', '7-days'] as const)
  for (const offset of [-1, 0, 1])
    test(`${retention} completed receipt is retained before and cleaned at/after expiry (${offset})`, async ({
      page,
    }) => {
      await start(page);
      const m = manifest();
      await storeRequest(page, 'prepare', { manifest: m, retention });
      await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
      await storeRequest(page, 'finalize', { fileId: m.files[0]!.fileId });
      const record = await storeRequest<TransferRecord>(page, 'record', {
        transferId: m.transferId,
      });
      const receipt = {
        receiptId: randomUUID(),
        transferId: m.transferId,
        manifestDigest: record.manifestDigest,
        epoch: 1,
        totalBytes: m.totalBytes,
        files: m.files,
        destination: 'browser-temporary',
        completedAt: new Date().toISOString(),
      };
      await storeRequest(page, 'receipt', { receipt });
      await storeRequest(page, 'close');
      await storeRequest(page, 'clock', { now: record.expiresAt + offset });
      const result = await storeRequest<RecoveryListing>(page, 'list');
      expect(result.unavailable).toEqual([]);
      expect(result.cleaned).toBe(offset < 0 ? 0 : 1);
      expect(result.checkpoints.length).toBe(offset < 0 ? 1 : 0);
      if (offset < 0) {
        expect(result.checkpoints[0]!.record.receipt).toEqual(receipt);
        expect(result.checkpoints[0]!.record.expiresAt).toBe(record.expiresAt);
        expect(
          (await storeRequest<RecoveryListing>(page, 'list')).checkpoints[0]!.record.expiresAt,
        ).toBe(record.expiresAt);
      }
    });
for (const age of [0, 3600000 - 1, 3600000, 3600000 + 1])
  test(`discard is removed on unlocked reopening at age ${age}, never recovered from its crash deadline`, async ({
    page,
    context,
  }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'prepare', { manifest: m, retention: 'discard' });
    await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
    const record = await storeRequest<TransferRecord>(page, 'record', { transferId: m.transferId });
    expect(record.expiresAt).toBe(NOW + 3600000);
    await storeRequest(page, 'clock', { now: NOW + age });
    const other = await context.newPage();
    try {
      await start(other);
      await storeRequest(other, 'clock', { now: NOW + age });
      const busy = await storeRequest<RecoveryListing>(other, 'list');
      expect(busy.cleaned).toBe(0);
      expect(busy.unavailable[0]!.reason).toContain('another tab');
      expect(await storeRequest(page, 'record', { transferId: m.transferId })).not.toBeNull();
      await storeRequest(page, 'close');
      const reopened = await storeRequest<RecoveryListing>(other, 'list');
      expect(reopened.cleaned).toBe(1);
      expect(reopened.checkpoints).toEqual([]);
      expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
    } finally {
      await other.close();
    }
  });
for (const offset of [-1, 0, 1])
  test(`source expiry is independent from receiver retention (${offset})`, async ({ page }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'prepare', { manifest: m });
    await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
    await storeRequest(page, 'close');
    await storeRequest(page, 'source', { manifest: m, expiresAt: NOW + 1000 });
    await storeRequest(page, 'clock', { now: NOW + 1000 + offset });
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect(result.sources.length).toBe(offset < 0 ? 1 : 0);
    expect(result.checkpoints[0]!.committedBytes).toBe(bytes.length);
    await storeRequest(page, 'forget-source', { transferId: m.transferId });
    expect(
      (await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }))
        .committedBytes,
    ).toBe(bytes.length);
    await storeRequest(page, 'source', { manifest: m, expiresAt: NOW + 10000 });
    await storeRequest(page, 'purge', { transferId: m.transferId });
    expect((await storeRequest<RecoveryListing>(page, 'list')).sources.length).toBe(1);
  });
