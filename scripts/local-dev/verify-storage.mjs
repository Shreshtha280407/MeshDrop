/* global MutationObserver, document, window */
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers/promises';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { pairPages } from '../../tests/helpers/peer.ts';
import { startStoreHarness, storeRequest } from '../../tests/helpers/storage.ts';

const artifactRoot = resolve('.meshdrop-artifacts/phase-4-storage');
await mkdir(artifactRoot, { recursive: true });
const directory = await mkdtemp(join(artifactRoot, 'run-'));
const source = join(directory, 'checkpoint-384mib.bin');
const baseURL = process.env.MESHDROP_TEST_URL ?? 'http://127.0.0.1:5173';
const blockBytes = 1024 ** 2,
  totalBytes = 384 * blockBytes,
  targetBytes = 300 * blockBytes;
const report = {
  phase: 'P4',
  startedAt: new Date().toISOString(),
  pass: false,
  directory,
  totalBytes,
  targetBytes,
  browserFlag:
    '--disable-features=WebRtcHideLocalIpsWithMdns (isolated test processes only; application defaults unchanged)',
  scope:
    'Actual WebRTC transfer between isolated owner and receiver contexts; disk-backed persistent receiver profile; all transfer browser processes closed; fresh receiver process; checkpoint rehash without any additional file transfer.',
};
let ownerContext, receiverContext;
try {
  const fixture = await open(source, 'wx');
  try {
    const block = Buffer.alloc(blockBytes);
    for (let index = 0; index < 384; index++) {
      for (let at = 0; at < block.length; at++) block[at] = (at * 29 + index * 13) % 251;
      let written = 0;
      while (written < block.length)
        written += (await fixture.write(block, written, block.length - written)).bytesWritten;
    }
  } finally {
    await fixture.close();
  }
  const launch = (profile) =>
    chromium.launchPersistentContext(join(directory, profile), {
      headless: true,
      baseURL,
      viewport: { width: 1440, height: 1080 },
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
  receiverContext = await launch('receiver-profile');
  ownerContext = await receiverContext
    .browser()
    .newContext({ baseURL, viewport: { width: 1440, height: 1080 } });
  report.browser = ownerContext.browser()?.version();
  const owner = await ownerContext.newPage(),
    receiver = receiverContext.pages()[0];
  await pairPages(owner, receiver);
  await receiver.evaluate((target) => {
    const observer = new MutationObserver(() => {
      const bytes = Number(
        document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0,
      );
      if (bytes >= target) {
        const button = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Pause transfer',
        );
        if (button) {
          button.click();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, targetBytes);
  await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(source);
  await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
  await receiver
    .getByRole('button', { name: 'Accept files', exact: true })
    .click({ timeout: 300000 });
  for (const page of [owner, receiver])
    await expect(page.getByTestId('transfer-state')).toHaveText('paused', { timeout: 300000 });
  await expect
    .poll(async () => Number(await receiver.getByTestId('committed-bytes').textContent()), {
      timeout: 300000,
    })
    .toBeGreaterThanOrEqual(targetBytes);
  await setTimeout(1500);
  const confirmed = Number(await receiver.getByTestId('committed-bytes').textContent());
  expect(confirmed).toBeGreaterThanOrEqual(targetBytes);
  expect(confirmed).toBeLessThan(totalBytes);
  expect(confirmed % blockBytes).toBe(0);
  await expect(owner.getByTestId('committed-bytes')).toHaveText(String(confirmed));
  await receiver.screenshot({ path: join(directory, 'before-close.png'), fullPage: true });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source, {
    start: 0,
    end: confirmed - 1,
    highWaterMark: blockBytes,
  }))
    hash.update(chunk);
  report.expectedPrefixSha256 = hash.digest('hex');
  report.confirmedBeforeClose = confirmed;
  // Close the isolated owner context and the whole persistent browser process.
  await ownerContext.close();
  ownerContext = null;
  await receiverContext.close();
  receiverContext = null;
  report.closedAllTransferBrowserProcesses = true;
  receiverContext = await launch('receiver-profile');
  const reopened = receiverContext.pages()[0];
  let signalingRequests = 0;
  reopened.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/v1/')) signalingRequests++;
  });
  const reopenStarted = Date.now();
  await reopened.goto('/');
  await expect(reopened.getByTestId('saved-checkpoint')).toHaveCount(1, { timeout: 300000 });
  await expect(reopened.getByTestId('recovered-bytes')).toHaveText(String(confirmed));
  await expect(reopened.getByTestId('saved-checkpoint')).toContainText('Interrupted checkpoint');
  await expect(reopened.getByTestId('connection-state')).toHaveCount(0);
  await expect(
    reopened.getByRole('button', { name: 'Export saved checkpoint-384mib.bin', exact: true }),
  ).toHaveCount(0);
  const transferId = await reopened
    .getByTestId('saved-checkpoint')
    .getAttribute('data-transfer-id');
  report.restoredBytes = Number(await reopened.getByTestId('recovered-bytes').textContent());
  report.rangesText = await reopened.getByTestId('saved-ranges').textContent();
  report.reopenMs = Date.now() - reopenStarted;
  await reopened.screenshot({ path: join(directory, 'after-reopen.png'), fullPage: true });
  await startStoreHarness(reopened);
  const checkpoint = await storeRequest(reopened, 'reconcile', { transferId });
  const actual = await storeRequest(reopened, 'prefix-digest', {
    transferId,
    fileId: checkpoint.manifest.files[0].fileId,
  });
  report.recoveredPrefixSha256 = actual.sha256;
  report.recoveredPhysicalBytes = actual.bytes;
  expect(actual.bytes).toBe(confirmed);
  expect(actual.sha256).toBe(report.expectedPrefixSha256);
  expect(checkpoint.files[0].ranges).toEqual([[0, confirmed / blockBytes - 1]]);
  expect(checkpoint.record.receipt).toBeNull();
  await reopened.evaluate(() => window.storageHarness.stop());
  report.signalingRequestsAfterReopen = signalingRequests;
  expect(signalingRequests).toBe(0);
  report.checkpoint = {
    schemaVersion: checkpoint.record.schemaVersion,
    transferId,
    manifestDigest: checkpoint.record.manifestDigest,
    blockSize: checkpoint.record.blockSize,
    verifiedRanges: checkpoint.files[0].ranges,
    storageKey: checkpoint.record.storageKey,
    updatedAt: checkpoint.record.updatedAt,
    expiresAt: checkpoint.record.expiresAt,
    retention: checkpoint.record.retention,
  };
  await reopened
    .getByRole('button', { name: 'Delete saved checkpoint-384mib.bin', exact: true })
    .click();
  await expect(reopened.getByTestId('saved-checkpoint')).toHaveCount(0);
  await reopened.reload();
  await expect(reopened.getByTestId('saved-transfers')).toContainText('No retained transfers');
  report.explicitPurgeSurvivedReload = true;
  report.pass = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Storage verification failed.';
  throw error;
} finally {
  await ownerContext?.close().catch(() => {});
  await receiverContext?.close().catch(() => {});
  report.completedAt = new Date().toISOString();
  await writeFile(join(directory, 'phase-4-storage.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(artifactRoot, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.pass) {
    await rm(source, { force: true });
    for (const profile of ['owner-profile', 'receiver-profile'])
      await rm(join(directory, profile), { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      pass: report.pass,
      confirmedBytes: report.confirmedBeforeClose,
      report: join(directory, 'phase-4-storage.json'),
    }),
  );
}
