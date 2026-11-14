import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TransferManifest } from '@meshdrop/protocol';
import type { RecoveryListing, SourceRecord } from '../../packages/storage/src/ReceiverStore';
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
    files: [{ fileId: randomUUID(), path: 'stress.bin', size: bytes.length, sha256: digest }],
  };
}
async function start(page: Page, worker = 'lifecycle-harness.worker.ts') {
  await page.goto('/foundation');
  await startStoreHarness(page, worker);
  await storeRequest(page, 'clock', { now: NOW });
}
async function prepare(page: Page, m = manifest()) {
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  return m;
}
test('explicit deletion can remove damaged metadata without clearing a healthy transfer', async ({
  page,
}) => {
  await start(page);
  const healthy = await prepare(page),
    damaged = await prepare(page);
  await storeRequest(page, 'patch-record', {
    transferId: damaged.transferId,
    patch: { retention: 'invalid-policy' },
  });
  await storeRequest(page, 'purge', { transferId: damaged.transferId });
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.checkpoints.map((c) => c.record.transferId)).toEqual([healthy.transferId]);
  expect(result.checkpoints[0]!.committedBytes).toBe(bytes.length);
  expect(result.unavailable).toEqual([]);
  expect(await storeRequest(page, 'record', { transferId: damaged.transferId })).toBeNull();
});
test('retention storm classifies exact cleaned, retained, unavailable and source counts', async ({
  page,
  context,
}) => {
  await start(page);
  const busyIds: string[] = [];
  for (const group of ['expired', 'discard', 'deleting', 'complete', 'interrupted', 'busy']) {
    for (let index = 0; index < 6; index++) {
      const m = manifest();
      await storeRequest(page, 'prepare', {
        manifest: m,
        retention: group === 'discard' ? 'discard' : '24-hours',
      });
      await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
      if (group === 'complete') {
        await storeRequest(page, 'finalize', { fileId: m.files[0]!.fileId });
        const record = await storeRequest<{ manifestDigest: string }>(page, 'record', {
          transferId: m.transferId,
        });
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
      }
      await storeRequest(page, 'close');
      if (group === 'expired')
        await storeRequest(page, 'patch-record', {
          transferId: m.transferId,
          patch: { expiresAt: NOW },
        });
      if (group === 'deleting')
        await storeRequest(page, 'patch-record', {
          transferId: m.transferId,
          patch: { state: 'deleting' },
        });
      if (group === 'busy') busyIds.push(m.transferId);
    }
  }
  for (const group of ['valid', 'expired', 'damaged'])
    for (let index = 0; index < 3; index++) {
      const m = manifest();
      await storeRequest(page, 'source', {
        manifest: m,
        expiresAt: group === 'expired' ? NOW : NOW + 10000,
      });
      if (group === 'damaged')
        await storeRequest(page, 'patch-source', {
          transferId: m.transferId,
          patch: { manifestDigest: '0'.repeat(64) },
        });
    }
  const owner = await context.newPage();
  try {
    await start(owner);
    for (const transferId of busyIds) await storeRequest(owner, 'lock', { transferId });
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect({
      cleaned: result.cleaned,
      checkpoints: result.checkpoints.length,
      receipts: result.checkpoints.filter((c) => c.record.receipt).length,
      unavailable: result.unavailable.length,
      sources: result.sources.length,
    }).toEqual({
      cleaned: 18,
      checkpoints: 12,
      receipts: 6,
      unavailable: 9,
      sources: 3,
    });
    for (const transferId of busyIds) await storeRequest(owner, 'unlock', { transferId });
    await storeRequest(page, 'clock', { now: NOW + 86400000 });
    const expired = await storeRequest<RecoveryListing>(page, 'list');
    expect({
      cleaned: expired.cleaned,
      checkpoints: expired.checkpoints.length,
      unavailable: expired.unavailable.length,
      sources: expired.sources.length,
    }).toEqual({
      cleaned: 18,
      checkpoints: 0,
      unavailable: 0,
      sources: 0,
    });
  } finally {
    await owner.close();
  }
});
test('active ownership blocks open, purge, duplicate prepare and listing until its tab terminates', async ({
  page,
  context,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  const other = await context.newPage();
  try {
    await start(other);
    for (const [operation, payload] of [
      ['reconcile', { transferId: m.transferId }],
      ['purge', { transferId: m.transferId }],
      ['prepare', { manifest: m }],
    ] as const)
      await expect(storeRequest(other, operation, payload)).rejects.toThrow('StorageFailure');
    const busy = await storeRequest<RecoveryListing>(other, 'list');
    expect(busy.cleaned).toBe(0);
    expect(busy.unavailable.length).toBe(1);
    await page.close();
    await expect
      .poll(async () => {
        try {
          return (await storeRequest<RecoveryListing>(other, 'list')).unavailable.length;
        } catch {
          return -1;
        }
      })
      .toBe(0);
    expect(
      (await storeRequest<RecoveryListing>(other, 'list')).checkpoints[0]!.committedBytes,
    ).toBe(0);
    await storeRequest(other, 'purge', { transferId: m.transferId });
    expect(await storeRequest(other, 'record', { transferId: m.transferId })).toBeNull();
  } finally {
    await other.close();
  }
});
test('one malformed receiver record cannot block valid checkpoint recovery and cleanup', async ({
  page,
}) => {
  await start(page);
  const healthy = await prepare(page),
    damaged = await prepare(page);
  await storeRequest(page, 'patch-record', {
    transferId: damaged.transferId,
    patch: { retention: 'invalid-policy' },
  });
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.checkpoints.map((c) => c.record.transferId)).toEqual([healthy.transferId]);
  expect(result.unavailable.map((c) => c.transferId)).toEqual([damaged.transferId]);
  expect((await storeRequest<{ name: string }[]>(page, 'entries')).length).toBe(2);
  await page.goto('/');
  await expect(page.getByTestId('saved-checkpoint')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete unavailable checkpoint', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Delete unavailable checkpoint', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('saved-checkpoint')).toHaveCount(1);
  await expect(page.getByTestId('saved-checkpoint')).toHaveAttribute(
    'data-transfer-id',
    healthy.transferId,
  );
});
test('one malformed source record cannot block other sources or proven orphan cleanup', async ({
  page,
}) => {
  await start(page);
  const healthy = manifest(),
    damaged = manifest();
  for (const m of [healthy, damaged])
    await storeRequest(page, 'source', { manifest: m, expiresAt: NOW + 10000 });
  await storeRequest(page, 'patch-source', {
    transferId: damaged.transferId,
    patch: { manifestDigest: 'invalid-digest' },
  });
  await storeRequest(page, 'orphan-directories', { names: [randomUUID()] });
  const result = await storeRequest<RecoveryListing>(page, 'list');
  expect(result.sources.map((c) => c.transferId)).toEqual([healthy.transferId]);
  expect(result.unavailable.map((c) => c.transferId)).toEqual([damaged.transferId]);
  expect(result.cleaned).toBe(1);
  await page.goto('/');
  await expect(page.getByTestId('saved-source')).toHaveCount(1);
  await page.getByRole('button', { name: 'Forget unavailable source', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Forget unavailable source', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('saved-source')).toHaveCount(1);
});
test('source expiry cleanup cannot delete a source renewed after its catalog snapshot', async ({
  page,
  context,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'source', { manifest: m, expiresAt: NOW });
  await storeRequest(page, 'arm', { stage: 'source-catalog' });
  await page.evaluate(() => {
    void window.storageHarness.request('list', null).catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe('source-catalog');
  const writer = await context.newPage();
  try {
    await start(writer);
    await storeRequest(writer, 'source', { manifest: m, expiresAt: NOW + 10000 });
    await storeRequest(page, 'release');
    await expect.poll(() => page.evaluate(() => window.storageHarness.completed)).toBe(5);
    expect((await storeRequest<SourceRecord[]>(writer, 'sources')).length).toBe(1);
    expect((await storeRequest<RecoveryListing>(writer, 'list')).sources[0]!.expiresAt).toBe(
      NOW + 10000,
    );
  } finally {
    await writer.close();
  }
});
for (const opfs of ['present', 'missing'])
  test(`loss of the transfer row collects orphan manifests and blocks when OPFS is ${opfs}`, async ({
    page,
  }) => {
    await start(page);
    const m = await prepare(page);
    if (opfs === 'missing') await storeRequest(page, 'remove-opfs', { transferId: m.transferId });
    await storeRequest(page, 'delete-record', { transferId: m.transferId });
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect(result.checkpoints).toEqual([]);
    expect(result.cleaned).toBe(1);
    expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
    await expect(storeRequest(page, 'manifest', { transferId: m.transferId })).rejects.toThrow();
    expect(await storeRequest(page, 'entries')).toEqual([]);
  });
test('two production sender workers enforce the existing source-manifest limit atomically', async ({
  page,
  context,
}) => {
  await start(page);
  for (let index = 0; index < 32; index++)
    await storeRequest(page, 'source', { manifest: manifest(), expiresAt: NOW + 10000 + index });
  const first = await context.newPage(),
    second = await context.newPage();
  try {
    for (const client of [first, second]) {
      await start(client, 'source-race.worker.ts');
      await storeRequest(client, 'arm-sources');
    }
    for (const client of [first, second])
      await client.evaluate((manifest) => {
        void window.storageHarness
          .request('remember-sources', { manifest, retention: '24-hours' })
          .catch(() => {});
      }, manifest());
    for (const client of [first, second])
      await expect
        .poll(() => client.evaluate(() => window.storageHarness.stage))
        .toBe('source-append');
    await Promise.all([storeRequest(first, 'release'), storeRequest(second, 'release')]);
    for (const client of [first, second])
      await expect.poll(() => client.evaluate(() => window.storageHarness.completed)).toBe(4);
    expect((await storeRequest<SourceRecord[]>(page, 'sources')).length).toBe(32);
  } finally {
    await first.close();
    await second.close();
  }
});
test('100 orphan candidates preserve unrelated names, UUID files and locked directories', async ({
  page,
  context,
}) => {
  await start(page);
  const ids = Array.from({ length: 100 }, () => randomUUID());
  const protectedFile = randomUUID();
  await storeRequest(page, 'orphan-directories', {
    names: [...ids, 'unrelated-name', 'invalid-uuid'],
  });
  await storeRequest(page, 'orphan-file', { names: [protectedFile] });
  const owner = await context.newPage();
  try {
    await start(owner);
    for (const transferId of ids.slice(0, 2)) await storeRequest(owner, 'lock', { transferId });
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect(result.cleaned).toBe(98);
    const remaining = await storeRequest<{ name: string; kind: string }[]>(page, 'entries');
    expect(remaining.map((v) => v.name).sort()).toEqual(
      [...ids.slice(0, 2), protectedFile, 'unrelated-name', 'invalid-uuid'].sort(),
    );
    for (const transferId of ids.slice(0, 2)) await storeRequest(owner, 'unlock', { transferId });
    expect((await storeRequest<RecoveryListing>(page, 'list')).cleaned).toBe(2);
    expect(
      (await storeRequest<{ name: string }[]>(page, 'entries')).map((v) => v.name).sort(),
    ).toEqual([protectedFile, 'unrelated-name', 'invalid-uuid'].sort());
  } finally {
    await owner.close();
  }
});
test('orphan collection rechecks a newly prepared transfer after taking its lock', async ({
  page,
  context,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'orphan-directories', { names: [m.transferId] });
  await storeRequest(page, 'arm', { stage: 'orphan-catalog' });
  await page.evaluate(() => {
    void window.storageHarness.request('list', null).catch(() => {});
  });
  await expect.poll(() => page.evaluate(() => window.storageHarness.stage)).toBe('orphan-catalog');
  const writer = await context.newPage();
  try {
    await start(writer);
    await prepare(writer, m);
    await storeRequest(page, 'release');
    await expect.poll(() => page.evaluate(() => window.storageHarness.completed)).toBe(5);
    expect(
      (await storeRequest<RecoveryListing>(writer, 'list')).checkpoints[0]!.committedBytes,
    ).toBe(bytes.length);
  } finally {
    await writer.close();
  }
});
