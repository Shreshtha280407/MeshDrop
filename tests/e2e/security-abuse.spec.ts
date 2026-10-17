import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pairForTransfer } from '../helpers/peer';

declare global {
  interface Window {
    p8Sockets: WebSocket[];
  }
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('colliding directory basenames export distinct names and independently correct bytes', async ({
  browser,
}, info) => {
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  try {
    await pair.owner.getByLabel('Choose files to send', { exact: true }).evaluate((element) => {
      const files = new DataTransfer();
      for (const [path, content] of [
        ['one/same.txt', 'first file'],
        ['two/same.txt', 'second file'],
      ]) {
        const file = new File([content!], 'same.txt', { type: 'text/html' });
        Object.defineProperty(file, 'webkitRelativePath', { value: path });
        files.items.add(file);
      }
      (element as HTMLInputElement).files = files.files;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await pair.receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('complete');
    for (const [path, name, content] of [
      ['one/same.txt', 'same.txt', 'first file'],
      ['two/same.txt', 'same (2).txt', 'second file'],
    ]) {
      const pending = pair.receiver.waitForEvent('download');
      await pair.receiver.getByRole('button', { name: `Save ${path}`, exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(name);
      const output = info.outputPath(name!);
      await download.saveAs(output);
      expect(await readFile(output, 'utf8')).toBe(content);
    }
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});

test('a signaling message flood closes the bounded client queue', async ({ browser }) => {
  const pair = await pairForTransfer(
    browser,
    { baseURL: 'http://127.0.0.1:5173' },
    async (_owner, receiver) => {
      await receiver.addInitScript(() => {
        window.p8Sockets = [];
        const Original = WebSocket;
        window.WebSocket = class extends Original {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            window.p8Sockets.push(this);
          }
        };
      });
    },
  );
  try {
    const invitation = await pair.owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    const roomId = new URLSearchParams(new URL(invitation).hash.slice(1)).get('room')!;
    await pair.receiver.evaluate((roomId) => {
      const socket = window.p8Sockets.at(-1)!;
      for (let index = 0; index < 80; index++)
        socket.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              version: 1,
              type: 'JOINED',
              roomId,
              peerId: crypto.randomUUID(),
              messageId: crypto.randomUUID(),
              epoch: 1,
              seq: index,
              sentAt: new Date().toISOString(),
              payload: { approval: 'approved' },
            }),
          }),
        );
    }, roomId);
    await expect(pair.receiver.getByRole('alert')).toContainText('Invalid signaling response');
    await expect(pair.receiver.getByTestId('connection-state')).toHaveText('disconnected');
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
test('a third browser is denied entry to an already approved pair', async ({ browser }, info) => {
  const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
  const thirdContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  try {
    const link = await pair.owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    const third = await thirdContext.newPage();
    await third.goto('/');
    await third.getByLabel('Join with an invitation', { exact: true }).fill(link);
    const response = third.waitForResponse((response) => response.url().endsWith('/join'));
    await third.getByRole('button', { name: 'Request to join', exact: true }).click();
    expect((await response).status()).toBe(409);
    await expect(third.getByRole('alert')).toContainText('Invitation already used');
    await third.getByLabel('Join with an invitation', { exact: true }).fill('');
    await third.screenshot({
      path: info.outputPath('phase-8-third-user-denied.png'),
      fullPage: true,
    });
    for (const page of [pair.owner, pair.receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('connected');
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await thirdContext.close();
    await pair.close();
  }
});

for (const mutation of ['version', 'fragment-count', 'out-of-order'] as const)
  test(`real WebRTC ${mutation} frame fails without committed bytes or an export`, async ({
    browser,
  }, info) => {
    const pair = await pairForTransfer(browser, { baseURL: 'http://127.0.0.1:5173' });
    try {
      await pair.owner.evaluate((mutation) => {
        const original = RTCDataChannel.prototype.send as (
          this: RTCDataChannel,
          data: string | Blob | ArrayBuffer | ArrayBufferView,
        ) => void;
        RTCDataChannel.prototype.send = function (
          this: RTCDataChannel,
          data: string | Blob | ArrayBuffer | ArrayBufferView,
        ) {
          if (ArrayBuffer.isView(data)) {
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
            if (bytes.length >= 72 && bytes[5] === 2) {
              if (mutation === 'version') bytes[4] = 255;
              if (mutation === 'fragment-count')
                new DataView(bytes.buffer).setUint32(68, 0xffffffff);
              if (mutation === 'out-of-order') new DataView(bytes.buffer).setUint32(64, 1);
              original.call(this, bytes);
              return;
            }
          }
          original.call(this, data);
        } as typeof RTCDataChannel.prototype.send;
      }, mutation);
      await pair.owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
        name: 'malformed.bin',
        mimeType: 'application/octet-stream',
        buffer: Buffer.alloc(32 * 1024, 53),
      });
      await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await pair.receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('failed');
      for (const page of [pair.owner, pair.receiver])
        await expect(page.getByTestId('committed-bytes')).toHaveText('0');
      await expect(
        pair.receiver.getByRole('button', { name: 'Save malformed.bin', exact: true }),
      ).toHaveCount(0);
      await pair.receiver.locator('.transfer-panel').screenshot({
        path: info.outputPath(`phase-8-${mutation}-denied.png`),
      });
      await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    } finally {
      await pair.close();
    }
  });
