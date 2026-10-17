import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import type { LocalReport } from '../../packages/network-intelligence/src';
import { parseJson } from '../../packages/network-intelligence/src';
export const diagnosticsUrl = `/@fs${fileURLToPath(new URL('../../packages/network-intelligence/src/index.ts', import.meta.url))}`;
export async function reports(page: Page): Promise<LocalReport[]> {
  return page.evaluate(async (url) => {
    const { MetricsStore } = await import(url);
    return new MetricsStore().list();
  }, diagnosticsUrl);
}
export async function exportReport(
  page: Page,
  info: TestInfo,
  format: 'json' | 'csv',
): Promise<string> {
  const downloading = page.waitForEvent('download');
  await page
    .getByRole('button', { name: `Export diagnostics ${format.toUpperCase()}`, exact: true })
    .click();
  const download = await downloading,
    path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  return readFile(path, 'utf8');
}
export async function jsonReport(page: Page, info: TestInfo): Promise<LocalReport> {
  return parseJson(await exportReport(page, info, 'json'));
}
export async function pauseAt(page: Page, target: number): Promise<void> {
  await page.evaluate((target) => {
    const observer = new MutationObserver(() => {
      const bytes = Number(
        document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0,
      );
      if (bytes >= target) {
        const button = [...document.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Pause transfer',
        );
        if (button) {
          button.click();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, target);
}
