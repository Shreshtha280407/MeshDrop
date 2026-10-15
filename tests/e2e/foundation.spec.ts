import { expect, test } from '@playwright/test';

test('two isolated browser contexts drive the same validated synthetic lifecycle', async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const candidate = await browser.newContext();
  try {
    for (const context of [owner, candidate]) {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/');
      await expect(page.getByText('It does not create a room', { exact: false })).toBeVisible();
      await expect(page.getByTestId('room-state')).toHaveText('created');
      await page.getByRole('button', { name: 'Approve peer', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Illegal transition');
      await expect(page.getByTestId('room-state')).toHaveText('created');
      await page.getByRole('button', { name: 'Request peer', exact: true }).click();
      await expect(page.getByTestId('room-state')).toHaveText('pending');
      await page.getByRole('button', { name: 'Approve peer', exact: true }).click();
      await expect(page.getByTestId('room-state')).toHaveText('approved');
      await page.getByRole('button', { name: 'Close demo room', exact: true }).click();
      await expect(page.getByTestId('room-state')).toHaveText('closed');
      await page.getByRole('button', { name: 'Reset', exact: true }).click();
      await page.getByRole('button', { name: 'Run demo lifecycle', exact: true }).click();
      await expect(page.getByTestId('transfer-state')).toHaveText('complete');
      await expect(page.getByTestId('peer-state')).toHaveText('closed');
      expect(errors).toEqual([]);
    }
  } finally {
    await owner.close();
    await candidate.close();
  }
});

test('shell reports observed capabilities and fits the viewport', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Capabilities, observed.' })).toBeVisible();
  const observed = await page.evaluate(() => ({
    rtc: typeof RTCPeerConnection !== 'undefined',
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  await expect(page.locator('dl > div').filter({ hasText: 'WebRTC API' }).locator('dd')).toHaveText(
    observed.rtc ? 'Available' : 'Unavailable',
  );
  expect(observed.overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('foundation.png'), fullPage: true });
});
