import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
import { loadEvidence } from '../helpers/control-load';

declare global {
  interface Window {
    task14ObservedRooms: Set<string>;
  }
}

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test('four independent browser pairs commit and export exact files simultaneously without page errors or cross-room signals', async ({
  browser,
}, info) => {
  test.setTimeout(90000);
  const barrier: Route[] = [],
    errors: string[] = [];
  let released = false;
  const made = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      pairForTransfer(
        browser,
        {
          ...devices[info.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
          baseURL: 'http://127.0.0.1:5173',
        },
        async (owner, receiver) => {
          for (const page of [owner, receiver]) {
            page.on('pageerror', (error) => errors.push(error.name));
            // Genuine local WebRTC, without consuming external STUN/TURN bandwidth.
            await page.addInitScript(() => {
              const Native = window.RTCPeerConnection;
              window.task14ObservedRooms = new Set();
              const observe = (channel: RTCDataChannel) =>
                channel.addEventListener('message', (event) => {
                  if (typeof event.data !== 'string') return;
                  try {
                    const message = JSON.parse(event.data);
                    const room =
                      message.hello?.roomId ?? message.ping?.roomId ?? message.control?.roomId;
                    window.task14ObservedRooms.add(typeof room === 'string' ? room : 'UNSCOPED');
                  } catch {
                    window.task14ObservedRooms.add('MALFORMED');
                  }
                });
              window.RTCPeerConnection = class extends Native {
                constructor(options?: RTCConfiguration) {
                  super({ ...options, iceServers: [] });
                  this.addEventListener('datachannel', (event) => observe(event.channel));
                }
                override createDataChannel(label: string, options?: RTCDataChannelInit) {
                  const channel = super.createDataChannel(label, options);
                  observe(channel);
                  return channel;
                }
              };
            });
          }
          await receiver.route('**/__task14-commit-barrier', async (route) => {
            if (released) await route.fulfill({ status: 200, body: 'release' });
            else barrier.push(route);
          });
          await receiver.route('**/hash-storage.worker.ts*', async (route) => {
            const response = await route.fetch(),
              body = await response.text();
            expect(body).toContain('OpfsReceiverStore');
            await route.fulfill({
              response,
              body:
                body +
                `\nconst task14Write=OpfsReceiverStore.prototype.writeBlock;let task14Held=false;OpfsReceiverStore.prototype.writeBlock=async function(...args){if(!task14Held){task14Held=true;const response=await fetch('/__task14-commit-barrier');if(!response.ok)throw new Error('Test barrier failed');}return task14Write.apply(this,args);};\n`,
            });
          });
        },
      ),
    ),
  );
  const pairs = made.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  try {
    expect(made.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect(pairs).toHaveLength(4);
    const fixtures = pairs.map((_, i) => Buffer.alloc(2 * 1024 ** 2 + i * 37 + 1, 71 + i));
    await Promise.all(
      pairs.map(async (pair, i) => {
        await pair.owner.getByRole('button', { name: 'Send signed ping', exact: true }).click();
        await expect
          .poll(async () => Number(await pair.receiver.getByTestId('received-pings').textContent()))
          .toBeGreaterThanOrEqual(1);
        await expect
          .poll(async () => Number(await pair.owner.getByTestId('received-pongs').textContent()))
          .toBeGreaterThanOrEqual(1);
        await pair.owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
          name: `concurrent-${i}.bin`,
          mimeType: 'application/octet-stream',
          buffer: fixtures[i]!,
        });
        await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      }),
    );
    await Promise.all(
      pairs.map((p) =>
        p.receiver.getByRole('button', { name: 'Accept files', exact: true }).click(),
      ),
    );
    await expect.poll(() => barrier.length).toBe(4);
    for (const pair of pairs) {
      await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('active');
      await expect(pair.receiver.getByTestId('committed-bytes')).toHaveText('0');
      await expect(pair.owner.getByTestId('committed-bytes')).toHaveText('0');
    }
    released = true;
    await Promise.all(barrier.map((route) => route.fulfill({ status: 200, body: 'release' })));
    await Promise.all(
      pairs.map(async (pair, i) => {
        for (const page of [pair.owner, pair.receiver]) {
          await expect(page.getByTestId('transfer-state')).toHaveText('complete', {
            timeout: 30000,
          });
          await expect(page.getByTestId('committed-bytes')).toHaveText(String(fixtures[i]!.length));
        }
        const digest = createHash('sha256').update(fixtures[i]!).digest('hex');
        await expect(pair.receiver.getByTestId('file-sha256')).toHaveText(digest);
        const download = pair.receiver.waitForEvent('download');
        await pair.receiver
          .getByRole('button', { name: `Save concurrent-${i}.bin`, exact: true })
          .click();
        const path = info.outputPath(`concurrent-${i}.bin`);
        await (await download).saveAs(path);
        expect(
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ).toBe(digest);
        const invitation = new URL(
          await pair.owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
        );
        const room = new URLSearchParams(invitation.hash.slice(1)).get('room')!;
        for (const page of [pair.owner, pair.receiver]) {
          await expect(page.getByTestId('peer-state')).toHaveText('connected');
          expect(
            await page.evaluate(
              (expected) =>
                window.task14ObservedRooms.size === 1 &&
                [...window.task14ObservedRooms].every((id) => id === expected),
              room,
            ),
          ).toBe(true);
        }
      }),
    );
    expect(errors).toEqual([]);
    await loadEvidence(`browser-${info.project.name}`, {
      scope: 'local-browser-webRTC-opfs-download',
      simultaneousPairs: 4,
      simultaneouslyHeldCommits: 4,
      verifiedExports: 4,
      pageErrors: 0,
      crossRoomSignals: 0,
    });
  } finally {
    released = true;
    await Promise.all(
      barrier.map((r) => r.fulfill({ status: 200, body: 'release' }).catch(() => {})),
    );
    await Promise.all(pairs.map((p) => p.close()));
  }
});
