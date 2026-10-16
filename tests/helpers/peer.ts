import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

export async function pairPages(owner: Page, receiver: Page): Promise<void> {
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

export async function pairForTransfer(
  browser: Browser,
  contextOptions: BrowserContextOptions = {},
): Promise<{ owner: Page; receiver: Page; close(): Promise<void> }> {
  // Unrelated local cases get independent rate buckets; the two peers still share one address.
  // Cloudflare supplies/overwrites this header at the public edge. These are documentation IPs.
  const suffix = randomUUID().replaceAll('-', '').slice(0, 24).match(/.{4}/g)!.join(':');
  const options = {
    ...contextOptions,
    acceptDownloads: true,
    extraHTTPHeaders: {
      'CF-Connecting-IP': `2001:db8:${suffix}`,
      ...contextOptions.extraHTTPHeaders,
    },
  };
  const a = await browser.newContext(options);
  const b = await browser.newContext(options);
  const owner = await a.newPage();
  const receiver = await b.newPage();
  try {
    await pairPages(owner, receiver);
  } catch (error) {
    await a.close();
    await b.close();
    throw error;
  }
  return {
    owner,
    receiver,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}
