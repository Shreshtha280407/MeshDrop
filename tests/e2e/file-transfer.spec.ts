import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';

test.use({ trace: 'off', video: 'off' });

test('0 B, 1 B and 17 KiB files are accepted, storage-confirmed, downloaded and hashed exactly', async ({
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[test.info().project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  const errors: string[] = [];
  for (const page of [owner, receiver]) page.on('pageerror', (error) => errors.push(error.message));
  const fixtures = [
    Buffer.alloc(0),
    Buffer.from([153]),
    Buffer.from(Array.from({ length: 17 * 1024 }, (_, index) => index % 251)),
  ];
  try {
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(
      fixtures.map((buffer, index) => ({
        name: `fixture-${index}.bin`,
        mimeType: 'application/octet-stream',
        buffer,
      })),
    );
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('negotiating', {
      timeout: 15000,
    });
    for (const page of [owner, receiver])
      await expect(page.getByTestId('committed-bytes')).toHaveText('0');
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 30000 });
    const total = fixtures.reduce((sum, bytes) => sum + bytes.length, 0);
    for (const page of [owner, receiver])
      await expect(page.getByTestId('committed-bytes')).toHaveText(String(total));
    for (const [index, buffer] of fixtures.entries()) {
      const downloadEvent = receiver.waitForEvent('download');
      await receiver
        .getByRole('button', { name: `Save fixture-${index}.bin`, exact: true })
        .click();
      const download = await downloadEvent;
      const destination = testInfo.outputPath(`downloaded-${index}.bin`);
      await download.saveAs(destination);
      const actual = await readFile(destination);
      expect(actual).toEqual(buffer);
      const digest = createHash('sha256').update(buffer).digest('hex');
      await expect(receiver.getByTestId('file-sha256').nth(index)).toHaveText(digest);
    }
    await receiver.screenshot({
      path: testInfo.outputPath('phase-3-received.png'),
      fullPage: true,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete');
    await receiver.getByRole('button', { name: 'Clear transfer', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('idle');
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test('declining an offer sends no file bytes and allows a fresh transfer after clearing', async ({
  browser,
}) => {
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[test.info().project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'decline.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([1, 2]),
    });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('negotiating');
    await receiver.getByRole('button', { name: 'Decline files', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('cancelled');
      await expect(page.getByTestId('committed-bytes')).toHaveText('0');
      await page.getByRole('button', { name: 'Clear transfer', exact: true }).click();
      await expect(page.getByTestId('transfer-state')).toHaveText('idle');
    }
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'retry.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([3]),
    });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await close();
  }
});

test('a corrupted block fails before a storage ACK and cannot show completion', async ({
  browser,
}) => {
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[test.info().project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    // Fault injection after the authenticated frame arrives but before worker validation.
    await receiver.evaluate(() => {
      const post = Worker.prototype.postMessage as (
        this: Worker,
        message: unknown,
        transfer: Transferable[],
      ) => void;
      Worker.prototype.postMessage = function (
        this: Worker,
        message: { operation?: string; payload?: { bytes?: Uint8Array } },
        transfer: Transferable[],
      ) {
        if (message.operation === 'commit' && message.payload?.bytes?.length)
          message.payload.bytes[0] = message.payload.bytes[0]! ^ 1;
        post.call(this, message, transfer);
      } as typeof Worker.prototype.postMessage;
    });
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'corrupt.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(17 * 1024, 77),
    });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('failed');
    await expect(owner.getByTestId('transfer-state')).toHaveText('cancelled');
    for (const page of [owner, receiver])
      await expect(page.getByTestId('committed-bytes')).toHaveText('0');
    await expect(receiver.getByRole('alert')).toContainText('No block acknowledgment');
    await expect(
      receiver.getByRole('button', { name: 'Save corrupt.bin', exact: true }),
    ).toHaveCount(0);
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await close();
  }
});

test('pause settles the in-flight block, resume works, and cancel cannot become complete', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const { owner, receiver, close } = await pairForTransfer(browser, {
    ...devices[test.info().project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  try {
    await receiver.evaluate(() => {
      const post = Worker.prototype.postMessage as (
        this: Worker,
        message: unknown,
        transfer: Transferable[],
      ) => void;
      Worker.prototype.postMessage = function (
        this: Worker,
        message: { operation?: string },
        transfer: Transferable[],
      ) {
        if (message.operation === 'commit')
          setTimeout(() => post.call(this, message, transfer), 100);
        else post.call(this, message, transfer);
      } as typeof Worker.prototype.postMessage;
    });
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'pause.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(16 * 1024 ** 2, 13),
    });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Pause transfer', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('paused');
    // Allow the single in-flight block to finish; then confirmed bytes must stop.
    await expect
      .poll(async () => {
        const first = await owner.getByTestId('committed-bytes').textContent();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return first === (await owner.getByTestId('committed-bytes').textContent());
      })
      .toBe(true);
    const pausedBytes = Number(await owner.getByTestId('committed-bytes').textContent());
    expect(pausedBytes).toBeLessThan(16 * 1024 ** 2);
    await receiver.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    await expect
      .poll(async () => Number(await owner.getByTestId('committed-bytes').textContent()))
      .toBeGreaterThan(pausedBytes);
    await owner.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('cancelled');
    await expect(receiver.getByRole('button', { name: 'Save pause.bin', exact: true })).toHaveCount(
      0,
    );
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await close();
  }
});
