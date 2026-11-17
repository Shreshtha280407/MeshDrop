import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import axe from 'axe-core';
import type { A11yState } from '../fixtures/accessibility-contract';

export async function auditAccessibility(page: Page) {
  // The adapter's aggregation tab changes visibility during live transfers.
  // Run the maintained engine in the original document, without changing focus,
  // lifecycle handlers, rule coverage or the application's CSP.
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => {
    const engine = (window as unknown as { axe: typeof axe }).axe;
    return engine.run(document);
  });
  // Never print axe's raw HTML, input values, URL fragments or secret attributes.
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodeCount: nodes.length,
  }));
  expect(
    violations,
    'Accessibility rule IDs and counts only; raw DOM intentionally excluded',
  ).toEqual([]);
  console.info(
    'A11Y ' +
      JSON.stringify({
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
        incompleteRules: result.incomplete.map((x) => x.id).sort(),
      }),
  );
  return {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    incompleteRules: result.incomplete.map((x) => x.id),
  };
}

export async function fixture(page: Page, state: A11yState) {
  await page.goto(
    '/@fs' + fileURLToPath(new URL('../fixtures/accessibility.html', import.meta.url)),
  );
  await page.waitForFunction(() => Boolean(window.a11yFixture));
  await page.evaluate((state) => window.a11yFixture.state(state), state);
  await expect(page.getByTestId('transfer-state')).toHaveText(
    state === 'pairing'
      ? 'idle'
      : state === 'offer'
        ? 'negotiating'
        : state === 'verification'
          ? 'verifying'
          : state === 'completed'
            ? 'complete'
            : state === 'error'
              ? 'failed'
              : state === 'recovery'
                ? 'reconnecting'
                : state === 'storage-full'
                  ? 'paused'
                  : state,
  );
}

/** Traverse native focus order; no locator.focus() or mouse click substitutes. */
export async function tabTo(page: Page, target: Locator) {
  await page.bringToFront();
  await expect(target).toBeEnabled();
  const visited = new Set<string>();
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    visited.add(await page.evaluate(() => document.activeElement?.tagName ?? 'none'));
    // Firefox does not wrap forward tabbing from the document into its chrome.
    // Backtrack with Shift+Tab when the requested control precedes current focus.
    const forward = await target.evaluate((node) => {
      const active = document.activeElement;
      return (
        !active ||
        active === document.body ||
        Boolean(active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    });
    await page.keyboard.press(forward ? 'Tab' : 'Shift+Tab');
  }
  const element = await target.evaluate((node) => ({
    tag: node.tagName,
    id: node.id,
    tabIndex: (node as HTMLElement).tabIndex,
  }));
  throw new Error(
    `Keyboard traversal could not reach ${JSON.stringify(element)}. Visited element types: ${[...visited].join(', ')}.`,
  );
}
export async function activate(page: Page, target: Locator, key: 'Enter' | 'Space' = 'Enter') {
  await tabTo(page, target);
  await expect(target).toBeFocused();
  await page.keyboard.press(key);
}
