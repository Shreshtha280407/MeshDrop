import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
declare global {
  interface Window {
    task15Copied: string;
    task15Xss: number;
  }
}

test('hostile filenames never inject HTML and valid formula-like labels retain exact safe downloads and private diagnostics', async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  try {
    const pages = [pair.owner, pair.receiver];
    const initialNodes = await Promise.all(
      pages.map((page) =>
        page.evaluate(
          () => document.querySelectorAll('[onerror],[onload],script:not([src])').length,
        ),
      ),
    );
    for (const name of [
      '../../secret',
      '..\\..\\secret',
      '<script>globalThis.task15Xss=1</script>.txt',
      '"><img src=x onerror=globalThis.task15Xss=1>.txt',
      '<svg onload=globalThis.task15Xss=1>.txt',
      '\u202esecret.txt',
      'x'.repeat(241),
    ]) {
      await pair.owner
        .getByLabel('Choose files to send', { exact: true })
        .evaluate((element, name) => {
          const data = new DataTransfer(),
            file = new File(['test'], name);
          Object.defineProperty(file, 'webkitRelativePath', { value: name });
          data.items.add(file);
          (element as HTMLInputElement).files = data.files;
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }, name);
      await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await expect(pair.owner.getByRole('alert')).toBeVisible();
      await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('idle');
      for (const [index, page] of pages.entries())
        expect(
          await page.evaluate(
            (initial) =>
              !window.task15Xss &&
              document.querySelectorAll('[onerror],[onload],script:not([src])').length === initial,
            initialNodes[index]!,
          ),
        ).toBe(true);
    }
    const names = ['=HYPERLINK(1).html', '+cmd.txt', '@payload.txt'];
    const bytes = Buffer.from('<script>globalThis.task15Xss=1</script>synthetic file bytes');
    await pair.owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles(names.map((name) => ({ name, mimeType: 'text/html', buffer: bytes })));
    await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await pair.receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('complete');
    for (const [i, name] of names.entries()) {
      const pending = pair.receiver.waitForEvent('download');
      await pair.receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(name);
      const path = info.outputPath(`safe-${i}.bin`);
      await download.saveAs(path);
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    const pending = pair.receiver.waitForEvent('download');
    await pair.receiver
      .getByRole('button', { name: 'Export diagnostics CSV', exact: true })
      .click();
    const path = info.outputPath('diagnostics.csv');
    await (await pending).saveAs(path);
    const csv = await readFile(path, 'utf8');
    expect(names.some((name) => csv.includes(name))).toBe(false);
    expect(await pair.receiver.evaluate(() => !window.task15Xss)).toBe(true);
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});

test('copy and QR expose only the intended invitation, expiration errors are redacted and revocation clears peer authority', async ({
  browser,
}) => {
  test.setTimeout(60000);
  let ownerSecret = '';
  const pair = await pairForTransfer(
    browser,
    { baseURL: 'http://127.0.0.1:5173' },
    async (owner) => {
      await owner.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              window.task15Copied = value;
            },
          },
        });
      });
      owner.on('response', async (response) => {
        if (new URL(response.url()).pathname === '/v1/sessions' && response.status() === 201)
          ownerSecret = (await response.json()).ownerCapability;
      });
    },
  );
  const third = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  try {
    const invitation = await pair.owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await pair.owner.getByRole('button', { name: 'Copy invitation', exact: true }).click();
    expect(
      await pair.owner.evaluate((expected) => window.task15Copied === expected, invitation),
    ).toBe(true);
    await expect.poll(() => ownerSecret.length > 0).toBe(true);
    expect((await pair.owner.content()).includes(ownerSecret)).toBe(false);
    await pair.owner.getByRole('button', { name: 'Show private QR', exact: true }).click();
    const qr = pair.owner.getByTestId('invitation-qr');
    await expect(qr.locator('svg')).toHaveCount(1);
    expect(await qr.locator('script,foreignObject,a,image,use').count()).toBe(0);
    const page = await third.newPage(),
      canary = 'task15-error-private-' + 'Q'.repeat(32);
    await page.route('**/join', (route) =>
      route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'INVITE_EXPIRED',
          message: canary,
          retryable: false,
          requestId: crypto.randomUUID(),
        }),
      }),
    );
    await page.goto('/');
    await page.getByLabel('Join with an invitation', { exact: true }).fill(invitation);
    await page.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Invitation expired');
    expect((await page.getByRole('alert').textContent())!.includes(canary)).toBe(false);
    await page.evaluate((value) => {
      localStorage.setItem('ownerCapability', value);
      sessionStorage.setItem('roomCredentials', value);
    }, ownerSecret);
    await page.reload();
    await expect(page.getByTestId('live-room-state')).toHaveCount(0);
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await expect(pair.receiver.getByTestId('live-room-state')).toHaveText('closed');
    await expect(pair.receiver.getByTestId('connection-state')).toHaveText('disconnected');
    await expect(pair.owner.getByLabel('Private invitation link', { exact: true })).toHaveCount(0);
  } finally {
    await third.close();
    await pair.close();
  }
});
