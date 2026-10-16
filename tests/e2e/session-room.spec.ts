import { expect, test } from '@playwright/test';

// Browser traces include network headers. Keep runtime capabilities out of artifacts.
test.use({ trace: 'off', video: 'off' });

test('server closes a revoked socket even when the browser does not help', async ({ page }) => {
  await page.addInitScript(() => {
    // Simulate a peer that ignores application-level close notifications.
    WebSocket.prototype.close = function () {};
  });
  await page.goto('/');
  const opened = page.waitForEvent('websocket');
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const socket = await opened;
  let closed = false;
  socket.on('close', () => {
    closed = true;
  });
  await expect(page.getByTestId('connection-state')).toHaveText('connected');
  await page.getByRole('button', { name: 'Revoke room', exact: true }).click();
  await expect.poll(() => closed).toBe(true);
});

test('owner approval gates real signaling and a third browser is blocked', async ({
  browser,
}, testInfo) => {
  const ownerContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const thirdContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const receiver = await receiverContext.newPage();
    const third = await thirdContext.newPage();
    const pageErrors: string[] = [];
    for (const page of [owner, receiver, third])
      page.on('pageerror', (error) => pageErrors.push(error.message));
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(owner.getByTestId('connection-state')).toHaveText('connected');
    const invitation = await owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await receiver.goto(invitation);
    expect(receiver.url()).not.toContain('#');
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(receiver.getByTestId('admission-state')).toHaveText('pending');
    await expect(
      receiver.getByRole('button', { name: 'Send signaling probe', exact: true }),
    ).toBeDisabled();
    await expect(owner.getByTestId('live-room-state')).toHaveText('pending');
    await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
    await expect(receiver.getByTestId('admission-state')).toHaveText('approved');
    await expect(receiver.getByTestId('connection-state')).toHaveText('connected');
    await owner.getByRole('button', { name: 'Send signaling probe', exact: true }).click();
    await expect(receiver.getByTestId('received-signals')).toHaveText('1');
    await receiver.getByRole('button', { name: 'Send signaling probe', exact: true }).click();
    await expect(owner.getByTestId('received-signals')).toHaveText('1');
    await third.goto(invitation);
    await third.getByRole('button', { name: 'Request to join', exact: true }).click();
    await expect(third.getByRole('alert')).toContainText('INVITE_USED');
    // Never capture raw bearer invitations in the evidence screenshot.
    await owner.screenshot({
      path: testInfo.outputPath('phase-1-approved.png'),
      fullPage: true,
      mask: [owner.getByLabel('Private invitation link', { exact: true })],
    });
    await receiver.screenshot({
      path: testInfo.outputPath('phase-1-receiver.png'),
      fullPage: true,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await expect(owner.getByTestId('live-room-state')).toHaveText('closed');
    await expect(receiver.getByTestId('live-room-state')).toHaveText('closed');
    await expect(receiver.getByTestId('connection-state')).toHaveText('disconnected');
    expect(pageErrors).toEqual([]);
  } finally {
    await ownerContext.close();
    await receiverContext.close();
    await thirdContext.close();
  }
});

test('receiver rejection is visible without socket admission', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const receiver = await receiverContext.newPage();
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(owner.getByTestId('connection-state')).toHaveText('connected');
    await receiver.goto(
      await owner.getByLabel('Private invitation link', { exact: true }).inputValue(),
    );
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await owner.getByRole('button', { name: 'Reject receiver', exact: true }).click();
    await expect(receiver.getByTestId('admission-state')).toHaveText('rejected');
    await expect(receiver.getByTestId('connection-state')).toHaveText('disconnected');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await ownerContext.close();
    await receiverContext.close();
  }
});

test('live shell fits the viewport and rejects an invalid invitation', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page
    .getByLabel('Join with an invitation', { exact: true })
    .fill('invalid-public-test-value');
  await page.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid invitation');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  await page.screenshot({ path: testInfo.outputPath('phase-1-shell.png'), fullPage: true });
});
