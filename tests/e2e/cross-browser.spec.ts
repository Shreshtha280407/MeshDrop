import { chromium, expect, firefox, test, webkit } from '@playwright/test';

test.use({ trace: 'off', video: 'off' });
// Chromium is the owner. The remote peer uses a different browser engine.
for (const [name, browserType] of [
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test(`Chromium pairs with ${name} and exchanges signed ping/pong`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(65000);
    const remote = await browserType.launch();
    const ownerBrowser =
      name === 'WebKit'
        ? await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
        : browser;
    const ownerContext = await ownerBrowser.newContext();
    const receiverContext = await remote.newContext({ baseURL: 'http://127.0.0.1:5173' });
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
      await remote.close().catch(() => {});
      if (ownerBrowser !== browser) await ownerBrowser.close();
    }
  });
}
