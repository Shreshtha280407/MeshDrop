import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, expect, test } from '@playwright/test';
import { activate, auditAccessibility, tabTo } from '../helpers/accessibility';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
declare global {
  interface Window {
    task17Copied: string;
    task17AckHeld: boolean;
    task17ReleaseAck(): void;
    task17DenyCamera(): void;
    task17CameraRequests: number;
    task17InstallCount: number;
  }
}
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function keyboardContext(
  browser: Browser,
  options: BrowserContextOptions,
  persistent = false,
) {
  if (!persistent) {
    const context = await browser.newContext(options);
    return { context, close: () => context.close() };
  }
  const profile = await mkdtemp(join(tmpdir(), 'meshdrop-task17-webkit-'));
  try {
    const context = await browser
      .browserType()
      .launchPersistentContext(profile, { ...options, headless: true });
    return {
      context,
      close: async () => {
        await context.close();
        await rm(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
async function compare(page: Page, code: string) {
  await tabTo(page, page.getByLabel('Code shown on the other device', { exact: true }));
  await page.keyboard.insertText(code);
  await activate(
    page,
    page.getByLabel('I compared using a separate trusted channel', { exact: true }),
    'Space',
  );
  await activate(page, button(page, 'Confirm comparison'));
}
test('keyboard-only real room, pairing, decline, pause/resume, verified export and saved deletion', async ({
  browser,
}, info) => {
  test.setTimeout(120000);
  const device =
    info.project.name === 'mobile-chromium'
      ? 'Pixel 7'
      : info.project.name === 'firefox'
        ? 'Desktop Firefox'
        : info.project.name === 'webkit'
          ? 'Desktop Safari'
          : 'Desktop Chrome';
  const suffix = randomUUID().replaceAll('-', '').slice(0, 24).match(/.{4}/g)!.join(':');
  const options = {
    ...devices[device]!,
    baseURL: 'http://127.0.0.1:5173',
    acceptDownloads: true,
    extraHTTPHeaders: { 'CF-Connecting-IP': '2001:db8:' + suffix },
  };
  // Retain the existing WebKit engine test boundary: a persistent receiver and
  // Chromium sender with local mDNS hiding disabled. This is not native Safari.
  const sender =
    info.project.name === 'webkit'
      ? await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
      : browser;
  const a = await keyboardContext(
      sender,
      info.project.name === 'webkit' ? { ...options, ...devices['Desktop Chrome']! } : options,
    ),
    b = await keyboardContext(browser, options, info.project.name === 'webkit');
  const owner = await a.context.newPage(),
    receiver = await b.context.newPage();
  const errors: string[] = [];
  for (const page of [owner, receiver])
    page.on('pageerror', () => errors.push('Unhandled application error'));
  try {
    await owner.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            window.task17Copied = value;
          },
        },
      });
    });
    await owner.goto('/');
    await activate(owner, button(owner, 'Create invitation'));
    await expect(
      owner.getByRole('heading', { name: 'A room for two.', exact: true }),
    ).toBeFocused();
    await auditAccessibility(owner);
    const invitation = await owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await activate(owner, button(owner, 'Copy invitation'));
    expect(
      await owner.evaluate(
        () =>
          window.task17Copied ===
          document.querySelector<HTMLInputElement>('#private-invitation')!.value,
      ),
    ).toBe(true);
    await expect(owner.getByTestId('copy-status')).toContainText('Invitation copied');
    await activate(owner, button(owner, 'Show private QR'));
    await expect(
      owner.getByRole('img', { name: 'Private room invitation QR code', exact: true }),
    ).toBeVisible();
    await auditAccessibility(owner);
    await activate(owner, button(owner, 'Hide private QR'), 'Space');
    await tabTo(owner, owner.getByLabel('Private invitation link', { exact: true }));
    await receiver.goto('/');
    const join = receiver.getByLabel('Join with an invitation', { exact: true });
    await tabTo(receiver, join);
    await receiver.keyboard.insertText(invitation);
    await activate(receiver, button(receiver, 'Request to join'));
    await expect(receiver.getByTestId('admission-state')).toHaveText('pending');
    await expect(owner.getByLabel('Private invitation link', { exact: true })).toBeFocused();
    await auditAccessibility(owner);
    await auditAccessibility(receiver);
    await activate(owner, button(owner, 'Approve receiver'));
    for (const page of [owner, receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('connected');
    const code = (await owner.getByTestId('pairing-code').textContent())!;
    await compare(owner, code);
    await compare(receiver, code);
    for (const page of [owner, receiver])
      await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
    await auditAccessibility(receiver);
    const bytes = Buffer.alloc(4 * 1024 ** 2, 71),
      name = 'keyboard-verified.bin';
    const selection = owner.getByLabel('Choose files to send', { exact: true });
    await selection.setInputFiles(
      Array.from({ length: 17 }, (_, index) => ({
        name: `bounded-${index}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from('synthetic'),
      })),
    );
    await expect(button(owner, 'Offer files')).toBeDisabled();
    await expect(
      owner.getByRole('list', { name: 'Selected files' }).getByRole('listitem'),
    ).toHaveCount(16);
    // Synthetic file selection avoids claiming certification of a native OS picker.
    await tabTo(owner, owner.getByLabel('Choose files to send', { exact: true }));
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await expect(owner.getByRole('list', { name: 'Selected files' })).toContainText(name);
    await activate(owner, button(owner, 'Offer files'));
    await activate(receiver, button(receiver, 'Decline files'));
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('cancelled');
      await activate(page, button(page, 'Clear transfer'));
    }
    await receiver.evaluate(() => {
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      let held = false;
      crypto.subtle.sign = async (...args: Parameters<SubtleCrypto['sign']>) => {
        if (!held && new TextDecoder().decode(args[2]).includes('"type":"BLOCK_ACK"')) {
          held = true;
          window.task17AckHeld = true;
          await new Promise<void>((resolve) => {
            window.task17ReleaseAck = resolve;
          });
        }
        return sign(...args);
      };
    });
    await tabTo(owner, owner.getByLabel('Choose files to send', { exact: true }));
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await activate(owner, button(owner, 'Offer files'));
    await auditAccessibility(receiver);
    await activate(receiver, button(receiver, 'Accept files'));
    await expect.poll(() => receiver.evaluate(() => window.task17AckHeld)).toBe(true);
    await auditAccessibility(receiver);
    await activate(receiver, button(receiver, 'Pause transfer'));
    await receiver.evaluate(() => window.task17ReleaseAck());
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    await auditAccessibility(receiver);
    await activate(receiver, button(receiver, 'Resume transfer'));
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
    await auditAccessibility(receiver);
    const downloaded = receiver.waitForEvent('download');
    await activate(receiver, button(receiver, `Save ${name}`));
    const saved = info.outputPath(name);
    await (await downloaded).saveAs(saved);
    expect(
      createHash('sha256')
        .update(await readFile(saved))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'));
    const receipt = owner.waitForEvent('download');
    await activate(owner, button(owner, 'Save transfer receipt'));
    const receiptPath = info.outputPath('receipt.json');
    await (await receipt).saveAs(receiptPath);
    expect(JSON.parse(await readFile(receiptPath, 'utf8')).files[0].sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    await activate(owner, button(owner, 'Revoke room'));
    await receiver.reload();
    await expect(receiver.getByTestId('saved-checkpoint')).toHaveCount(1);
    await auditAccessibility(receiver);
    await activate(receiver, button(receiver, `Export saved ${name}`));
    await expect(receiver.getByTestId('saved-transfers')).toContainText('Verified file prepared');
    await activate(receiver, button(receiver, `Delete saved ${name}`));
    await expect(receiver.getByTestId('saved-checkpoint')).toHaveCount(0);
    await expect(
      receiver.getByRole('heading', { name: 'Saved transfers', exact: true }),
    ).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await receiver.evaluate(() => window.task17ReleaseAck?.()).catch(() => {});
    await a.close();
    await b.close();
    if (sender !== browser) await sender.close();
  }
});

test('keyboard errors, manual camera fallback, stop focus and optional install feedback', async ({
  page: suppliedPage,
  browser,
}, info) => {
  const owned =
    info.project.name === 'webkit'
      ? await keyboardContext(
          browser,
          { ...devices['Desktop Safari']!, baseURL: 'http://127.0.0.1:5173' },
          true,
        )
      : null;
  const page = owned ? await owned.context.newPage() : suppliedPage;
  try {
    await page.goto('/');
    // WebKit exposes the secure-context media object after document creation.
    await page.evaluate(() => {
      window.task17CameraRequests = 0;
      if (navigator.mediaDevices) {
        const controlledGetUserMedia = () =>
          new Promise((_resolve, reject) => {
            window.task17CameraRequests++;
            window.task17DenyCamera = () =>
              reject(new DOMException('Synthetic permission denial', 'NotAllowedError'));
          });
        const media = navigator.mediaDevices;
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: new Proxy(media, {
            get(target, key) {
              if (key === 'getUserMedia') return controlledGetUserMedia;
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        });
      }
    });
    const join = page.getByLabel('Join with an invitation', { exact: true });
    await tabTo(page, join);
    await page.keyboard.insertText('invalid-synthetic-invitation');
    await activate(page, button(page, 'Request to join'));
    await expect(join).toHaveAttribute('aria-invalid', 'true');
    await expect(join).toHaveAccessibleDescription(/Invalid invitation/);
    await auditAccessibility(page);
    await activate(page, button(page, 'Scan invitation with camera'));
    await expect.poll(() => page.evaluate(() => window.task17CameraRequests)).toBe(1);
    await activate(page, button(page, 'Stop camera'));
    await expect(button(page, 'Scan invitation with camera')).toBeFocused();
    await page.evaluate(() => window.task17DenyCamera?.());
    await activate(page, button(page, 'Scan invitation with camera'));
    await expect.poll(() => page.evaluate(() => window.task17CameraRequests)).toBe(2);
    await page.evaluate(() => window.task17DenyCamera());
    await expect(page.getByTestId('camera-status')).toContainText('paste the invitation link');
    await expect(join).toBeEnabled();
    // Synthetic install event tests the application's keyboard/UI contract, not native install.
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      window.task17InstallCount = 0;
      Object.assign(event, {
        prompt: async () => {
          window.task17InstallCount++;
        },
        userChoice: Promise.resolve({ outcome: 'dismissed' }),
      });
      window.dispatchEvent(event);
    });
    await activate(page, button(page, 'Install MeshDrop'));
    await expect(page.getByTestId('offline-shell-status')).toContainText('Install dismissed');
    expect(await page.evaluate(() => window.task17InstallCount)).toBe(1);
    await expect(
      page.getByRole('heading', { name: 'A home-screen shortcut.', exact: true }),
    ).toBeFocused();
  } finally {
    await owned?.close();
  }
});

test('keyboard rejection and clipboard denial retain clear next steps without granting access', async ({
  browser,
}, info) => {
  const a = await keyboardContext(browser, { baseURL: 'http://127.0.0.1:5173' }),
    b = await keyboardContext(
      browser,
      { baseURL: 'http://127.0.0.1:5173' },
      info.project.name === 'webkit',
    );
  try {
    const owner = await a.context.newPage(),
      receiver = await b.context.newPage();
    await owner.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new DOMException('Synthetic clipboard denial', 'NotAllowedError');
          },
        },
      });
    });
    await owner.goto('/');
    await activate(owner, button(owner, 'Create invitation'));
    await activate(owner, button(owner, 'Copy invitation'));
    await expect(owner.getByTestId('copy-status')).toContainText('copy it manually');
    const invitation = await owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await receiver.goto('/');
    await tabTo(receiver, receiver.getByLabel('Join with an invitation', { exact: true }));
    await receiver.keyboard.insertText(invitation);
    await activate(receiver, button(receiver, 'Request to join'));
    await activate(owner, button(owner, 'Reject receiver'));
    await expect(receiver.getByTestId('admission-state')).toHaveText('rejected');
    await expect(receiver.getByTestId('room-announcement')).toContainText(
      'Ask for a new invitation',
    );
    await expect(button(receiver, 'Send signed ping')).toBeDisabled();
    await auditAccessibility(receiver);
    await activate(receiver, button(receiver, 'Start again'));
    await expect(receiver.getByLabel('Join with an invitation', { exact: true })).toBeVisible();
    await activate(owner, button(owner, 'Revoke room'));
  } finally {
    await a.close();
    await b.close();
  }
});
