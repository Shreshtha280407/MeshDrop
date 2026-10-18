import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { pairPages } from '../helpers/peer';

test.use({ trace: 'off', video: 'off' });

test('a slow replacement connection cancels the previous pending recovery retry', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  const owner = await a.newPage();
  const receiver = await b.newPage();
  let requests = 0;
  let interrupt: (() => void) | undefined;
  await owner.routeWebSocket('**/v1/sessions/*/ws', (socket) => {
    const server = socket.connectToServer();
    let latest: Record<string, unknown> | undefined;
    interrupt = () => {
      if (!latest) throw new Error('No signaling context.');
      socket.send(
        JSON.stringify({
          ...latest,
          type: 'ERROR',
          payload: {
            code: 'PEER_UNAVAILABLE',
            message: 'Synthetic peer interruption.',
            retryable: true,
          },
        }),
      );
    };
    let delaySignaling = false;
    socket.onMessage((message) => {
      try {
        const envelope = JSON.parse(String(message));
        if (envelope.type === 'SDP_OFFER' && envelope.epoch > 1) delaySignaling = true;
      } catch {
        /* Heartbeat frames contain no JSON. */
      }
      // Delay every subsequent frame equally, preserving WebSocket ordering.
      if (delaySignaling) setTimeout(() => server.send(message), 2500);
      else server.send(message);
    });
    server.onMessage((message) => {
      try {
        latest = JSON.parse(String(message)) as Record<string, unknown>;
      } catch {
        /* Heartbeats do not replace the admitted test context. */
      }
      socket.send(message);
    });
  });
  try {
    await pairPages(owner, receiver);
    owner.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/connection')) requests++;
    });
    // A real control-plane error arms the owner's 1s retry. Start an admitted
    // replacement before it fires, then keep negotiation slower than that timer.
    interrupt!();
    await expect(owner.getByTestId('recovery-status')).toContainText('Reconnect attempt');
    await owner.getByRole('button', { name: 'New peer connection', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('peer-epoch')).toHaveText('2');
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 20000 });
    }
    expect(requests).toBe(1);
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } catch (error) {
    console.log(
      JSON.stringify({
        scenario: 'delayed replacement after synthetic interruption',
        connectionRequests: requests,
        ownerState: await owner.getByTestId('peer-state').textContent(),
        receiverState: await receiver.getByTestId('peer-state').textContent(),
        ownerError: await owner.locator('.signaling-panel .error').allTextContents(),
        receiverError: await receiver.locator('.signaling-panel .error').allTextContents(),
      }),
    );
    throw error;
  } finally {
    await a.close();
    await b.close();
  }
});

test('signed peer hello, independent comparison, epoch restart and fresh connection', async ({
  browser,
}, testInfo) => {
  const ownerContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const receiver = await receiverContext.newPage();
  const errors: string[] = [];
  for (const page of [owner, receiver]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(owner.getByTestId('connection-state')).toHaveText('connected');
    await receiver.goto(
      await owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
    );
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(receiver.getByTestId('peer-state')).toHaveText('idle');
    await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
    const first = await owner.getByTestId('pairing-code').textContent();
    expect(await receiver.getByTestId('pairing-code').textContent()).toBe(first);
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('verification-state')).toHaveText('unverified');
      await expect(page.getByTestId('negotiated-capabilities')).toContainText('Resume: persistent');
      await page.getByLabel('Code shown on the other device', { exact: true }).fill(first!);
      await expect(
        page.getByRole('button', { name: 'Confirm comparison', exact: true }),
      ).toBeDisabled();
      await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
      await expect(page.getByTestId('verification-state')).toHaveText('verified');
    }
    await owner.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await expect(receiver.getByTestId('received-pings')).toHaveText('1');
    await expect(owner.getByTestId('received-pongs')).toHaveText('1');
    await owner.screenshot({
      path: testInfo.outputPath('phase-2-paired.png'),
      fullPage: true,
      mask: [owner.getByLabel('Private invitation link', { exact: true })],
    });
    await owner.getByRole('button', { name: 'Restart ICE', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('peer-epoch')).toHaveText('2');
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
      await expect(page.getByTestId('verification-state')).toHaveText('unverified');
    }
    const second = await owner.getByTestId('pairing-code').textContent();
    expect(second).not.toBe(first);
    expect(await receiver.getByTestId('pairing-code').textContent()).toBe(second);
    await receiver.getByRole('button', { name: 'New peer connection', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('peer-epoch')).toHaveText('3');
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
    }
    expect(await owner.getByTestId('pairing-code').textContent()).not.toBe(second);
    await receiver.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await expect(owner.getByTestId('received-pings')).toHaveText('1');
    await expect(receiver.getByTestId('received-pongs')).toHaveText('1');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('closed');
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close();
    await receiverContext.close();
  }
});

test('a mismatched independently entered code closes the transport and stays unverified', async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const owner = await a.newPage();
  const receiver = await b.newPage();
  try {
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(owner.getByTestId('connection-state')).toHaveText('connected');
    await receiver.goto(
      await owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
    );
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
    await expect(owner.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
    const code = await owner.getByTestId('pairing-code').textContent();
    await owner
      .getByLabel('Code shown on the other device', { exact: true })
      .fill(code![0] === 'F' ? '0000-0000-0000-0000' : 'FFFF-FFFF-FFFF-FFFF');
    await owner.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await owner.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
    await expect(owner.getByTestId('verification-state')).toHaveText('mismatch');
    await expect(owner.getByTestId('peer-state')).toHaveText('closed');
    await expect(receiver.getByTestId('peer-state')).toHaveText('closed');
    await expect(owner.getByRole('alert')).toContainText('do not match');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await a.close();
    await b.close();
  }
});

test('an unanswered real peer connection times out and closes cleanly', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(
    async (moduleUrl) => {
      const { PeerSession } = await import(/* @vite-ignore */ moduleUrl);
      const roomId = crypto.randomUUID();
      const peerId = crypto.randomUUID();
      const states: string[] = [];
      const session = new PeerSession({
        roomId,
        peerId,
        role: 'owner',
        connectionTimeoutMs: 500,
        sendSignal: () => {},
        onChange: (view: { state: string }) => states.push(view.state),
      });
      await session.start(
        {
          epoch: 1,
          mode: 'new-connection',
          ownerPeerId: peerId,
          receiverPeerId: crypto.randomUUID(),
        },
        { iceServers: [], relayAvailable: false, expiresAt: Date.now() + 60000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      return {
        state: session.snapshot.state,
        ready: session.snapshot.ready,
        error: session.snapshot.error,
        states,
      };
    },
    `/@fs/${resolve('packages/peer-connection/src/index.ts')}`,
  );
  expect(result.state).toBe('closed');
  expect(result.ready).toBe(false);
  expect(result.error).toContain('timed out');
  expect(result.states).toContain('signaling');
  expect(result.states).toContain('checking');
});

test('replayed signed data-channel pings fail closed', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const owner = await a.newPage();
  const receiver = await b.newPage();
  await owner.addInitScript(() => {
    const send = RTCDataChannel.prototype.send as (this: RTCDataChannel, data: string) => void;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: string) {
      send.call(this, data);
      if (typeof data === 'string' && JSON.parse(data).ping?.type === 'PING') send.call(this, data);
    } as typeof RTCDataChannel.prototype.send;
  });
  try {
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(owner.getByTestId('connection-state')).toHaveText('connected');
    await receiver.goto(
      await owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
    );
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
    await expect(owner.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
    await expect(receiver.getByTestId('peer-state')).toHaveText('connected', { timeout: 30000 });
    await owner.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await expect(receiver.getByTestId('peer-state')).toHaveText('closed');
    await expect(receiver.getByRole('alert')).toContainText('replay checks');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await a.close();
    await b.close();
  }
});
