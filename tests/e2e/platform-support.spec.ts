import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
for (const fault of ['crypto', 'rtc', 'worker'] as const) {
  test(`unsupported ${fault} has an explicit capability gate before session admission`, async ({
    page,
  }) => {
    await page.addInitScript((fault) => {
      if (fault === 'crypto') Object.defineProperty(crypto, 'subtle', { value: undefined });
      if (fault === 'rtc')
        Object.defineProperty(window, 'RTCPeerConnection', {
          value: class {
            constructor() {
              throw new DOMException('Denied', 'NotAllowedError');
            }
          },
        });
      if (fault === 'worker') {
        const Native = window.Worker;
        window.Worker = class extends Native {
          constructor(url: string | URL, options?: WorkerOptions) {
            if (String(url).includes('capability.worker'))
              throw new DOMException('Denied', 'SecurityError');
            super(url, options);
          }
        };
      }
    }, fault);
    await page.goto('/');
    await expect(page.getByTestId('platform-support')).toHaveAttribute(
      'data-send-support',
      'unsupported',
    );
    await expect(page.getByTestId('platform-support')).toHaveAttribute(
      'data-receive-support',
      'unsupported',
    );
    await expect(
      page.getByRole('button', { name: 'Create invitation', exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId('platform-support')).toContainText(
      fault === 'crypto' ? 'cryptography' : fault === 'rtc' ? 'WebRTC' : 'file worker',
    );
  });
}

test('a late successful old capability probe cannot replace a newer unsupported result', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        const capability = String(url).includes('capability.worker');
        if (capability && document.documentElement.dataset.task13DenyCapability === 'true')
          throw new DOMException('Latest probe denied', 'SecurityError');
        super(url, options);
        if (capability) {
          const setter = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage')!.set!;
          Object.defineProperty(this, 'onmessage', {
            set(handler: (event: MessageEvent) => void) {
              setter.call(this, (event: MessageEvent) => {
                document.documentElement.dataset.oldCapabilityQueued = 'true';
                document.addEventListener(
                  'task13-release-old-probe',
                  () => {
                    handler(event);
                    document.documentElement.dataset.oldCapabilityDelivered = 'true';
                  },
                  { once: true },
                );
              });
            },
          });
        }
      }
    };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-old-capability-queued', 'true');
  await expect(page.getByTestId('platform-support')).toHaveAttribute(
    'data-send-support',
    'checking',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.task13DenyCapability = 'true';
  });
  await page.getByRole('button', { name: 'Recheck device capabilities', exact: true }).click();
  await expect(page.getByTestId('platform-support')).toHaveAttribute(
    'data-send-support',
    'unsupported',
  );
  await page.evaluate(() => document.dispatchEvent(new Event('task13-release-old-probe')));
  await expect(page.locator('html')).toHaveAttribute('data-old-capability-delivered', 'true');
  await expect(page.getByTestId('platform-support')).toHaveAttribute(
    'data-send-support',
    'unsupported',
  );
  await expect(page.getByRole('button', { name: 'Create invitation', exact: true })).toBeDisabled();
});

test('failed browser export cannot change verified transfer completion; reloaded export remains independently hashable', async ({
  browser,
}, info) => {
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  const { owner, receiver } = pair;
  const bytes = Buffer.alloc(128 * 1024, 71),
    name = 'platform-export.bin';
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
    await receiver.evaluate(() => {
      HTMLAnchorElement.prototype.click = () => {
        throw new DOMException('Policy denied', 'NotAllowedError');
      };
    });
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    await expect(receiver.getByTestId('file-export-result')).toHaveAttribute(
      'data-export-status',
      'failed',
    );
    await expect(receiver.getByTestId('file-export-result')).toHaveAttribute(
      'data-native-export-verified',
      'false',
    );
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete');
    await expect(receiver.getByTestId('file-sha256')).toHaveText(digest);
    await receiver.reload();
    await expect(receiver.getByTestId('recovered-bytes')).toHaveText(String(bytes.length));
    await receiver.getByRole('button', { name: `Export saved ${name}`, exact: true }).click();
    const pending = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const path = info.outputPath('independent-export.bin');
    await (await pending).saveAs(path);
    expect(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ).toBe(digest);
    await expect(receiver.getByTestId('file-export-result')).toHaveAttribute(
      'data-export-status',
      'started',
    );
    await expect(receiver.getByTestId('file-export-result')).toHaveAttribute(
      'data-native-export-verified',
      'false',
    );
  } finally {
    await pair.close();
  }
});
