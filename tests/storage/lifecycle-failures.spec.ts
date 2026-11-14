import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TransferManifest } from '@meshdrop/protocol';
import type { Checkpoint, RecoveryListing } from '../../packages/storage/src/ReceiverStore';
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
    files: [{ fileId: randomUUID(), path: 'failure.bin', size: bytes.length, sha256: digest }],
  };
}
async function start(page: Page) {
  await page.goto('/foundation');
  await startStoreHarness(page, 'lifecycle-harness.worker.ts');
  await storeRequest(page, 'clock', { now: NOW });
}
test('a failed OPFS deletion retains its tombstone and the next successful scan completes it', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await storeRequest(page, 'fault', { stage: 'before-opfs-remove', error: 'NotAllowedError' });
  await expect(storeRequest(page, 'purge', { transferId: m.transferId })).rejects.toThrow();
  expect(
    (await storeRequest<{ state: string }>(page, 'record', { transferId: m.transferId })).state,
  ).toBe('deleting');
  await expect(storeRequest(page, 'reconcile', { transferId: m.transferId })).rejects.toThrow();
  const recovered = await storeRequest<RecoveryListing>(page, 'list');
  expect(recovered.cleaned).toBe(1);
  expect(recovered.checkpoints).toEqual([]);
  expect(await storeRequest(page, 'record', { transferId: m.transferId })).toBeNull();
});
for (const stage of ['capacity', 'before-metadata', 'get-directory', 'file-handle', 'sync-access'])
  test(`${stage} preparation failure leaves no committed bytes and explicit deletion remains safe`, async ({
    page,
  }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'fault', {
      stage,
      error: stage === 'before-metadata' ? 'QuotaExceededError' : 'NotAllowedError',
    });
    await expect(storeRequest(page, 'prepare', { manifest: m })).rejects.toThrow();
    await storeRequest(page, 'close');
    expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
    const result = await storeRequest<RecoveryListing>(page, 'list');
    expect(
      result.checkpoints.every((c) => c.committedBytes === 0 && c.record.receipt === null),
    ).toBe(true);
    await storeRequest(page, 'purge', { transferId: m.transferId });
    expect(await storeRequest(page, 'entries')).toEqual([]);
  });
for (const stage of ['write', 'flush', 'before-ledger'])
  test(`quota at ${stage} produces no commit eligibility and a revalidated retry commits exactly once`, async ({
    page,
  }) => {
    await start(page);
    const m = manifest();
    await storeRequest(page, 'prepare', { manifest: m });
    await storeRequest(page, 'fault', { stage, error: 'QuotaExceededError' });
    await expect(
      storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest }),
    ).rejects.toThrow();
    expect(await storeRequest(page, 'blocks', { transferId: m.transferId })).toEqual([]);
    await storeRequest(page, 'close');
    expect(
      (await storeRequest<Checkpoint>(page, 'open-write', { transferId: m.transferId }))
        .committedBytes,
    ).toBe(0);
    await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
    expect(
      (await storeRequest<unknown[]>(page, 'blocks', { transferId: m.transferId })).length,
    ).toBe(1);
    await storeRequest(page, 'close');
    const final = await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId });
    expect(final.committedBytes).toBe(bytes.length);
    expect(final.record.receipt).toBeNull();
    await storeRequest(page, 'purge', { transferId: m.transferId });
    expect(await storeRequest(page, 'entries')).toEqual([]);
  });
test('permission failure during reopen preserves ledger evidence for a later successful check', async ({
  page,
}) => {
  await start(page);
  const m = manifest();
  await storeRequest(page, 'prepare', { manifest: m });
  await storeRequest(page, 'commit', { fileId: m.files[0]!.fileId, bytes, digest });
  await storeRequest(page, 'close');
  await storeRequest(page, 'fault', { stage: 'sync-access', error: 'NotAllowedError' });
  await expect(storeRequest(page, 'reconcile', { transferId: m.transferId })).rejects.toThrow();
  expect((await storeRequest<unknown[]>(page, 'blocks', { transferId: m.transferId })).length).toBe(
    1,
  );
  expect(
    (await storeRequest<Checkpoint>(page, 'reconcile', { transferId: m.transferId }))
      .committedBytes,
  ).toBe(bytes.length);
});
for (const mutation of [
  'digest',
  'bytes',
  'file-id',
  'index',
  'truncated',
  'changed',
  'extra-tail',
  'manifest-digest',
])
  test(`ledger/OPFS disagreement ${mutation} cannot create false checkpoint or completion`, async ({
    page,
  }) => {
    await start(page);
    const m = manifest(),
      fileId = m.files[0]!.fileId;
    await storeRequest(page, 'prepare', { manifest: m });
    await storeRequest(page, 'commit', { fileId, bytes, digest });
    await storeRequest(page, 'close');
    const patch: Record<string, unknown> =
      mutation === 'digest'
        ? { digest: '0'.repeat(64) }
        : mutation === 'bytes'
          ? { bytes: 4 }
          : mutation === 'file-id'
            ? { fileId: randomUUID() }
            : { index: 1 };
    if (['digest', 'bytes', 'file-id', 'index'].includes(mutation))
      await storeRequest(page, 'patch-block', {
        transferId: m.transferId,
        fileId,
        index: 0,
        patch,
      });
    if (mutation === 'truncated')
      await storeRequest(page, 'truncate-file', { transferId: m.transferId, fileId, index: 1 });
    if (mutation === 'changed')
      await storeRequest(page, 'change-bytes', { transferId: m.transferId, fileId, bytes: [255] });
    if (mutation === 'extra-tail')
      await storeRequest(page, 'change-bytes', {
        transferId: m.transferId,
        fileId,
        bytes: [8, 9],
        index: bytes.length,
      });
    if (mutation === 'manifest-digest')
      await storeRequest(page, 'patch-record', {
        transferId: m.transferId,
        patch: { manifestDigest: '0'.repeat(64) },
      });
    const result = await storeRequest<RecoveryListing>(page, 'list');
    if (mutation === 'manifest-digest') {
      expect(result.checkpoints).toEqual([]);
      expect(result.unavailable.length).toBe(1);
    } else {
      expect(result.checkpoints[0]!.committedBytes).toBe(
        mutation === 'extra-tail' ? bytes.length : 0,
      );
      expect(result.checkpoints[0]!.record.receipt).toBeNull();
      expect(result.checkpoints[0]!.record.state).toBe('interrupted');
    }
  });
