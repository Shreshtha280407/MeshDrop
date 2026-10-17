import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
test.use({ trace: 'off', video: 'off' });
test('reloaded receiver exports a rehashed saved file and owner can reselect the exact source', async ({
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[testInfo.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  const buffer = Buffer.alloc(17 * 1024, 41);
  const name = 'reopen.bin';
  try {
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
    await receiver.reload();
    await expect(receiver.getByTestId('saved-checkpoint')).toHaveCount(1);
    await expect(receiver.getByTestId('recovered-bytes')).toHaveText(String(buffer.length));
    await expect(receiver.getByTestId('saved-ranges')).toContainText('[[0,0]]');
    await expect(receiver.getByTestId('saved-checkpoint')).toContainText(
      'Completed receipt restored',
    );
    await receiver.getByRole('button', { name: `Export saved ${name}`, exact: true }).click();
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const output = testInfo.outputPath('reopened.bin');
    await (await downloading).saveAs(output);
    expect(
      createHash('sha256')
        .update(await readFile(output))
        .digest('hex'),
    ).toBe(createHash('sha256').update(buffer).digest('hex'));
    await receiver.screenshot({
      path: testInfo.outputPath('phase-4-reopened.png'),
      fullPage: true,
    });
    await owner.reload();
    await expect(owner.getByTestId('saved-source')).toHaveCount(1);
    await owner.getByLabel(`Reselect source ${name}`, { exact: true }).setInputFiles({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(buffer.length, 42),
    });
    await expect(owner.getByTestId('saved-transfers')).toContainText('could not finish');
    await owner
      .getByLabel(`Reselect source ${name}`, { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await expect(owner.getByTestId('saved-transfers')).toContainText(`Source verified: ${name}`);
    await receiver.getByRole('button', { name: `Delete saved ${name}`, exact: true }).click();
    await expect(receiver.getByTestId('saved-checkpoint')).toHaveCount(0);
    await receiver.reload();
    await expect(receiver.getByTestId('saved-transfers')).toContainText('No retained transfers');
  } finally {
    await close();
  }
});

test('a browser quota error pauses with prior committed bytes intact and storage retry completes', async ({
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[testInfo.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    // Test-only response patch: inject an actual DOM QuotaExceededError at the worker write boundary.
    // The application has no remotely enabled fault switch.
    await receiver.route('**/hash-storage.worker.ts*', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain('OpfsReceiverStore');
      await route.fulfill({
        response,
        body:
          body +
          '\nconst p4OriginalWrite=OpfsReceiverStore.prototype.writeBlock;let p4WriteCount=0;OpfsReceiverStore.prototype.writeBlock=async function(...args){if(++p4WriteCount===2)throw new DOMException("Test quota boundary","QuotaExceededError");return p4OriginalWrite.apply(this,args);};\n',
      });
    });
    const buffer = Buffer.alloc(2 * 1024 ** 2, 23);
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name: 'quota.bin', mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('paused');
      await expect(page.getByTestId('committed-bytes')).toHaveText(String(1024 ** 2));
    }
    await expect(receiver.getByRole('alert')).toContainText('storage is full');
    await receiver.getByRole('button', { name: 'Retry storage', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
      await expect(page.getByTestId('committed-bytes')).toHaveText(String(buffer.length));
    }
    await receiver.screenshot({
      path: testInfo.outputPath('phase-4-quota-retry.png'),
      fullPage: true,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await close();
  }
});
