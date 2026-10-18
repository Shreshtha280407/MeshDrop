import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { pairForTransfer, pairPages } from '../helpers/peer';
import { startStoreHarness, storeRequest } from '../helpers/storage';
import type { RecoveryListing } from '../../packages/storage/src/ReceiverStore';
test.use({ trace: 'off', video: 'off' });
async function compare(owner: Page, receiver: Page) {
  for (const page of [owner, receiver])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 40000 });
  const code = await owner.getByTestId('pairing-code').textContent();
  expect(await receiver.getByTestId('pairing-code').textContent()).toBe(code);
  for (const page of [owner, receiver]) {
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code!);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
  }
  for (const page of [owner, receiver])
    await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
}
async function pauseAt(page: Page, target: number) {
  await page.evaluate((target) => {
    const observer = new MutationObserver(() => {
      const bytes = Number(
        document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0,
      );
      if (bytes >= target) {
        const button = [...document.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Pause transfer',
        );
        if (button) {
          button.click();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, target);
}
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
for (const percent of [10, 50, 70, 95]) {
  test(`ICE restart resumes at ${percent}% using only missing blocks`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90000);
    const pair = await pairForTransfer(browser, {
      ...devices[testInfo.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
      baseURL: 'http://127.0.0.1:5173',
    });
    const { owner, receiver } = pair;
    const buffer = Buffer.alloc(20 * 1024 ** 2);
    for (let index = 0; index < buffer.length; index++)
      buffer[index] = (index * 31 + Math.floor(index / 1024 ** 2) * 17) % 251;
    const name = `resume-${percent}.bin`;
    try {
      await pauseAt(receiver, (buffer.length * percent) / 100);
      await owner
        .getByLabel('Choose files to send', { exact: true })
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      await expect(receiver.getByTestId('transfer-state')).toHaveText('paused', { timeout: 30000 });
      const committed = Number(await receiver.getByTestId('committed-bytes').textContent());
      await owner.getByRole('button', { name: 'Restart ICE', exact: true }).click();
      for (const page of [owner, receiver])
        await expect(page.getByTestId('peer-epoch')).toHaveText('2');
      await compare(owner, receiver);
      for (const page of [owner, receiver])
        await expect(page.getByTestId('transfer-state')).toHaveText('reconnecting');
      await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
      await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
      await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
      for (const page of [owner, receiver])
        await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 45000 });
      await expect(owner.getByTestId('reused-bytes')).toHaveText(String(committed));
      await expect(owner.getByTestId('attempt-bytes')).toHaveText(
        String(buffer.length - committed),
      );
      const download = receiver.waitForEvent('download');
      await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
      const output = testInfo.outputPath(name);
      await (await download).saveAs(output);
      expect(sha(await readFile(output))).toBe(sha(buffer));
      if (percent === 70)
        await receiver.screenshot({
          path: testInfo.outputPath('phase-5-resumed.png'),
          fullPage: true,
        });
      await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    } finally {
      await pair.close();
    }
  });
}
for (const damage of ['none', 'corrupt', 'forged'] as const)
  test(`receiver and sender reload with ${damage} checkpoint, renew admission and reject wrong source`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(100000);
    const pair = await pairForTransfer(browser, {
      ...devices[testInfo.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
      baseURL: 'http://127.0.0.1:5173',
    });
    const { owner, receiver } = pair,
      name = 'reloaded-resume.bin';
    const buffer = Buffer.alloc(5 * 1024 ** 2, 71);
    try {
      await pauseAt(receiver, 2 * 1024 ** 2);
      await owner
        .getByLabel('Choose files to send', { exact: true })
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
      const committed = Number(await receiver.getByTestId('committed-bytes').textContent());
      await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
      if (damage !== 'none') {
        await startStoreHarness(receiver);
        const checkpoint = (await storeRequest<RecoveryListing>(receiver, 'list')).checkpoints[0]!;
        await storeRequest(receiver, 'mutate', {
          transferId: checkpoint.record.transferId,
          fileId: checkpoint.manifest.files[0]!.fileId,
          index: 0,
        });
        if (damage === 'forged') {
          const forged = buffer.subarray(0, 1024 ** 2);
          forged[0] = 255;
          await storeRequest(receiver, 'forge-ledger', {
            transferId: checkpoint.record.transferId,
            fileId: checkpoint.manifest.files[0]!.fileId,
            index: 0,
            digest: sha(forged),
          });
          buffer[0] = 71; // Original source remains unchanged.
        }
        await receiver.evaluate(() => window.storageHarness.stop());
      }
      const expectedReuse = committed - (damage === 'none' ? 0 : 1024 ** 2);
      await owner.reload();
      await receiver.reload();
      await expect(receiver.getByTestId('recovered-bytes')).toHaveText(
        String(damage === 'corrupt' ? expectedReuse : committed),
      );
      await pairPages(owner, receiver);
      await owner.getByLabel(`Reselect source ${name}`, { exact: true }).setInputFiles({
        name,
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(buffer.length, 72),
      });
      await expect(owner.getByTestId('saved-transfers')).toContainText('could not finish');
      await expect(
        owner.getByRole('button', { name: `Prepare source ${name}`, exact: true }),
      ).toBeDisabled();
      // Both peers are online, but original source access has not been restored.
      await receiver.getByRole('button', { name: `Resume saved ${name}`, exact: true }).click();
      await expect(receiver.getByTestId('transfer-state')).toHaveText('reconnecting');
      await expect(receiver.getByRole('alert')).toContainText('exact original source');
      await owner
        .getByLabel(`Reselect source ${name}`, { exact: true })
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await expect(owner.getByTestId('saved-transfers')).toContainText('Source verified');
      await owner.getByRole('button', { name: `Prepare source ${name}`, exact: true }).click();
      await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
      await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
      for (const page of [owner, receiver])
        await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 45000 });
      await expect(owner.getByTestId('reused-bytes')).toHaveText(String(expectedReuse));
      await expect(owner.getByTestId('attempt-bytes')).toHaveText(
        String(buffer.length - expectedReuse),
      );
      const downloading = receiver.waitForEvent('download');
      await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
      const output = testInfo.outputPath(name);
      await (await downloading).saveAs(output);
      expect(sha(await readFile(output))).toBe(sha(buffer));
      await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    } finally {
      await pair.close();
    }
  });

declare global {
  interface Window {
    phaseFivePeers: RTCPeerConnection[];
  }
}
test('lost transport retries ICE first, falls back to a new connection and requires new comparison', async ({
  browser,
}, testInfo) => {
  test.setTimeout(100000);
  const pair = await pairForTransfer(
    browser,
    {
      ...devices[testInfo.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
      baseURL: 'http://127.0.0.1:5173',
    },
    async (owner) => {
      await owner.addInitScript(() => {
        window.phaseFivePeers = [];
        const Original = RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            window.phaseFivePeers.push(this);
          }
        };
      });
    },
  );
  const { owner, receiver } = pair;
  const modes: string[] = [];
  owner.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/connection'))
      modes.push((request.postDataJSON() as { mode: string }).mode);
  });
  try {
    const buffer = Buffer.alloc(5 * 1024 ** 2, 14),
      name = 'retry-source.bin';
    await pauseAt(receiver, 2 * 1024 ** 2);
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    const committed = Number(await receiver.getByTestId('committed-bytes').textContent());
    await owner.evaluate(() => window.phaseFivePeers.at(-1)!.close());
    await expect
      .poll(async () => Number(await owner.getByTestId('peer-epoch').textContent()), {
        timeout: 60000,
      })
      .toBeGreaterThan(1);
    for (const page of [owner, receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 60000 });
    expect(await owner.evaluate(() => window.phaseFivePeers.length)).toBeGreaterThan(1);
    expect(modes[0]).toBe('ice-restart');
    expect(modes).toContain('new-connection');
    for (const page of [owner, receiver])
      await expect(page.getByTestId('verification-state')).toHaveText('unverified');
    await compare(owner, receiver);
    await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
    await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
    await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 40000 });
    await expect(owner.getByTestId('reused-bytes')).toHaveText(String(committed));
    await expect(owner.getByTestId('attempt-bytes')).toHaveText(String(buffer.length - committed));
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
