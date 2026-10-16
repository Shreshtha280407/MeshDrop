import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, firefox, test, webkit } from '@playwright/test';

test.use({ trace: 'off', video: 'off' });
// Chromium is the owner. The remote peer uses a different browser engine.
for (const [name, browserType] of [
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test(`Chromium pairs with ${name} exchanges signed pings and verifies a file`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(65000);
    const profile =
      name === 'WebKit' ? await mkdtemp(join(tmpdir(), 'meshdrop-webkit-file-')) : null;
    const remote = profile ? null : await browserType.launch();
    const ownerBrowser =
      name === 'WebKit'
        ? await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
        : browser;
    const ownerContext = await ownerBrowser.newContext();
    const receiverContext = profile
      ? await browserType.launchPersistentContext(profile, {
          headless: true,
          baseURL: 'http://127.0.0.1:5173',
          acceptDownloads: true,
        })
      : await remote!.newContext({ baseURL: 'http://127.0.0.1:5173', acceptDownloads: true });
    const owner = await ownerContext.newPage();
    const receiver = await receiverContext.newPage();
    try {
      await owner.goto('/');
      await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
      await expect(owner.getByTestId('connection-state')).toHaveText('connected');
      await receiver.goto(
        await owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
      );
      await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
      await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
      for (const page of [owner, receiver])
        await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
      expect(await receiver.getByTestId('pairing-code').textContent()).toBe(
        await owner.getByTestId('pairing-code').textContent(),
      );
      await owner.getByRole('button', { name: 'Send signed ping', exact: true }).click();
      await expect(receiver.getByTestId('received-pings')).toHaveText('1');
      await expect(owner.getByTestId('received-pongs')).toHaveText('1');
      await receiver.getByRole('button', { name: 'Send signed ping', exact: true }).click();
      await expect(owner.getByTestId('received-pings')).toHaveText('1');
      await expect(receiver.getByTestId('received-pongs')).toHaveText('1');
      await receiver.screenshot({
        path: testInfo.outputPath(`phase-2-${name.toLowerCase()}.png`),
        fullPage: true,
      });
      const code = await owner.getByTestId('pairing-code').textContent();
      for (const page of [owner, receiver]) {
        await page.getByLabel('Code shown on the other device', { exact: true }).fill(code!);
        await page
          .getByLabel('I compared using a separate trusted channel', { exact: true })
          .check();
        await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
      }
      for (const page of [owner, receiver])
        await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
      const buffer = Buffer.alloc(17 * 1024, 89);
      await owner
        .getByLabel('Choose files to send', { exact: true })
        .setInputFiles({ name: 'cross-engine.bin', mimeType: 'application/octet-stream', buffer });
      await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      for (const page of [owner, receiver])
        await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 15000 });
      const digest = createHash('sha256').update(buffer).digest('hex');
      await expect(receiver.getByTestId('file-sha256')).toHaveText(digest);
      const downloadEvent = receiver.waitForEvent('download');
      await receiver.getByRole('button', { name: 'Save cross-engine.bin', exact: true }).click();
      const saved = testInfo.outputPath('cross-engine.bin');
      await (await downloadEvent).saveAs(saved);
      expect(await readFile(saved)).toEqual(buffer);
      await receiver.screenshot({
        path: testInfo.outputPath(`phase-3-${name.toLowerCase()}.png`),
        fullPage: true,
      });
      await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
      await expect(receiver.getByTestId('peer-state')).toHaveText('closed');
    } catch (error) {
      console.info(
        JSON.stringify({
          engine: name,
          owner: await owner
            .locator('[data-testid="peer-state"], [data-testid="connection-state"], [role="alert"]')
            .allTextContents()
            .catch(() => []),
          receiver: await receiver
            .locator('[data-testid="peer-state"], [data-testid="connection-state"], [role="alert"]')
            .allTextContents()
            .catch(() => []),
        }),
      );
      throw error;
    } finally {
      await ownerContext.close().catch(() => {});
      await receiverContext.close().catch(() => {});
      if (remote) await remote.close().catch(() => {});
      if (profile) await rm(profile, { recursive: true, force: true });
      if (ownerBrowser !== browser) await ownerBrowser.close();
    }
  });
}
