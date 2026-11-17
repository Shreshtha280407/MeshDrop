import { expect, test } from '@playwright/test';
import { auditAccessibility, fixture, activate, tabTo } from '../helpers/accessibility';
import { A11Y_STATES } from '../fixtures/accessibility-contract';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

for (const state of A11Y_STATES)
  test(`axe: ${state} panels, forms, diagnostics and install semantics`, async ({ page }) => {
    await fixture(page, state);
    await auditAccessibility(page);
  });

for (const colorScheme of ['light', 'dark'] as const)
  test(`actual application ${colorScheme} landmarks, labels, contrast and names`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(page.getByTestId('platform-support')).not.toContainText('Checking');
    await auditAccessibility(page);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Private invitation link' })).toHaveCount(0);
    const create = page.getByRole('button', { name: 'Create invitation', exact: true });
    await tabTo(page, create);
    const colors = await create.evaluate((node) => ({
      ring: getComputedStyle(node).outlineColor,
      surface: getComputedStyle(node.closest('section')!).backgroundColor,
    }));
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((n) => n / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    };
    const a = luminance(colors.ring),
      b = luminance(colors.surface);
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(3);
    const levels = await page
      .getByRole('heading')
      .evaluateAll((nodes) => nodes.map((x) => Number(x.tagName.slice(1))));
    expect(levels.every((level, i) => i === 0 || level <= levels[i - 1]! + 1)).toBe(true);
  });

test('progress retains committed bytes and announcements do not repeat byte ticks', async ({
  page,
}) => {
  await fixture(page, 'active');
  const progress = page.getByRole('progressbar', { name: 'Confirmed in receiver storage' });
  await expect(progress).toHaveAttribute('value', '1048576');
  await expect(progress).toHaveAttribute('aria-valuetext', /1.0 MiB of 2.0 MiB confirmed/);
  const initial = await page.getByTestId('transfer-announcement').textContent();
  await page.evaluate(() => window.a11yFixture.update({ committedBytes: 1572864 }));
  await expect(progress).toHaveAttribute('value', '1572864');
  await expect(page.getByTestId('transfer-announcement')).toHaveText(initial!);
  await expect(page.getByTestId('committed-bytes')).not.toHaveAttribute(
    'aria-live',
    /polite|assertive/,
  );
  await page.evaluate(() => window.a11yFixture.state('verification'));
  await expect(page.getByTestId('transfer-announcement')).toContainText(
    'Completion is not yet confirmed',
  );
});

test('closed advanced diagnostics leave no hidden keyboard stops', async ({ page }) => {
  await fixture(page, 'active');
  const summary = page.getByText('Advanced connection measurements', { exact: true });
  await activate(page, summary);
  await expect(page.getByLabel('Measurement report', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Chart measurement', { exact: true })).toBeHidden();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => {
        const active = document.activeElement;
        const closed = active?.closest('details:not([open])');
        // A closed details' own summary remains its visible keyboard toggle.
        return Boolean(closed && active !== closed.querySelector(':scope > summary'));
      }),
    ).toBe(false);
  }
});

test('keyboard pairing remains explicit and storage retry refuses duplicate actions', async ({
  page,
}) => {
  await fixture(page, 'pairing');
  const confirm = page.getByRole('button', { name: 'Confirm comparison', exact: true });
  await expect(confirm).toBeDisabled();
  await tabTo(page, page.getByLabel('Code shown on the other device', { exact: true }));
  await page.keyboard.type('ABCD-EFGH-JKLM-NPQR');
  await expect(confirm).toBeDisabled();
  await activate(
    page,
    page.getByLabel('I compared using a separate trusted channel', { exact: true }),
    'Space',
  );
  await activate(page, confirm);
  expect(await page.evaluate(() => window.a11yFixture.actions)).toContain('comparison');
  await page.evaluate(() => window.a11yFixture.state('storage-full'));
  await page.evaluate(() => window.a11yFixture.hold(true));
  const retry = page.getByRole('button', { name: 'Retry storage', exact: true });
  await activate(page, retry);
  await expect(retry).toBeDisabled();
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => window.a11yFixture.actions.filter((x) => x === 'storage').length),
  ).toBe(1);
  await page.evaluate(() => window.a11yFixture.hold(false));
  await expect(retry).toBeEnabled();
  await activate(page, page.getByRole('button', { name: 'Cancel transfer', exact: true }));
  expect(await page.evaluate(() => window.a11yFixture.actions)).toContain('cancel');
});

test('reduced motion, visible focus and forced colors preserve usable controls', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Synthetic camera denial', 'NotAllowedError');
      };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content', exact: true });
  await expect(skip).toBeFocused();
  expect(await skip.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      'button { transition: opacity 3s; animation: test-motion 3s infinite; } @keyframes test-motion { from { opacity: .5; } to { opacity: 1; } }';
    document.head.append(style);
  });
  const create = page.getByRole('button', { name: 'Create invitation', exact: true });
  expect(await create.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  expect(await create.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.emulateMedia({ forcedColors: 'active' });
  await activate(
    page,
    page.getByRole('button', { name: 'Scan invitation with camera', exact: true }),
  );
  await expect(page.getByRole('main')).toBeVisible();
});

test('responsive widths, long names, 200% text and zoom preserve core actions', async ({
  page,
}) => {
  await fixture(page, 'completed');
  for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `horizontal reflow at ${width}`,
    ).toBe(true);
    for (const name of ['Save transfer receipt', 'Clear transfer']) {
      const button = page.getByRole('button', { name, exact: true });
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
    document.documentElement.style.zoom = '2';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await activate(page, page.getByRole('button', { name: 'Save transfer receipt', exact: true }));
  await expect(
    page.getByRole('status').filter({ hasText: 'Receipt download requested' }),
  ).toBeVisible();
  await page.goto('/');
  for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const create = page.getByRole('button', { name: 'Create invitation', exact: true });
    const box = await create.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await activate(page, page.getByRole('button', { name: 'Create invitation', exact: true }));
  await expect(page.getByLabel('Private invitation link', { exact: true })).toBeVisible();
  await activate(page, page.getByRole('button', { name: 'Revoke room', exact: true }));
});
