import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { activate, auditAccessibility } from '../helpers/accessibility';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('built shell accessibility and keyboard updates preserve the open-room restriction', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto('/');
  await expect(page.getByTestId('offline-shell-status')).toContainText('Static app shell cached');
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await auditAccessibility(page);
  const path = new URL('../../apps/web/dist/sw.js', import.meta.url);
  const original = await readFile(path, 'utf8');
  try {
    await writeFile(
      path,
      original.replace(/meshdrop-shell-([a-f0-9]+)/g, 'meshdrop-shell-task17-$1'),
    );
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    const update = page.getByRole('button', { name: 'Apply app update', exact: true });
    await expect(update).toBeVisible();
    await expect(update).toHaveAccessibleDescription(/Reloading loses in-memory room access/);
    await activate(page, page.getByRole('button', { name: 'Create invitation', exact: true }));
    await expect(update).toBeDisabled();
    await auditAccessibility(page);
    await activate(page, page.getByRole('button', { name: 'Revoke room', exact: true }));
    await expect(update).toBeEnabled();
    // The old page already says "cached". Wait for the actual update reload,
    // rather than treating that unchanged status as evidence of a new document.
    const reloaded = page.waitForEvent('domcontentloaded');
    await activate(page, update);
    await reloaded;
    await expect(page.getByTestId('offline-shell-status')).toContainText('Static app shell cached');
    await auditAccessibility(page);
  } finally {
    await writeFile(path, original);
  }
});
