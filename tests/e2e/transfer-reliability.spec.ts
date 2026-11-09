import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
import { B, generatedRange, nodeFileHash } from '../helpers/streaming-transfer';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const options = (info: TestInfo) => ({
  ...devices[info.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
  baseURL: 'http://127.0.0.1:5173',
});
async function fixture(size: number) {
  const directory = await mkdtemp(join(tmpdir(), 'meshdrop-task12-browser-'));
  const path = join(directory, 'generated.bin');
  const file = await open(path, 'wx');
  const hash = createHash('sha256');
  try {
    for (let at = 0; at < size; at += B) {
      const bytes = generatedRange(at, Math.min(B, size - at));
      hash.update(bytes);
      await file.write(bytes);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    path,
    sha256: hash.digest('hex'),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
async function pauseAt(page: Page, target: number) {
  await page.evaluate((target) => {
    const observer = new MutationObserver(() => {
      if (
        Number(document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0) < target
      )
        return;
      const button = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Pause transfer',
      );
      if (button) {
        button.click();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, target);
}
async function compareAgain(owner: Page, receiver: Page) {
  for (const page of [owner, receiver])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 40000 });
  const code = await owner.getByTestId('pairing-code').textContent();
  expect(await receiver.getByTestId('pairing-code').textContent()).toBe(code);
  for (const page of [owner, receiver]) {
    await expect(page.getByTestId('verification-state')).toHaveText('unverified');
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code!);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
  }
  for (const page of [owner, receiver])
    await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
}
async function offer(owner: Page, receiver: Page, path: string) {
  await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(path);
  await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
  await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
}
async function verifiedDownload(
  owner: Page,
  receiver: Page,
  size: number,
  expectedHash: string,
  info: TestInfo,
) {
  for (const page of [owner, receiver]) {
    await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 60000 });
    await expect(page.getByTestId('committed-bytes')).toHaveText(String(size));
    await expect(page.getByTestId('file-sha256')).toHaveText(expectedHash);
  }
  const downloading = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Save generated.bin', exact: true }).click();
  const path = info.outputPath('verified.bin');
  await (await downloading).saveAs(path);
  expect(await nodeFileHash(path)).toBe(expectedHash);
  const peaks = await owner.locator('.transfer-panel').evaluate((element) => ({
    buffer: Number(element.getAttribute('data-buffer-peak')),
    block: Number(element.getAttribute('data-block-peak')),
  }));
  expect(peaks.buffer).toBeLessThanOrEqual(512 * 1024);
  expect(peaks.block).toBeLessThanOrEqual(B);
  await writeFile(
    info.outputPath('task12-metrics.json'),
    JSON.stringify({
      scope: 'local-browser-webrtc-opfs',
      bytes: size,
      sha256: expectedHash,
      peakBufferedBytes: peaks.buffer,
      peakBlockBytes: peaks.block,
      verified: true,
    }),
  );
}

test('64 MiB file uses real WebRTC and OPFS, pauses, resumes and independently verifies its export', async ({
  browser,
}, info) => {
  test.setTimeout(120000);
  const source = await fixture(64 * B);
  const pair = await pairForTransfer(browser, options(info));
  const errors: string[] = [];
  for (const page of [pair.owner, pair.receiver])
    page.on('pageerror', (error) => errors.push(error.name));
  try {
    await pauseAt(pair.receiver, 8 * B);
    await offer(pair.owner, pair.receiver, source.path);
    for (const page of [pair.owner, pair.receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('paused', { timeout: 30000 });
    const before = Number(await pair.owner.getByTestId('committed-bytes').textContent());
    expect(before).toBeLessThan(64 * B);
    await pair.receiver.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    await verifiedDownload(pair.owner, pair.receiver, 64 * B, source.sha256, info);
    expect(errors).toEqual([]);
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
    await source.close();
  }
});

for (const loss of ['connection-loss', 'freeze'] as const)
  test(`a local ${loss} resumes only after a new epoch, fresh comparison and checkpoint reconciliation`, async ({
    browser,
  }, info) => {
    test.setTimeout(120000);
    const source = await fixture(16 * B);
    const pair = await pairForTransfer(browser, options(info), async (owner) => {
      await owner.addInitScript(() => {
        const peers: RTCPeerConnection[] = [];
        const Original = RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(configuration?: RTCConfiguration) {
            super(configuration);
            peers.push(this);
          }
        };
        Object.assign(window, { task12LoseConnection: () => peers.at(-1)!.close() });
      });
    });
    try {
      await pauseAt(pair.receiver, 4 * B);
      await offer(pair.owner, pair.receiver, source.path);
      await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('paused');
      const committed = Number(await pair.receiver.getByTestId('committed-bytes').textContent());
      const oldEpoch = Number(await pair.owner.getByTestId('peer-epoch').textContent());
      if (loss === 'connection-loss')
        await pair.owner.evaluate(() =>
          (window as unknown as { task12LoseConnection(): void }).task12LoseConnection(),
        );
      else {
        await pair.owner.evaluate(() => document.dispatchEvent(new Event('freeze')));
        await expect(pair.owner.getByTestId('transfer-state')).toHaveText('reconnecting');
        await expect(pair.owner.getByTestId('committed-bytes')).toHaveText(String(committed));
        await pair.owner.evaluate(() => document.dispatchEvent(new Event('resume')));
      }
      await expect
        .poll(async () => Number(await pair.owner.getByTestId('peer-epoch').textContent()), {
          timeout: 60000,
        })
        .toBeGreaterThan(oldEpoch);
      await compareAgain(pair.owner, pair.receiver);
      expect(await pair.receiver.getByTestId('peer-epoch').textContent()).toBe(
        await pair.owner.getByTestId('peer-epoch').textContent(),
      );
      await pair.owner
        .getByRole('button', { name: 'Prepare original source', exact: true })
        .click();
      await expect(pair.owner.getByTestId('resume-state')).toContainText('Source ready');
      await pair.receiver
        .getByRole('button', { name: 'Resume saved transfer', exact: true })
        .click();
      await verifiedDownload(pair.owner, pair.receiver, 16 * B, source.sha256, info);
      await expect(pair.owner.getByTestId('reused-bytes')).toHaveText(String(committed));
      await expect(pair.owner.getByTestId('attempt-bytes')).toHaveText(String(16 * B - committed));
      await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    } finally {
      await pair.close();
      await source.close();
    }
  });

test('cancel during actual receipt signing prevents queued success from reaching either peer', async ({
  browser,
}, info) => {
  test.setTimeout(60000);
  const source = await fixture(B);
  const pair = await pairForTransfer(browser, options(info));
  try {
    await pair.owner.evaluate(() => {
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      Object.assign(window, { task12AckWaiting: false });
      crypto.subtle.sign = async (...args: Parameters<SubtleCrypto['sign']>) => {
        const data = args[2];
        const text = new TextDecoder().decode(data);
        if (text.includes('"type":"RECEIPT_ACK"')) {
          Object.assign(window, { task12AckWaiting: true });
          await new Promise<void>((resolve) =>
            Object.assign(window, { task12ReleaseAck: resolve }),
          );
        }
        return sign(...args);
      };
    });
    await offer(pair.owner, pair.receiver, source.path);
    await expect
      .poll(() =>
        pair.owner.evaluate(
          () => (window as unknown as { task12AckWaiting: boolean }).task12AckWaiting,
        ),
      )
      .toBe(true);
    await pair.owner.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
    await expect(pair.owner.getByTestId('transfer-state')).toHaveText('cancelled');
    await pair.owner.evaluate(() =>
      (window as unknown as { task12ReleaseAck(): void }).task12ReleaseAck(),
    );
    for (const page of [pair.owner, pair.receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('cancelled');
      await expect(
        page.getByRole('button', { name: 'Save transfer receipt', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Save generated.bin', exact: true }),
      ).toHaveCount(0);
    }
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.owner
      .evaluate(() => (window as unknown as { task12ReleaseAck?: () => void }).task12ReleaseAck?.())
      .catch(() => {});
    await pair.close();
    await source.close();
  }
});

test('a receiver storage write failure surfaces an error without acknowledging failed bytes or offering export', async ({
  browser,
}, info) => {
  test.setTimeout(60000);
  const source = await fixture(3 * B);
  const pair = await pairForTransfer(browser, options(info));
  try {
    await pair.receiver.route('**/hash-storage.worker.ts*', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      expect(body).toContain('OpfsReceiverStore');
      await route.fulfill({
        response,
        body:
          body +
          '\nconst task12Write=OpfsReceiverStore.prototype.writeBlock;let task12Writes=0;OpfsReceiverStore.prototype.writeBlock=async function(...args){if(++task12Writes===2)throw new Error("Synthetic write failure");return task12Write.apply(this,args);};\n',
      });
    });
    await offer(pair.owner, pair.receiver, source.path);
    await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('failed');
    await expect(pair.owner.getByTestId('transfer-state')).toHaveText('cancelled');
    for (const page of [pair.owner, pair.receiver]) {
      await expect(page.getByTestId('committed-bytes')).toHaveText(String(B));
      await expect(
        page.getByRole('button', { name: 'Save generated.bin', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Save transfer receipt', exact: true }),
      ).toHaveCount(0);
    }
    await expect(pair.receiver.getByRole('alert')).toContainText('No block acknowledgment');
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
    await source.close();
  }
});
