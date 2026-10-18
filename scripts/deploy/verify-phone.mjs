/* global navigator, document, fetch, AbortSignal -- evaluated in the test tab or Node runtime */
import { chromium, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connectOwnAndroidChrome } from '../local-dev/scoped-android-cdp.mjs';
import { pauseAt } from '../../tests/helpers/diagnostics.ts';
import { observeRtc, rtcObservations } from '../local-dev/observe-rtc.mjs';

const serial = process.env.MESHDROP_ANDROID_SERIAL;
if (!serial) throw new Error('Set the authorized Android serial.');
const mobile = process.env.MESHDROP_PHONE_NETWORK === 'mobile';
const base = process.env.MESHDROP_TEST_URL;
if (!base || new URL(base).protocol !== 'https:') throw new Error('Use a deployed HTTPS origin.');
const stamp = Date.now();
const output = `.meshdrop-artifacts/phase-9/phone-${stamp}`;
await mkdir(output, { recursive: true });
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalMobileData = adb('shell', 'settings', 'get', 'global', 'mobile_data').trim();
const desktop = await chromium.launch();
const context = await desktop.newContext({ acceptDownloads: true, baseURL: base });
const owner = await context.newPage();
adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
const version = await (await fetch('http://127.0.0.1:9223/json/version')).json();
const debuggerPath = new URL(version.webSocketDebuggerUrl).pathname;
if (!/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(debuggerPath))
  throw new Error('Unexpected Android debugging endpoint.');
const connection = await connectOwnAndroidChrome(chromium, `ws://127.0.0.1:9223${debuggerPath}`);
const phone = await connection.browser.contexts()[0].newPage();
// Only this newly-created target is attached; personal tabs remain untouched.
const report = {
  phase: 'P9',
  scope: mobile
    ? 'physical Oppo existing mobile data and laptop; public HTTPS/WSS; 1 MiB synthetic file'
    : 'physical Oppo and laptop; public HTTPS/WSS; real Wi-Fi disconnect; synthetic files only',
  origin: new URL(base).origin,
  desktopBrowser: desktop.version(),
  phoneBrowser: connection.browser.version(),
  pass: false,
  checks: [],
};
report.transport = { cspErrors: 0, failedHttpStatuses: [] };
for (const page of [owner, phone]) {
  await page.addInitScript(observeRtc);
  page.on('console', (message) => {
    if (/content security policy|connect-src/i.test(message.text())) report.transport.cspErrors++;
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/v1/') && response.status() >= 400)
      report.transport.failedHttpStatuses.push(response.status());
  });
}
let stage = 'open';
let networkChanged = false;
const clientAssets = (page) =>
  page.evaluate(
    'Array.from(document.scripts, script => new URL(script.src, location.href).pathname)',
  );
function checkpoint(next) {
  stage = next;
  console.log(JSON.stringify({ phase: 'P9', stage }));
}
async function foreground() {
  adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
  await phone.bringToFront();
  await expect
    .poll(() => phone.evaluate(() => document.visibilityState), { timeout: 15000 })
    .toBe('visible');
}
async function compare() {
  for (const page of [owner, phone])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 90000 });
  const code = await owner.getByTestId('pairing-code').textContent();
  expect(await phone.getByTestId('pairing-code').textContent()).toBe(code);
  for (const page of [owner, phone]) {
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
  }
  for (const page of [owner, phone])
    await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
}
async function exportPhone(name, expected) {
  await phone.getByRole('button', { name: `Save ${name}`, exact: true }).click();
  const remotePath = `/sdcard/Download/${name}`;
  await expect
    .poll(
      () => {
        try {
          return Number(adb('shell', 'stat', '-c', '%s', remotePath).trim());
        } catch {
          return -1;
        }
      },
      { timeout: 60000 },
    )
    .toBe(expected.length);
  const localPath = `${output}/${name}`;
  adb('pull', remotePath, localPath);
  expect(hash(await readFile(localPath))).toBe(hash(expected));
}
async function exportJson(button, filename) {
  const event = owner.waitForEvent('download');
  await owner.getByRole('button', { name: button, exact: true }).click();
  await (await event).saveAs(`${output}/${filename}`);
  return JSON.parse(await readFile(`${output}/${filename}`, 'utf8'));
}
try {
  for (const page of [owner, phone]) page.setDefaultTimeout(30000);
  await foreground();
  const shell = await fetch(base, { signal: AbortSignal.timeout(20000) });
  const modulePath = (await shell.text()).match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  if (!shell.ok || !modulePath) throw new Error('Current deployment shell unavailable.');
  await phone.goto(base);
  if (!(await clientAssets(phone)).includes(modulePath)) {
    // Bypass a stale shell only in this owned target. Personal tabs, cookies,
    // service-worker registrations and shared browser storage remain intact.
    await connection.pageRequest('Network.setBypassServiceWorker', { bypass: true });
    await connection.pageRequest('Network.setCacheDisabled', { cacheDisabled: true });
    await phone.reload();
    report.testTabBypassedStaleShell = true;
  }
  await expect.poll(async () => (await clientAssets(phone)).includes(modulePath)).toBe(true);
  await expect(phone.getByTestId('capability-opfs')).toHaveText('available', { timeout: 30000 });
  if (mobile) {
    checkpoint('existing-mobile-network');
    if (originalMobileData !== '1') throw new Error('Existing mobile data is disabled.');
    networkChanged = true;
    adb('shell', 'svc', 'wifi', 'disable');
    await expect
      .poll(() => adb('shell', 'settings', 'get', 'global', 'wifi_on').trim(), {
        timeout: 15000,
      })
      .toBe('0');
    await expect.poll(() => phone.evaluate(() => navigator.onLine), { timeout: 30000 }).toBe(true);
  }
  await owner.goto(base);
  report.clientAssets = { laptop: await clientAssets(owner), phone: await clientAssets(phone) };
  checkpoint('create');
  await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
  checkpoint('owner-signaling');
  await expect(owner.getByTestId('connection-state')).toHaveText('connected', { timeout: 30000 });
  const invitation = await owner
    .getByLabel('Private invitation link', { exact: true })
    .inputValue();
  checkpoint('join');
  await phone.getByLabel('Join with an invitation', { exact: true }).fill(invitation);
  await phone.getByRole('button', { name: 'Request to join', exact: true }).click();
  checkpoint('approve');
  await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
  await expect(phone.getByTestId('connection-state')).toHaveText('connected', { timeout: 30000 });
  report.publicControlPlanePassed = true;
  checkpoint('peer-connect-and-compare');
  await compare();
  for (const size of mobile ? [1024 ** 2] : [8 * 1024 ** 2, 32 * 1024 ** 2]) {
    const recovery = size > 8 * 1024 ** 2;
    const name = `meshdrop-p9-${stamp}-${recovery ? 'recovery' : 'basic'}.bin`;
    const buffer = Buffer.alloc(size, recovery ? 47 : 79);
    checkpoint(recovery ? 'recovery-offer' : 'basic-offer');
    if (recovery) await pauseAt(phone, Math.floor(size * 0.7));
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await phone.getByRole('button', { name: 'Accept files', exact: true }).click();
    let retainedBytes = 0;
    const previousEpoch = Number(await owner.getByTestId('peer-epoch').textContent());
    let resumedEpoch = null;
    if (recovery) {
      await expect(phone.getByTestId('transfer-state')).toHaveText('paused', { timeout: 120000 });
      retainedBytes = Number(await phone.getByTestId('committed-bytes').textContent());
      checkpoint('physical-disconnect');
      networkChanged = true;
      // Prevent mobile-data fallback from hiding the Wi-Fi outage.
      adb('shell', 'svc', 'data', 'disable');
      adb('shell', 'svc', 'wifi', 'disable');
      await expect
        .poll(() => phone.evaluate(() => navigator.onLine), { timeout: 30000 })
        .toBe(false);
      report.physicalOfflineObserved = true;
      await expect(phone.getByTestId('transfer-state')).toHaveText('reconnecting', {
        timeout: 30000,
      });
      adb('shell', 'svc', 'wifi', 'enable');
      await expect
        .poll(() => phone.evaluate(() => navigator.onLine), { timeout: 60000 })
        .toBe(true);
      if (originalMobileData === '1') adb('shell', 'svc', 'data', 'enable');
      networkChanged = false;
      checkpoint('fresh-comparison');
      await foreground();
      await compare();
      resumedEpoch = Number(await owner.getByTestId('peer-epoch').textContent());
      expect(resumedEpoch).toBeGreaterThan(previousEpoch);
      await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
      await expect(owner.getByTestId('resume-state')).toContainText('Source ready', {
        timeout: 60000,
      });
      await phone.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
    }
    checkpoint(recovery ? 'recovery-completion' : 'basic-completion');
    for (const page of [owner, phone])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 180000 });
    await expect(phone.getByTestId('file-sha256')).toHaveText(hash(buffer));
    if (recovery) {
      for (const page of [owner, phone])
        await expect(page.getByTestId('peer-epoch')).toHaveText(String(resumedEpoch));
      await expect(owner.getByTestId('reused-bytes')).toHaveText(String(retainedBytes));
      await expect(owner.getByTestId('attempt-bytes')).toHaveText(String(size - retainedBytes));
    }
    checkpoint('native-export');
    await exportPhone(name, buffer);
    const receipt = await exportJson('Save transfer receipt', `${size}-receipt.json`);
    expect(receipt.totalBytes).toBe(size);
    expect(receipt.files[0].sha256).toBe(hash(buffer));
    await exportJson('Export diagnostics JSON', `${size}-diagnostics.json`);
    report.checks.push({
      bytes: size,
      recovery,
      retainedBytes,
      previousEpoch,
      resumedEpoch,
      sha256: hash(buffer),
      connectionPath: await owner.getByTestId('metric-connection-path').textContent(),
      nativeAndroidDownloadVerified: true,
      receiptVerified: true,
      diagnosticsExported: true,
    });
    await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
    for (const page of [owner, phone])
      await page.getByRole('button', { name: 'Clear transfer', exact: true }).click();
  }
  await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  report.pass = true;
} catch {
  report.failureStage = stage;
  report.error = 'PUBLIC_PHYSICAL_DEVICE_GATE_FAILED';
  report.states = {};
  report.rtc = {};
  for (const [name, page] of [
    ['laptop', owner],
    ['phone', phone],
  ]) {
    report.rtc[name] = await rtcObservations(page);
    report.states[name] = {};
    for (const field of [
      'connection-state',
      'admission-state',
      'peer-state',
      'peer-epoch',
      'transfer-state',
    ])
      report.states[name][field] = await page
        .getByTestId(field)
        .textContent({ timeout: 1000 })
        .catch(() => 'unavailable');
  }
} finally {
  if (networkChanged) {
    adb('shell', 'svc', 'wifi', 'enable');
    if (originalMobileData === '1') adb('shell', 'svc', 'data', 'enable');
  }
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: output }));
  await phone.close().catch(() => {});
  connection.disconnect();
  await desktop.close();
}
process.exit(report.pass ? 0 : 1);
