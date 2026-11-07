import { chromium, expect } from '@playwright/test';
import { isolation, CAPABILITIES } from './contract';
import type { Isolation } from './contract';

/** Existing Playwright stack; no traces, screenshots, credentials or test bypass.
 * Paused admission deliberately prevents a new paired transfer. */
export async function previewBrowser(pins: Isolation) {
  const { target: t } = isolation(pins.target, pins.deny);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: t.origin, serviceWorkers: 'block' });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === t.origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', () => errors.push('UNHANDLED_PAGE_ERROR'));
    await page.goto(t.origin, { waitUntil: 'networkidle', timeout: 30000 });
    await expect(
      page.getByRole('button', { name: 'Create invitation', exact: true }),
    ).toBeVisible();
    const response = page.waitForResponse(
      (r) => r.url() === `${t.origin}/v1/sessions` && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    expect((await response).status()).toBe(503);
    await expect(page.getByRole('alert')).toBeVisible();
    const capabilities = await page.evaluate(() => {
      const peer = new RTCPeerConnection({ iceServers: [] });
      peer.close();
      return {
        webrtc: peer.signalingState === 'closed',
        file: new File([new Uint8Array([1])], 'canary.bin').size === 1,
        crypto: !!crypto.subtle,
      };
    });
    expect(capabilities).toEqual({ webrtc: true, file: true, crypto: true });
    expect(errors).toEqual([]);
    return {
      scope: 'isolated-preview-browser',
      shell: 'PASS',
      pausedCreation: 'PASS',
      clientAPIs: 'CAPABILITY_ONLY — NOT A CONNECTED PEER OR FILE TRANSFER',
      pairedSession: 'NOT_RUN',
      natTurn: 'NOT_RUN',
      ...CAPABILITIES,
    };
  } finally {
    await browser.close();
  }
}
