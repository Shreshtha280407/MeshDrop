/* global document, window, navigator, MutationObserver -- evaluated in the test browser */
import { chromium, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setInterval, clearInterval } from 'node:timers';
import { connectOwnAndroidChrome } from './scoped-android-cdp.mjs';

// Explicitly opt in with the serial of an authorized, unlocked Android device.
// Set up adb reverse tcp:5173 tcp:5173 and forward tcp:9223 localabstract:chrome_devtools_remote.
const serial = process.env.MESHDROP_ANDROID_SERIAL;
if (!serial) throw new Error('Set MESHDROP_ANDROID_SERIAL to the authorized test device.');
const base = process.env.MESHDROP_TEST_URL ?? 'http://127.0.0.1:5173';
const output = process.env.MESHDROP_EVIDENCE_DIR ?? '/tmp/meshdrop-p7-android';
await mkdir(output, { recursive: true });
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
console.log('Launching desktop test browser');
const desktop = await chromium.launch();
const owner = await desktop.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
console.log('Connecting to authorized Android Chrome');
// Keep native download handling and actual focus/visibility; default driver overrides
// would intercept Android downloads and force pages to appear foregrounded.
const connection = await connectOwnAndroidChrome(chromium, 'ws://127.0.0.1:9223/devtools/browser');
const remote = connection.browser;
const browserCdp = { send: connection.request };
// Do not enumerate, navigate, or close any personal tabs.
const phone = await remote.contexts()[0].newPage();
const phoneCdp = { send: connection.pageRequest };
adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
await phone.bringToFront();
for (const page of [owner, phone]) page.setDefaultTimeout(30000);
console.log('Created isolated test tabs');
const report = {
  kind: 'physical-android-phase-7',
  startedAt: new Date().toISOString(),
  phoneBrowser: remote.version(),
  desktopBrowser: desktop.version(),
  scope:
    'USB forwards local signaling only. Real WebRTC carries files. Synthetic sources selected programmatically; no personal files or tabs inspected. Automated comparison is a UI check, not a human identity attestation.',
  checks: [],
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let cameraOverride = false;
let previousCameraPermission = 'prompt';
let progressTimer;
async function compare(a, b) {
  for (const page of [a, b])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 60000 });
  const code = await a.getByTestId('pairing-code').textContent();
  expect(await b.getByTestId('pairing-code').textContent()).toBe(code);
  for (const page of [a, b]) {
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
  }
  for (const page of [a, b])
    await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
}
async function pair(a, b) {
  console.log('Pairing test devices');
  adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
  await phone.bringToFront();
  await expect.poll(() => phone.evaluate(() => document.visibilityState)).toBe('visible');
  await a.goto(base);
  await a.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitation = await a.getByLabel('Private invitation link', { exact: true }).inputValue();
  await b.goto(base);
  await b.getByLabel('Join with an invitation', { exact: true }).fill(invitation);
  await b.getByRole('button', { name: 'Request to join', exact: true }).click();
  await a.getByRole('button', { name: 'Approve receiver', exact: true }).click();
  await compare(a, b);
}
async function pauseAt(page, target) {
  await page.evaluate((target) => {
    const observer = new MutationObserver(() => {
      if (
        Number(document.querySelector('[data-testid="committed-bytes"]')?.textContent) >= target
      ) {
        const button = [...document.querySelectorAll('button')].find(
          (node) => node.textContent?.trim() === 'Pause transfer',
        );
        if (button) {
          button.click();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, target);
}
async function offer(a, b, name, buffer, source) {
  await a
    .getByLabel('Choose files to send', { exact: true })
    .setInputFiles(source ?? { name, mimeType: 'application/octet-stream', buffer });
  await a.getByRole('button', { name: 'Offer files', exact: true }).click();
  const ack = b.getByRole('checkbox', { name: /understand.*limits/i });
  if (await ack.count()) await ack.check();
  await b.getByRole('button', { name: 'Accept files', exact: true }).click();
}
async function savedBytes(page, name, buffer, isPhone) {
  const downloading = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  await page.getByRole('button', { name: `Save ${name}`, exact: true }).click();
  if (isPhone) {
    // Read only the exact synthetic filename created by this run, never list Downloads.
    await expect
      .poll(
        () => {
          try {
            return Number(adb('shell', 'stat', '-c', '%s', `/sdcard/Download/${name}`).trim());
          } catch {
            return -1;
          }
        },
        { timeout: 45000 },
      )
      .toBe(buffer.length);
    const path = `${output}/${name}`;
    adb('pull', `/sdcard/Download/${name}`, path);
    expect(sha(await readFile(path))).toBe(sha(buffer));
    // Deliberately leave the verified test download on the phone; deletion is a user action.
    return {
      export: 'real Android Chrome download, ADB pulled exact synthetic file',
      sha256: sha(buffer),
    };
  }
  const download = await downloading;
  if (!download) throw new Error('Expected a desktop download');
  const path = `${output}/${name}`;
  await download.saveAs(path);
  expect(sha(await readFile(path))).toBe(sha(buffer));
  return { export: 'real desktop browser download', sha256: sha(buffer) };
}
async function record(value) {
  report.checks.push(value);
  await writeFile(`${output}/phase-7-android.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(value));
}
try {
  await phone.goto(base);
  await expect(phone.getByTestId('capability-opfs')).toHaveText('available', { timeout: 15000 });
  report.capabilities = await phone.getByTestId('mobile-capabilities').innerText();
  report.layoutFits = await phone.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(report.layoutFits).toBe(true);
  const stamp = Date.now();
  for (const direction of process.env.MESHDROP_MOBILE_SKIP_BASIC === '1'
    ? []
    : ['laptop-to-android', 'android-to-laptop']) {
    const a = direction === 'laptop-to-android' ? owner : phone;
    const b = direction === 'laptop-to-android' ? phone : owner;
    const name = `meshdrop-p7-${stamp}-${direction}.bin`,
      buffer = Buffer.alloc(8 * 1024 ** 2, 79);
    await pair(a, b);
    const start = Date.now();
    await offer(a, b, name, buffer);
    for (const page of [a, b])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 120000 });
    const result = await savedBytes(b, name, buffer, b === phone);
    await record({
      direction,
      bytes: buffer.length,
      completeMs: Date.now() - start,
      path: await a.getByTestId('ice-path').textContent(),
      ...result,
    });
    await a.getByRole('button', { name: 'Revoke room', exact: true }).click();
  }
  if (process.env.MESHDROP_MOBILE_INTERRUPTION === '1') {
    const name = `meshdrop-p7-${stamp}-recovery.bin`,
      buffer = Buffer.alloc(32 * 1024 ** 2, 47);
    await pair(owner, phone);
    await pauseAt(phone, 2 * 1024 ** 2);
    await offer(owner, phone, name, buffer);
    await expect(phone.getByTestId('transfer-state')).toHaveText('paused', { timeout: 60000 });
    const committed = Number(await phone.getByTestId('committed-bytes').textContent());
    console.log(`Paused physical receiver at ${committed} committed bytes`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await expect
      .poll(() => phone.evaluate(() => document.visibilityState), { timeout: 10000 })
      .toBe('hidden');
    adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
    await phone.bringToFront();
    await expect.poll(() => phone.evaluate(() => document.visibilityState)).toBe('visible');
    await expect(phone.getByTestId('lifecycle-message')).toContainText('foreground');
    await expect(phone.getByTestId('transfer-state')).toHaveText('paused');
    console.log('Physical app switch returned without automatic resume');
    await phone.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    for (const page of [owner, phone])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 120000 });
    await savedBytes(phone, name, buffer, true);
    console.log('Resumed physical download hash matches; checking reloaded checkpoints');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await phone.reload();
    await expect(phone.getByTestId('saved-transfers')).toContainText(name, { timeout: 60000 });
    await phone.getByRole('button', { name: `Export saved ${name}`, exact: true }).click();
    await expect(phone.getByTestId('saved-transfers')).toContainText('Tap Save', {
      timeout: 60000,
    });
    await record({
      direction: 'android-app-switch-and-reload',
      bytes: buffer.length,
      pausedCommittedBytes: committed,
      appSwitchObserved: true,
      explicitResume: true,
      reloadRevalidatedExportPrepared: true,
      sha256: sha(buffer),
    });
  }
  if (process.env.MESHDROP_MOBILE_LARGE === '1') {
    const name = `meshdrop-p7-${stamp}-320MiB.bin`,
      buffer = Buffer.alloc(320 * 1024 ** 2, 53);
    const source = `${output}/${name}`;
    await writeFile(source, buffer);
    await pair(owner, phone);
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(source);
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await expect(phone.getByRole('button', { name: 'Accept files', exact: true })).toBeDisabled({
      timeout: 60000,
    });
    await phone
      .getByLabel('I understand the storage and export limits and will keep both devices open', {
        exact: true,
      })
      .check();
    const start = Date.now();
    await phone.getByRole('button', { name: 'Accept files', exact: true }).click();
    console.log('Accepted 320 MiB after explicit large-file acknowledgement');
    let readingProgress = false;
    progressTimer = setInterval(async () => {
      if (readingProgress) return;
      readingProgress = true;
      try {
        report.lastProgress = await phone.evaluate(() => ({
          state: document.querySelector('[data-testid="transfer-state"]')?.textContent,
          committedBytes: Number(
            document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0,
          ),
          visibility: document.visibilityState,
        }));
        console.log(
          JSON.stringify({ progress: report.lastProgress, elapsedMs: Date.now() - start }),
        );
      } catch {
        /* Final shutdown can race one observation. */
      } finally {
        readingProgress = false;
      }
    }, 20000);
    for (const page of [owner, phone])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 600000 });
    const result = await savedBytes(phone, name, buffer, true);
    await record({
      direction: 'laptop-to-android-large',
      bytes: buffer.length,
      completeMs: Date.now() - start,
      acknowledgementRequired: true,
      ...result,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  }
  if (process.env.MESHDROP_MOBILE_LIFECYCLE === '1') {
    const name = `meshdrop-p7-${stamp}-lock-network-reload.bin`,
      buffer = Buffer.alloc(32 * 1024 ** 2, 83);
    await pair(owner, phone);
    await pauseAt(phone, 2 * 1024 ** 2);
    await offer(owner, phone, name, buffer);
    await expect(phone.getByTestId('transfer-state')).toHaveText('paused', { timeout: 60000 });
    const committed = Number(await phone.getByTestId('committed-bytes').textContent());
    console.log('Testing physical screen sleep and wake with a committed paused checkpoint');
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP');
    await expect
      .poll(() => phone.evaluate(() => document.visibilityState), { timeout: 10000 })
      .toBe('hidden');
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    // No PIN, credential or keyguard bypass. An unlocked test device is required.
    adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
    await phone.bringToFront();
    await expect
      .poll(() => phone.evaluate(() => document.visibilityState), { timeout: 30000 })
      .toBe('visible');
    await expect(phone.getByTestId('transfer-state')).toHaveText('paused');
    // CDP network emulation affects this test target only; it is not physical Wi-Fi roaming.
    await phoneCdp.send('Network.enable');
    await phoneCdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await expect(phone.getByTestId('lifecycle-message')).toContainText('lost connectivity');
    await expect(phone.getByTestId('transfer-state')).toHaveText('reconnecting');
    await phoneCdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await owner.reload();
    await phone.reload();
    await expect(phone.getByTestId('saved-transfers')).toContainText(name, { timeout: 60000 });
    const retained = phone.getByTestId('saved-checkpoint').filter({ hasText: name });
    await expect(retained.getByTestId('recovered-bytes')).toHaveText(String(committed));
    await pair(owner, phone);
    await owner
      .getByLabel(`Reselect source ${name}`, { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: `Prepare source ${name}`, exact: true }).click();
    await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
    await phone.getByRole('button', { name: `Resume saved ${name}`, exact: true }).click();
    for (const page of [owner, phone])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 120000 });
    await expect(owner.getByTestId('reused-bytes')).toHaveText(String(committed));
    const result = await savedBytes(phone, name, buffer, true);
    await record({
      direction: 'android-lock-injected-offline-reload',
      bytes: buffer.length,
      screenSleepWake: true,
      network: 'CDP offline/online injection on real handset; not physical roaming',
      renewedAdmissionAndComparison: true,
      reusedBytes: committed,
      attemptBytes: Number(await owner.getByTestId('attempt-bytes').textContent()),
      ...result,
    });
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await phone.reload();
    previousCameraPermission = await phone.evaluate(
      async () => (await navigator.permissions.query({ name: 'camera' })).state,
    );
    await browserCdp.send('Browser.setPermission', {
      permission: { name: 'camera' },
      setting: 'granted',
      origin: base,
    });
    cameraOverride = true;
    await phone.getByRole('button', { name: 'Scan invitation with camera', exact: true }).click();
    await expect
      .poll(() => phone.locator('video').evaluate((video) => video.videoWidth), { timeout: 15000 })
      .toBeGreaterThan(0);
    const tracks = await phone.locator('video').evaluate((video) => {
      window.meshdropTestCameraTracks = video.srcObject.getTracks();
      return window.meshdropTestCameraTracks.length;
    });
    await phone.getByRole('button', { name: 'Stop camera', exact: true }).click();
    expect(
      await phone.evaluate(() =>
        window.meshdropTestCameraTracks.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    await record({
      direction: 'android-real-camera',
      tracks,
      framesReadable: true,
      tracksStopped: true,
      scope:
        'Real camera opened, dimensions observed and tracks stopped. No frame artifacts saved or uploaded; optical QR scan not certified.',
    });
  }
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error =
    error instanceof Error
      ? error.message.split('\n').slice(0, 8).join('\n')
      : 'Device test failed';
  console.error(report.error);
} finally {
  clearInterval(progressTimer);
  await phoneCdp
    .send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
    .catch(() => {});
  if (cameraOverride)
    await browserCdp
      .send('Browser.setPermission', {
        permission: { name: 'camera' },
        setting: previousCameraPermission,
        origin: base,
      })
      .catch(() => {});
  report.completedAt = new Date().toISOString();
  await writeFile(`${output}/phase-7-android.json`, `${JSON.stringify(report, null, 2)}\n`);
  await phone.close().catch(() => {});
  connection.disconnect();
  await desktop.close();
}
process.exit(report.pass ? 0 : 1);
