import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
import { pauseAt } from '../helpers/diagnostics';
import type { Page } from '@playwright/test';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
declare global {
  interface Window {
    p7Share: { active: boolean; name: string; bytes: number };
    p7Save: number[];
    p7PickerActive: boolean;
    p7CancelShare: boolean;
    p7CameraTracks: MediaStreamTrack[];
  }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function compare(owner: Page, receiver: Page) {
  for (const page of [owner, receiver])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 60000 });
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
test('verified files open native export APIs within the click and preserve independent download bytes', async ({
  browser,
}, info) => {
  const pair = await pairForTransfer(
    browser,
    {
      ...devices[info.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
      baseURL: 'http://127.0.0.1:5173',
    },
    async (_owner, receiver) => {
      await receiver.addInitScript(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async ({ files }: ShareData) => {
            if (window.p7CancelShare) throw new DOMException('Cancelled', 'AbortError');
            window.p7Share = {
              active: navigator.userActivation.isActive,
              name: files![0]!.name,
              bytes: files![0]!.size,
            };
          },
        });
        Object.defineProperty(window, 'showSaveFilePicker', {
          configurable: true,
          value: async () => {
            window.p7PickerActive = navigator.userActivation.isActive;
            window.p7Save = [];
            return {
              createWritable: async () =>
                new WritableStream<Uint8Array>({
                  write(chunk) {
                    window.p7Save.push(...chunk);
                  },
                }),
            };
          },
        });
      });
    },
  );
  const { owner, receiver } = pair,
    name = 'mobile-verified.txt',
    buffer = Buffer.alloc(17 * 1024, 93);
  try {
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'text/plain', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete');
    await receiver
      .getByRole('button', { name: `Share or save to Files: ${name}`, exact: true })
      .click();
    expect(await receiver.evaluate(() => window.p7Share)).toEqual({
      active: true,
      name,
      bytes: buffer.length,
    });
    await expect(receiver.getByTestId('file-export-result')).toContainText('Check Files');
    await receiver
      .getByRole('button', { name: `Choose save location for ${name}`, exact: true })
      .click();
    await expect(receiver.getByTestId('file-export-result')).toContainText('finished writing');
    expect(await receiver.evaluate(() => window.p7PickerActive)).toBe(true);
    expect(Buffer.from(await receiver.evaluate(() => window.p7Save))).toEqual(buffer);
    await receiver.evaluate(() => {
      window.p7CancelShare = true;
    });
    await receiver
      .getByRole('button', { name: `Share or save to Files: ${name}`, exact: true })
      .click();
    await expect(receiver.getByTestId('file-export-result')).toContainText('Sharing cancelled');
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const path = info.outputPath(name);
    await (await downloading).saveAs(path);
    expect(hash(await readFile(path))).toBe(hash(buffer));
    await receiver.screenshot({
      path: info.outputPath('phase-7-save-controls.png'),
      fullPage: true,
    });
    await receiver.setViewportSize({ width: 390, height: 844 });
    await receiver.emulateMedia({ colorScheme: 'dark' });
    expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await receiver.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    ).toBe('rgb(16, 27, 24)');
    const saveBox = await receiver
      .getByRole('button', { name: `Save ${name}`, exact: true })
      .boundingBox();
    expect(saveBox!.height).toBeGreaterThanOrEqual(44);
    const plot = receiver.locator('.timeline-plot');
    await expect(plot).toHaveAttribute('tabindex', '0');
    expect(await plot.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    await receiver.screenshot({ path: info.outputPath('phase-7-dark-mobile.png'), fullPage: true });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
test('quota preflight blocks consent before file traffic and explains the selected receive strategy', async ({
  browser,
}) => {
  const pair = await pairForTransfer(
    browser,
    { baseURL: 'http://127.0.0.1:5173' },
    async (_owner, receiver) => {
      await receiver.addInitScript(() => {
        navigator.storage.estimate = async () => ({ quota: 1024, usage: 1024 });
      });
    },
  );
  try {
    await pair.owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'quota.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('measured quota'),
    });
    await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await expect(pair.receiver.getByTestId('quota-preflight')).toContainText('0 B estimated free');
    await expect(
      pair.receiver.getByRole('button', { name: 'Accept files', exact: true }),
    ).toBeDisabled();
    await expect(pair.receiver.getByTestId('receive-strategy')).toContainText('unavailable');
    await expect(pair.receiver.getByTestId('committed-bytes')).toHaveText('0');
    await pair.receiver.getByRole('button', { name: 'Decline files', exact: true }).click();
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
test('local QR decoding fills a private invitation and stops all camera tracks', async ({
  browser,
}) => {
  const a = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' }),
    b = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  const owner = await a.newPage(),
    receiver = await b.newPage();
  try {
    await owner.goto('/');
    await receiver.goto('/');
    // Public deterministic fixtures exercise detector failures at fractional scaling.
    // They carry no authority for a real room and never leave this browser.
    const decoded = await receiver.evaluate(async (modulePath) => {
      const { loadQrLibrary } = await import(modulePath);
      const library = await loadQrLibrary();
      let successes = 0;
      for (const seed of [8, 13]) {
        let state = seed;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const capability = Array.from({ length: 43 }, () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return alphabet[state >>> 26];
        }).join('');
        const value = `${location.origin}/#room=123e4567-e89b-42d3-a456-426614174000&invite=${capability}`;
        const svg = new library.BrowserQRCodeSvgWriter().write(value, 280, 280);
        svg.setAttribute('viewBox', '0 0 280 280');
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const drawing = canvas.getContext('2d')!;
        drawing.fillStyle = 'white';
        drawing.fillRect(0, 0, 360, 360);
        drawing.drawImage(image, 20, 20, 320, 320);
        if (new library.BrowserQRCodeReader().decodeFromCanvas(canvas).getText() === value)
          successes++;
      }
      return successes;
    }, '/src/features/mobile/QrInvitation.tsx');
    expect(decoded).toBe(2);
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    const invitation = await owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await owner.getByRole('button', { name: 'Show private QR', exact: true }).click();
    const svg = owner.getByTestId('invitation-qr').locator('svg');
    await expect(svg).toHaveCount(1);
    const source = await svg.evaluate((element) => new XMLSerializer().serializeToString(element));
    await receiver.evaluate(async (source) => {
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(source)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 360;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'white';
      context.fillRect(0, 0, 360, 360);
      context.drawImage(image, 20, 20, 320, 320);
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const stream = canvas.captureStream(10);
          window.p7CameraTracks = stream.getTracks();
          const timer = setInterval(() => {
            context.drawImage(canvas, 0, 0);
          }, 100);
          stream.getTracks()[0]!.addEventListener('ended', () => clearInterval(timer));
          return stream;
        },
      });
    }, source);
    await receiver
      .getByRole('button', { name: 'Scan invitation with camera', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await receiver.getByLabel('Join with an invitation', { exact: true }).inputValue()) ===
          invitation,
        { timeout: 15000, message: 'The local scanner should fill the exact invitation.' },
      )
      .toBe(true);
    expect(
      await receiver.evaluate(() =>
        window.p7CameraTracks.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    await expect(receiver.getByTestId('camera-status')).toContainText('Invitation scanned');
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(receiver.getByTestId('admission-state')).toHaveText('pending');
    await owner.getByRole('button', { name: 'Hide private QR', exact: true }).click();
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await a.close();
    await b.close();
  }
});
test('denied camera permission keeps manual invitation entry usable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Scan invitation with camera', exact: true }).click();
  await expect(page.getByTestId('camera-status')).toContainText('Camera scanning could not start');
  await expect(page.getByLabel('Join with an invitation', { exact: true })).toBeEditable();
});
test('an offer accepted while the sender is hidden pauses until an explicit foreground resume', async ({
  browser,
}) => {
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  try {
    await pair.owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: 'hidden-offer.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(8 * 1024 ** 2, 38),
    });
    await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await pair.owner.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pair.receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [pair.owner, pair.receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('paused');
    await pair.owner.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pair.owner.getByTestId('transfer-state')).toHaveText('paused');
    await pair.owner.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('complete', {
      timeout: 30000,
    });
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
test('visibility pauses an actual transfer and returning never auto-resumes it', async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  const { owner, receiver } = pair,
    buffer = Buffer.alloc(12 * 1024 ** 2, 61),
    name = 'foreground.bin';
  try {
    await receiver.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (
          Number(document.querySelector('[data-testid="committed-bytes"]')?.textContent) >=
          2 * 1024 ** 2
        ) {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    await receiver.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    await expect(receiver.getByTestId('lifecycle-message')).toContainText(
      'pause requires Resume transfer',
    );
    await receiver.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete', { timeout: 30000 });
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const output = info.outputPath(name);
    await (await downloading).saveAs(output);
    expect(hash(await readFile(output))).toBe(hash(buffer));
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
test('offline suspension retains committed data and recovers only after fresh comparison', async ({
  browser,
}) => {
  test.setTimeout(100000);
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  const { owner, receiver } = pair,
    buffer = Buffer.alloc(8 * 1024 ** 2, 19);
  try {
    await pauseAt(receiver, 2 * 1024 ** 2);
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name: 'suspended.bin', mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    const committed = Number(await receiver.getByTestId('committed-bytes').textContent());
    await receiver.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    await expect(receiver.getByTestId('transfer-state')).toHaveText('reconnecting');
    await receiver.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await compare(owner, receiver);
    expect(Number(await owner.getByTestId('peer-epoch').textContent())).toBeGreaterThan(1);
    await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
    await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
    await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete', { timeout: 30000 });
    await expect(owner.getByTestId('reused-bytes')).toHaveText(String(committed));
    await expect(receiver.getByTestId('file-sha256')).toHaveText(hash(buffer));
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
