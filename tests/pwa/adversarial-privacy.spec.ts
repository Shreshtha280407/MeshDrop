import { expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('same-document and history invitation navigations consume fragments without request/referrer/storage leakage', async ({
  page,
}) => {
  const room = '123e4567-e89b-42d3-a456-426614174000';
  const first = 'I'.repeat(43),
    second = 'J'.repeat(43);
  let leaked = false;
  page.on('request', (request) => {
    const observed = request.url() + ' ' + (request.headers().referer ?? '');
    if ([first, second].some((value) => observed.includes(value))) leaked = true;
  });
  await page.goto(`/#room=${room}&invite=${first}`);
  const input = page.getByLabel('Join with an invitation', { exact: true });
  await expect.poll(async () => (await input.inputValue()).includes(first)).toBe(true);
  await expect.poll(() => page.evaluate(() => location.hash === '')).toBe(true);
  await page.evaluate(
    ({ room, second }) => {
      location.hash = `room=${room}&invite=${second}`;
    },
    { room, second },
  );
  await expect.poll(() => page.evaluate(() => location.hash === '')).toBe(true);
  await expect.poll(async () => (await input.inputValue()).includes(second)).toBe(true);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => location.hash === '')).toBe(true);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => location.hash === '')).toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => location.hash === '')).toBe(true);
  expect(
    await page.evaluate(
      (values) => !values.some((v) => JSON.stringify([localStorage, sessionStorage]).includes(v)),
      [first, second],
    ),
  ).toBe(true);
  expect(leaked).toBe(false);
});

test('built PWA caches only public resources after real transfer and ignores authorization/query/API responses', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const pair = await pairForTransfer(browser, {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'allow',
  });
  const canary = 'task15-cache-private-' + crypto.randomUUID();
  const filename = 'private-synthetic-name-' + crypto.randomUUID() + '.txt';
  try {
    await pair.owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name: filename,
      mimeType: 'text/plain',
      buffer: Buffer.from('synthetic private bytes'),
    });
    await pair.owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await pair.receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(pair.receiver.getByTestId('transfer-state')).toHaveText('complete');
    await expect(pair.receiver.getByTestId('offline-shell-status')).toContainText(
      'Static app shell cached',
    );
    await pair.receiver.evaluate(async (canary) => {
      await navigator.serviceWorker.ready;
      for (const [url, init] of [
        ['/?token=' + encodeURIComponent(canary), {}],
        ['/manifest.webmanifest', { headers: { Authorization: 'Bearer ' + canary } }],
        ['/v1/protocol', {}],
        ['/ops/metrics', { headers: { Authorization: 'Bearer ' + canary } }],
      ] as [string, RequestInit][]) {
        const r = await fetch(url, init);
        await r.arrayBuffer();
      }
    }, canary);
    const inspect = () =>
      pair.receiver.evaluate(
        async ({ canary, filename }) => {
          let count = 0,
            privateValue = false,
            sensitiveRoute = false;
          for (const name of await caches.keys()) {
            if (!name.startsWith('meshdrop-shell-')) continue;
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
              count++;
              const url = new URL(request.url);
              const response = await cache.match(request);
              const text =
                JSON.stringify([...request.headers]) +
                request.url +
                (response ? await response.text() : '');
              privateValue ||= text.includes(canary) || text.includes(filename);
              sensitiveRoute ||=
                Boolean(url.search) ||
                url.pathname.startsWith('/v1/') ||
                url.pathname.startsWith('/ops/') ||
                request.headers.has('authorization');
            }
          }
          return { count, privateValue, sensitiveRoute };
        },
        { canary, filename },
      );
    const online = await inspect();
    expect(online.count).toBeGreaterThan(8);
    expect(online.privateValue || online.sensitiveRoute).toBe(false);
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await pair.receiver.context().setOffline(true);
    await pair.receiver.reload();
    await expect(pair.receiver.getByTestId('pwa-panel')).toContainText('Offline shell only');
    const offline = await inspect();
    expect(offline.privateValue || offline.sensitiveRoute).toBe(false);
    await expect(pair.receiver.getByTestId('live-room-state')).toHaveCount(0);
  } finally {
    await pair.close();
  }
});
