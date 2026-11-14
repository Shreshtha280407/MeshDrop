import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devices, expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { pairPages } from '../helpers/peer';
import { pauseAt } from '../helpers/diagnostics';
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
for (const completed of [false, true])
  test(`fresh browser processes rehash ${completed ? 'completed' : 'interrupted'} data, restore no authority and keep deletion final`, async ({
    browser,
  }, info) => {
    test.setTimeout(60000);
    const browserType = browser.browserType();
    const profile = await mkdtemp(join(tmpdir(), 'meshdrop-task16-profile-'));
    const suffix = randomUUID().replaceAll('-', '').slice(0, 24).match(/.{4}/g)!.join(':');
    const options = {
      ...devices[info.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
      baseURL: 'http://127.0.0.1:5173',
      acceptDownloads: true,
      extraHTTPHeaders: { 'CF-Connecting-IP': '2001:db8:' + suffix },
    };
    const ownerContext = await browser.newContext(options);
    let receiverContext: BrowserContext | null = null;
    const buffer = Buffer.alloc(4 * 1024 ** 2 + 17);
    for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 17 + 9) & 255;
    const name = 'restart.bin';
    let exported: string | null = null;
    try {
      receiverContext = await browserType.launchPersistentContext(profile, {
        ...options,
        headless: true,
      });
      const owner = await ownerContext.newPage(),
        receiver = receiverContext.pages()[0]!;
      await pairPages(owner, receiver);
      if (!completed) await pauseAt(receiver, 1048576);
      await owner
        .getByLabel('Choose files to send', { exact: true })
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      if (completed) {
        await expect(receiver.getByTestId('transfer-state')).toHaveText('complete');
      } else {
        await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
        await expect(owner.getByTestId('transfer-state')).toHaveText('paused');
        await receiver.evaluate(() => window.dispatchEvent(new Event('offline')));
        await expect(receiver.getByTestId('transfer-state')).toHaveText('reconnecting');
      }
      // A readonly transaction after worker shutdown waits behind earlier queued
      // writes. Capture the actual ledger frontier, including a lost final ACK.
      const blocks = await receiver.evaluate(
        async () =>
          new Promise<{ index: number; bytes: number }[]>((resolve, reject) => {
            const request = indexedDB.open('meshdrop-checkpoints-v1', 1);
            request.onerror = () => reject(Error('Fixture ledger unavailable.'));
            request.onsuccess = () => {
              const db = request.result,
                tx = db.transaction('blocks'),
                query = tx.objectStore('blocks').getAll();
              let rows: { index: number; bytes: number }[] = [];
              query.onsuccess = () => {
                rows = query.result;
              };
              tx.oncomplete = () => {
                db.close();
                resolve(rows);
              };
              tx.onabort = () => {
                db.close();
                reject(Error('Fixture read aborted.'));
              };
            };
          }),
      );
      const committed = blocks.reduce((sum, block) => sum + block.bytes, 0);
      const indices = blocks.map((block) => block.index).sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: indices.length }, (_, index) => index));
      expect(committed).toBeGreaterThan(0);
      expect(committed).toBe(completed ? buffer.length : indices.length * 1048576);
      if (!completed) expect(committed).toBeLessThan(buffer.length);
      const ranges: [number, number][] = [[0, indices.length - 1]];
      await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
      const oldBrowser = receiverContext.browser()!;
      await receiverContext.close();
      receiverContext = null;
      expect(oldBrowser.isConnected()).toBe(false);
      await ownerContext.close();

      receiverContext = await browserType.launchPersistentContext(profile, {
        ...options,
        headless: true,
      });
      const reopened = receiverContext.pages()[0]!;
      let restoredAuthority = false;
      reopened.on('request', (request) => {
        if (
          request.headers().authorization ||
          (request.method() === 'POST' &&
            new URL(request.url()).pathname.startsWith('/v1/sessions'))
        )
          restoredAuthority = true;
      });
      await reopened.goto('/');
      await expect(reopened.getByTestId('recovered-bytes')).toHaveText(String(committed));
      await expect(reopened.getByTestId('saved-ranges')).toHaveText(
        'Verified block ranges: ' + JSON.stringify(ranges),
      );
      await expect(reopened.getByTestId('live-room-state')).toHaveCount(0);
      expect(restoredAuthority).toBe(false);
      if (completed) {
        await expect(reopened.getByTestId('saved-checkpoint')).toContainText(
          'Completed receipt restored',
        );
        await reopened.getByRole('button', { name: `Export saved ${name}`, exact: true }).click();
        const pending = reopened.waitForEvent('download');
        await reopened.getByRole('button', { name: `Save ${name}`, exact: true }).click();
        exported = info.outputPath('external-copy.bin');
        await (await pending).saveAs(exported);
        expect(hash(await readFile(exported))).toBe(hash(buffer));
      } else {
        await expect(
          reopened.getByRole('button', { name: `Export saved ${name}`, exact: true }),
        ).toHaveCount(0);
        await expect(reopened.getByTestId('saved-checkpoint')).toContainText(
          'completion has not been confirmed',
        );
      }
      await reopened.getByRole('button', { name: `Delete saved ${name}`, exact: true }).click();
      await expect(reopened.getByTestId('saved-checkpoint')).toHaveCount(0);
      await receiverContext.close();
      receiverContext = null;
      receiverContext = await browserType.launchPersistentContext(profile, {
        ...options,
        headless: true,
      });
      const afterDelete = receiverContext.pages()[0]!;
      await afterDelete.goto('/');
      await expect(afterDelete.getByTestId('saved-transfers')).toContainText(
        'No retained transfers',
      );
      await expect(afterDelete.getByTestId('live-room-state')).toHaveCount(0);
      if (exported) expect(hash(await readFile(exported))).toBe(hash(buffer));
    } finally {
      await receiverContext?.close();
      await ownerContext.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
