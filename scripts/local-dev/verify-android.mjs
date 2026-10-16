/* global document, window -- evaluated inside the phone browser */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// First: adb reverse tcp:5173 tcp:5173; open Chrome on the phone;
// adb forward tcp:9223 localabstract:chrome_devtools_remote.
// Run with PLAYWRIGHT_BROWSERS_PATH pointing at your installed browser cache.
const base = process.env.MESHDROP_TEST_URL ?? 'http://127.0.0.1:5173';
const output = process.env.MESHDROP_EVIDENCE_DIR ?? '/tmp/meshdrop-p2-android';
await mkdir(output, { recursive: true });
const desktop = await chromium.launch();
const phoneBrowser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const owner = await desktop.newPage({ viewport: { width: 1440, height: 1000 } });
// Create and close only the test tab. Do not enumerate or inspect personal tabs.
const phone = await phoneBrowser.contexts()[0].newPage();
const report = {
  kind: 'physical-android',
  startedAt: new Date().toISOString(),
  desktopBrowser: desktop.version(),
  phoneBrowser: phoneBrowser.version(),
  note: 'Signaling uses USB port forwarding; WebRTC ICE selects the data path. Automated comparison exercises the UI; it is not a human identity attestation.',
  checks: [],
};
async function ready(epoch) {
  for (const page of [owner, phone]) {
    await expect(page.getByTestId('peer-epoch')).toHaveText(String(epoch), { timeout: 35000 });
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 35000 });
  }
  const code = await owner.getByTestId('pairing-code').textContent();
  expect(await phone.getByTestId('pairing-code').textContent()).toBe(code);
  return code;
}
async function ping() {
  for (const [sender, receiver] of [
    [owner, phone],
    [phone, owner],
  ]) {
    await sender.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await expect(receiver.getByTestId('received-pings')).toHaveText('1');
    await expect(sender.getByTestId('received-pongs')).toHaveText('1');
  }
}
try {
  await owner.goto(base);
  await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
  await expect(owner.getByTestId('connection-state')).toHaveText('connected');
  const invitation = await owner
    .getByLabel('Private invitation link', { exact: true })
    .inputValue();
  await phone.goto(invitation);
  await phone.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(phone.getByTestId('admission-state')).toHaveText('pending');
  await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
  const first = await ready(1);
  await ping();
  for (const page of [owner, phone]) {
    await expect(page.getByTestId('verification-state')).toHaveText('unverified');
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(first);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
    await expect(page.getByTestId('verification-state')).toHaveText('verified');
  }
  report.path = await owner.getByTestId('ice-path').textContent();
  report.checks.push(
    'approval, signed hello, equal pairing transcript, signed ping/pong both ways, explicit comparison workflow',
  );
  await owner.screenshot({
    path: `${output}/phase-2-desktop.png`,
    fullPage: true,
    mask: [owner.getByLabel('Private invitation link', { exact: true })],
  });
  await phone.getByTestId('pairing-code').scrollIntoViewIfNeeded();
  report.mobileLayoutFits = await phone.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  if (!report.mobileLayoutFits) throw new Error('Phone layout exceeds the viewport.');
  await phone.screenshot({ path: `${output}/phase-2-oppo.png`, fullPage: false });
  await owner.getByRole('button', { name: 'Restart ICE', exact: true }).click();
  const second = await ready(2);
  expect(second).not.toBe(first);
  for (const page of [owner, phone])
    await expect(page.getByTestId('verification-state')).toHaveText('unverified');
  await ping();
  report.checks.push('ICE restart at epoch 2, fresh code, verification reset, signed ping/pong');
  await phone.getByRole('button', { name: 'New peer connection', exact: true }).click();
  expect(await ready(3)).not.toBe(second);
  await ping();
  report.checks.push('receiver-requested fresh peer connection at epoch 3, signed ping/pong');
  await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  for (const page of [owner, phone]) {
    await expect(page.getByTestId('live-room-state')).toHaveText('closed');
    await expect(page.getByTestId('peer-state')).toHaveText('closed');
  }
  report.checks.push('room revocation closes both peer transports');
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error =
    error instanceof Error
      ? error.message.split('\n').slice(0, 6).join('\n')
      : 'Physical browser test failed';
  for (const [name, page] of [
    ['desktop', owner],
    ['phone', phone],
  ]) {
    report[name] = await page
      .locator('[data-testid="peer-state"], [data-testid="peer-epoch"], [role="alert"]')
      .allTextContents()
      .catch(() => []);
  }
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(`${output}/phase-2-android.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  await phone.close().catch(() => {});
  await desktop.close();
  // Process exit disconnects CDP without closing the user's Chrome application.
}
process.exit(report.pass ? 0 : 1);
