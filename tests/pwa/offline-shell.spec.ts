import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pairForTransfer } from '../helpers/peer';
test('production shell preserves real verified file export offline while pairing stays unavailable', async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const pair = await pairForTransfer(browser, {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'allow',
  });
  const { owner, receiver } = pair,
    buffer = Buffer.alloc(5 * 1024 ** 2, 88),
    name = 'offline-verified.bin';
  try {
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('complete', { timeout: 30000 });
    await expect(receiver.getByTestId('offline-shell-status')).toContainText(
      'Static app shell cached',
    );
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await receiver.context().setOffline(true);
    await receiver.reload();
    await expect(receiver.getByTestId('pwa-panel')).toContainText('Offline shell only');
    await expect(receiver.getByTestId('saved-checkpoint')).toHaveCount(1);
    await receiver.getByRole('button', { name: `Export saved ${name}`, exact: true }).click();
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const path = info.outputPath(name);
    await (await downloading).saveAs(path);
    expect(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ).toBe(createHash('sha256').update(buffer).digest('hex'));
    await receiver.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(receiver.getByRole('alert')).toContainText('You are offline');
    const cached = await receiver.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith('meshdrop-shell-'));
      return (
        await Promise.all(
          names.map(async (name) =>
            (await (await caches.open(name)).keys()).map(
              (request) => new URL(request.url).pathname,
            ),
          ),
        )
      ).flat();
    });
    expect(cached.length).toBeGreaterThan(8);
    expect(
      cached.every(
        (path) =>
          path === '/' ||
          path.startsWith('/assets/') ||
          path.startsWith('/vendor/') ||
          /\.(png|svg|webmanifest)$/.test(path),
      ),
    ).toBe(true);
    expect(cached.some((path) => path.startsWith('/v1/') || path.includes(name))).toBe(false);
    await receiver.screenshot({
      path: info.outputPath('phase-7-offline-export.png'),
      fullPage: true,
    });
  } finally {
    await pair.close();
  }
});
test('manifest and PNG icons are installable assets with a manual iPhone path and no background promise', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    id: string;
    scope: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({ id: '/', scope: '/', start_url: '/', display: 'standalone' });
  for (const icon of manifest.icons) {
    const response = await request.get(icon.src);
    expect(response.ok()).toBe(true);
    const data = await response.body();
    expect(data.subarray(1, 4).toString()).toBe('PNG');
    const size = data.readUInt32BE(16);
    expect(icon.sizes).toBe(`${size}x${size}`);
  }
  expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  await expect(page.getByTestId('pwa-panel')).toContainText('Safari Share');
  await expect(page.getByTestId('pwa-panel')).toContainText(
    'does not guarantee background delivery',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    '/apple-touch-icon.png',
  );
});
test('a changed worker waits for explicit update rather than replacing a running shell automatically', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  await page.goto('/');
  await expect(page.getByTestId('offline-shell-status')).toContainText('Static app shell cached');
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  // Update requests bypass page routes. Change only this test build's ignored output,
  // served by the real preview server, then restore it even on failure.
  const workerPath = new URL('../../apps/web/dist/sw.js', import.meta.url);
  const script = await readFile(workerPath, 'utf8');
  try {
    await writeFile(
      workerPath,
      script.replace(/meshdrop-shell-([a-f0-9]+)/g, 'meshdrop-shell-updated-$1'),
    );
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: 'Apply app update', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Apply app update', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Apply app update', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Apply app update', exact: true }).click();
    await expect(page.getByTestId('offline-shell-status')).toContainText('Static app shell cached');
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('pwa-panel')).toContainText('Offline shell only');
  } finally {
    await writeFile(workerPath, script);
  }
});
