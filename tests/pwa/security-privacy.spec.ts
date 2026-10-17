import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('production CSP blocks script and network exfiltration while the locked QR chunk works', async ({
  browser,
  page,
  request,
}) => {
  const response = await request.get('/');
  expect(response.headers()['content-security-policy']).not.toContain('unsafe-');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    await page.goto('/');
    const result = await page.evaluate(async (port) => {
      const node = document.createElement('script');
      node.textContent = 'document.documentElement.dataset.exfiltrated="yes"';
      document.head.append(node);
      let blocked = false;
      try {
        await fetch(`http://127.0.0.1:${port}/canary`);
      } catch {
        blocked = true;
      }
      return { blocked, executed: document.documentElement.dataset.exfiltrated === 'yes' };
    }, address.port);
    expect(result).toEqual({ blocked: true, executed: false });
    expect(calls).toBe(0);
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await page.getByRole('button', { name: 'Show private QR', exact: true }).click();
    const svg = page.getByTestId('invitation-qr').locator('svg');
    await expect(svg).toHaveCount(1);
    const source = await svg.evaluate((node) => new XMLSerializer().serializeToString(node));
    const invitation = await page
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    const receiverContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
    try {
      const receiver = await receiverContext.newPage();
      await receiver.goto('/');
      await receiver.evaluate(async (source) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(source)}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const drawing = canvas.getContext('2d')!;
        drawing.fillStyle = 'white';
        drawing.fillRect(0, 0, 360, 360);
        drawing.drawImage(image, 20, 20, 320, 320);
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
          configurable: true,
          value: async () => {
            const stream = canvas.captureStream(10);
            window.p7CameraTracks = stream.getTracks();
            const timer = setInterval(() => drawing.drawImage(canvas, 0, 0), 100);
            stream.getTracks()[0]!.addEventListener('ended', () => clearInterval(timer));
            return stream;
          },
        });
      }, source);
      await receiver
        .getByRole('button', { name: 'Scan invitation with camera', exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await receiver.getByLabel('Join with an invitation', { exact: true }).inputValue()) ===
            invitation,
          { timeout: 15000 },
        )
        .toBe(true);
      expect(
        await receiver.evaluate(() =>
          window.p7CameraTracks.every((track) => track.readyState === 'ended'),
        ),
      ).toBe(true);
    } finally {
      await receiverContext.close();
    }
    await page.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('invitation fragments leave history and storage and navigation sends no referrer', async ({
  page,
  context,
}) => {
  const room = '123e4567-e89b-42d3-a456-426614174000',
    secret = 'S'.repeat(43);
  let referrer: string | undefined,
    calls = 0;
  const server = createServer((request, response) => {
    referrer = request.headers.referer;
    calls++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<p>Navigation received</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`/#room=${room}&invite=${secret}`);
    await expect(page.getByLabel('Join with an invitation', { exact: true })).toHaveValue(
      new RegExp(secret),
    );
    await expect(page).toHaveURL('http://127.0.0.1:4173/');
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(
      secret,
    );
    const cdp = await context.newCDPSession(page);
    const history = await cdp.send('Page.getNavigationHistory');
    expect(history.entries.every((entry) => !entry.url.includes(secret))).toBe(true);
    // Chromium retains userTypedURL metadata outside the History API's control.
    // Record that limit in the privacy model; never claim browser-level erasure.
    await cdp.detach();
    await page.evaluate((port) => {
      const link = document.createElement('a');
      link.href = `http://127.0.0.1:${port}/destination`;
      link.id = 'privacy-canary';
      link.textContent = 'Continue';
      document.body.append(link);
    }, port);
    await page.locator('#privacy-canary').click();
    await expect(page.getByText('Navigation received')).toBeVisible();
    expect(calls).toBe(1);
    expect(referrer).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
