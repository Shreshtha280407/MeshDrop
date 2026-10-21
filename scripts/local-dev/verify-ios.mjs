import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { connectOwnAndroidChrome } from './scoped-android-cdp.mjs';
import { connectNativeSafari } from './cloud-safari-webdriver.mjs';

// Opt-in real hardware test. The provider client is isolated from application dependencies.
const directory = resolve('.meshdrop-artifacts/device-cloud');
const credentialsPath = resolve(directory, '.env');
if ((await stat(credentialsPath)).mode & 0o077)
  throw new Error('Use mode 0600 for the private .env.');
const values = parseEnv(await readFile(credentialsPath, 'utf8'));
if (!values.BROWSERSTACK_USERNAME?.trim() || !values.BROWSERSTACK_ACCESS_KEY?.trim())
  throw new Error('Save BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in the private .env.');
const origin = process.env.MESHDROP_TEST_URL ?? 'https://meshdrop-8ab9cb08-preview.pages.dev';
const profile = process.env.MESHDROP_CLOUD_PROFILE ?? 'iphone';
const profiles = {
  iphone: {
    label: 'real cloud iPhone Safari',
    engine: 'webkit',
    deviceName: 'iPhone 15 Pro Max',
    osVersion: '26',
    platform: 'iPhone',
  },
  ipad: {
    label: 'real cloud iPad Safari',
    engine: 'webkit',
    deviceName: 'iPad Pro 13 2025',
    osVersion: '26',
    platform: 'iPad',
  },
  windows: {
    label: 'cloud Windows 11 Chromium',
    engine: 'chromium',
    os: 'Windows',
    osVersion: '11',
    platform: 'Win32',
  },
  'windows-chrome': {
    label: 'cloud Windows 11 Chrome',
    engine: 'chromium',
    browser: 'chrome',
    os: 'Windows',
    osVersion: '11',
    platform: 'Win32',
  },
  'macos-webkit': {
    label: 'cloud macOS Tahoe Playwright WebKit',
    engine: 'webkit',
    os: 'OS X',
    osVersion: 'Tahoe',
    platform: 'MacIntel',
  },
  'macos-safari': {
    label: 'cloud macOS Tahoe native Safari',
    engine: 'webdriver',
    os: 'OS X',
    osVersion: 'Tahoe',
    platform: 'MacIntel',
  },
};
const selected = profiles[profile];
if (!selected)
  throw new Error(
    'Choose iphone, ipad, windows, windows-chrome, macos-webkit or macos-safari cloud profile.',
  );
const colocated = process.env.MESHDROP_CLOUD_PEER === 'cloud';
if (colocated && profile !== 'windows')
  throw new Error('The colocated desktop network control is scoped to Windows.');
const direction = process.env.MESHDROP_IOS_DIRECTION ?? 'laptop-to-iphone';
if (profile !== 'iphone' && direction !== 'laptop-to-iphone')
  throw new Error('Additional cloud profiles currently receive from the laptop only.');
if (
  !['laptop-to-iphone', 'iphone-to-laptop', 'android-to-iphone', 'iphone-to-android'].includes(
    direction,
  )
)
  throw new Error(
    'Choose laptop-to-iphone, iphone-to-laptop, android-to-iphone or iphone-to-android.',
  );
const reverse = direction.startsWith('iphone-to-');
const android = direction.includes('android');
const serial = process.env.MESHDROP_ANDROID_SERIAL;
const recovery = process.env.MESHDROP_IOS_RECOVERY === 'true';
const fixtureMiB = Number(process.env.MESHDROP_CLOUD_FIXTURE_MIB ?? (recovery ? 8 : 1));
if (!Number.isInteger(fixtureMiB) || fixtureMiB < (recovery ? 2 : 1) || fixtureMiB > 8)
  throw new Error('Synthetic cloud fixtures must be 1–8 MiB, or 2–8 MiB for recovery.');
if (android && !serial)
  throw new Error('Set the authorized MESHDROP_ANDROID_SERIAL for Android tests.');
const adb = (...args) =>
  execFileSync('adb', ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const otherDevice = android
  ? 'physical OPPO Android Chrome'
  : colocated
    ? 'a separate Windows cloud browser context'
    : 'local laptop Chromium';
if (reverse && process.env.MESHDROP_IOS_RECOVERY === 'true')
  throw new Error('Reload recovery is currently scoped to the iPhone receiver.');
if (new URL(origin).origin !== origin || !origin.startsWith('https://'))
  throw new Error('Use an exact public HTTPS test origin.');
const clientDirectory = resolve(directory, 'tooling/node_modules/@playwright/test');
const clientVersion = JSON.parse(
  await readFile(resolve(clientDirectory, 'package.json'), 'utf8'),
).version;
if (!/^1\.63\./.test(clientVersion))
  throw new Error(
    'Install the documented BrowserStack client 1.63 in the isolated tooling folder.',
  );
const providerClient = await import(
  pathToFileURL(resolve(directory, 'tooling/node_modules/playwright-core/index.mjs')).href
);
const authorization =
  'Basic ' +
  Buffer.from(`${values.BROWSERSTACK_USERNAME}:${values.BROWSERSTACK_ACCESS_KEY}`).toString(
    'base64',
  );
const planResponse = await globalThis.fetch('https://api.browserstack.com/automate/plan.json', {
  headers: { Authorization: authorization },
  redirect: 'error',
  signal: globalThis.AbortSignal.timeout(20000),
});
if (!planResponse.ok || (await planResponse.json()).automate_plan !== 'Free')
  throw new Error('This runner requires the provider plan API to report Free.');

const id = randomUUID();
const report = {
  scope: reverse
    ? `real cloud iPhone Safari sending to ${otherDevice} over public HTTPS/WSS; synthetic source selected programmatically`
    : `${selected.label} receiving from ${otherDevice} over public HTTPS/WSS`,
  direction: colocated
    ? 'windows-to-windows'
    : profile === 'iphone'
      ? direction
      : `laptop-to-${profile}`,
  profile,
  peerScope: colocated
    ? 'two separate cloud browser contexts on one Windows host; no cross-network claim'
    : 'separate devices over public signaling',
  origin,
  plan: 'Free',
  clientVersion,
  caseId: id,
  pass: false,
  stage: 'connect',
  checks: [],
  nativeExportVerified: false,
  recoveryVerified: false,
  error: '',
};
const caps = {
  browser:
    selected.browser ??
    (selected.deviceName || selected.engine === 'webdriver'
      ? 'safari'
      : `playwright-${selected.engine}`),
  ...(selected.browser ? { browser_version: 'latest' } : {}),
  ...(selected.deviceName
    ? { deviceName: selected.deviceName, realMobile: 'true' }
    : { os: selected.os }),
  osVersion: selected.osVersion,
  name: `MeshDrop ${profile} transfer ${id}`,
  build: 'MeshDrop free iOS 2026-10-21',
  'browserstack.username': values.BROWSERSTACK_USERNAME,
  'browserstack.accessKey': values.BROWSERSTACK_ACCESS_KEY,
  'browserstack.playwrightVersion': clientVersion,
  'client.playwrightVersion': clientVersion,
  'browserstack.video': false,
  'browserstack.debug': false,
  'browserstack.networkLogs': false,
  'browserstack.local': false,
};
let iosBrowser, laptopBrowser, owner, receiver, iphone, laptop, androidConnection, androidPort;
async function state(page, name, expected, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const actual = await page
      .locator(`[data-testid="${name}"]`)
      .textContent()
      .catch(() => '');
    if (actual?.trim() === expected) return;
    await setTimeout(250);
  }
  throw new Error(`IOS_STATE_GATE_${name.replaceAll('-', '_').toUpperCase()}`);
}
async function compare() {
  const code = await owner.locator('[data-testid="pairing-code"]').textContent();
  if (!code || code !== (await receiver.locator('[data-testid="pairing-code"]').textContent()))
    throw new Error('IOS_PAIRING_CODE_MISMATCH');
  for (const page of [owner, receiver]) {
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).click();
    await clickButton(page, 'Confirm comparison');
  }
  for (const page of [owner, receiver])
    await state(page, 'remote-verification', 'Other device comparison: confirmed');
}
async function clickButton(page, name, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(
        (text) =>
          [...globalThis.document.querySelectorAll('button')].some(
            (button) => button.textContent?.trim() === text && !button.disabled,
          ),
        name,
      )
      .catch(() => false);
    if (ready) {
      try {
        await page.getByRole('button', { name, exact: true }).click({ timeout: 3000 });
        return;
      } catch {
        /* iOS adapter has no native locator auto-wait; recheck the actual UI. */
      }
    }
    await setTimeout(250);
  }
  throw new Error('IOS_BUTTON_READINESS_GATE_FAILED');
}
async function pair() {
  await clickButton(owner, 'Create invitation');
  await state(owner, 'connection-state', 'connected');
  const invitation = await owner
    .getByLabel('Private invitation link', { exact: true })
    .inputValue();
  await receiver.getByLabel('Join with an invitation', { exact: true }).fill(invitation);
  await clickButton(receiver, 'Request to join');
  await clickButton(owner, 'Approve receiver');
  await state(owner, 'peer-state', 'connected');
  await state(receiver, 'peer-state', 'connected');
  await compare();
}
async function providerNativeExport(name) {
  // Some iOS adapter versions do not forward Playwright executor arguments.
  // Try the provider's authenticated WebDriver executor for this exact test session.
  const options = {
    headers: { Authorization: authorization },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15000),
  };
  const buildsResponse = await globalThis.fetch(
    'https://api.browserstack.com/automate/builds.json?limit=10',
    options,
  );
  if (!buildsResponse.ok) return null;
  const builds = await buildsResponse.json();
  const build = builds.find((item) => item.automation_build?.name === caps.build)?.automation_build;
  if (!/^[a-f0-9]{40}$/.test(build?.hashed_id ?? '')) return null;
  const sessionsResponse = await globalThis.fetch(
    `https://api.browserstack.com/automate/builds/${build.hashed_id}/sessions.json`,
    { ...options, signal: globalThis.AbortSignal.timeout(15000) },
  );
  if (!sessionsResponse.ok) return null;
  const sessions = await sessionsResponse.json();
  const session = sessions.find(
    (item) => item.automation_session?.name === caps.name,
  )?.automation_session;
  if (!/^[a-f0-9]{40}$/.test(session?.hashed_id ?? '')) return null;
  report.providerDevice = { model: session.device, os: session.os, version: session.os_version };
  report.restExportChecks = [];
  for (const action of ['saveFile', 'getFileContent']) {
    const response = await globalThis.fetch(
      `https://hub.browserstack.com/wd/hub/session/${session.hashed_id}/execute/sync`,
      {
        method: 'POST',
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(15000),
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: `browserstack_executor: ${JSON.stringify({ action, ...(action === 'getFileContent' ? { arguments: { fileName: name } } : {}) })}`,
          args: [],
        }),
      },
    );
    report.restExportChecks.push({ action, status: response.status });
    if (response.ok) {
      const data = await response.json();
      if (action === 'getFileContent' && typeof data.value === 'string') return data.value;
    }
  }
  return null;
}
try {
  console.log(`Starting one ${selected.label} receive/export test on the verified Free plan.`);
  iosBrowser =
    selected.engine === 'webdriver'
      ? await connectNativeSafari(caps)
      : await providerClient[selected.engine].connect({
          wsEndpoint: `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`,
          timeout: 90000,
        });
  if (iosBrowser.nativeBrowser) report.nativeBrowser = iosBrowser.nativeBrowser;
  iphone = await (await iosBrowser.newContext()).newPage();
  await iphone.goto(origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  report.platform = await iphone.evaluate(() => ({
    userAgent: globalThis.navigator.userAgent,
    platform: globalThis.navigator.platform,
    secureContext: globalThis.isSecureContext,
    maxTouchPoints: globalThis.navigator.maxTouchPoints,
  }));
  const actualPlatform = report.platform.platform;
  const ipadDesktopMode =
    profile === 'ipad' && actualPlatform === 'MacIntel' && report.platform.maxTouchPoints > 1;
  if (actualPlatform !== selected.platform && !ipadDesktopMode)
    throw new Error('IOS_REAL_PLATFORM_REQUIRED');
  if (!report.platform.secureContext) throw new Error('IOS_SECURE_CONTEXT_REQUIRED');
  await state(iphone, 'capability-opfs', 'available');
  console.log(`${selected.label} shell/storage passed; pairing with ${otherDevice}.`);
  report.checks.push(`${selected.label} loads public shell and usable checkpoint storage`);
  if (android) {
    if (adb('get-state').trim() !== 'device') throw new Error('IOS_ANDROID_AUTHORIZATION_REQUIRED');
    adb('shell', 'am', 'start', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main');
    androidPort = adb('forward', 'tcp:0', 'localabstract:chrome_devtools_remote').trim();
    if (!/^\d+$/.test(androidPort)) throw new Error('IOS_ANDROID_DEBUG_PORT_INVALID');
    let version;
    const debugDeadline = Date.now() + 30000;
    while (Date.now() < debugDeadline) {
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${androidPort}/json/version`, {
          signal: globalThis.AbortSignal.timeout(3000),
        });
        if (response.ok) {
          version = await response.json();
          break;
        }
      } catch {
        /* Android may return from activity launch before its debug socket is ready. */
      }
      await setTimeout(500);
    }
    if (!version?.webSocketDebuggerUrl) throw new Error('IOS_ANDROID_DEBUG_UNAVAILABLE');
    const debugPath = new URL(version.webSocketDebuggerUrl).pathname;
    if (!/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(debugPath))
      throw new Error('IOS_ANDROID_DEBUG_PATH_INVALID');
    androidConnection = await connectOwnAndroidChrome(
      chromium,
      `ws://127.0.0.1:${androidPort}${debugPath}`,
    );
    laptop = await androidConnection.browser.contexts()[0].newPage();
    report.androidBrowser = androidConnection.browser.version();
    report.androidModel = adb('shell', 'getprop', 'ro.product.model').trim();
    report.androidOs = adb('shell', 'getprop', 'ro.build.version.release').trim();
    report.usbScope = 'debugging only; no reverse forwarding or application traffic';
  } else if (colocated) {
    laptop = await (await iosBrowser.newContext({ acceptDownloads: true })).newPage();
  } else {
    laptopBrowser = await chromium.launch();
    laptop = await (await laptopBrowser.newContext({ acceptDownloads: true })).newPage();
  }
  await laptop.goto(origin);
  owner = reverse ? iphone : laptop;
  receiver = reverse ? laptop : iphone;
  report.stage = 'pair';
  await pair();
  await clickButton(owner, 'Send signed ping');
  await state(receiver, 'received-pings', '1');
  await state(owner, 'received-pongs', '1');
  report.checks.push('public admission, real WebRTC, independently compared codes and signed ping');
  report.stage = 'transfer';
  const bytes = Buffer.alloc(fixtureMiB * 1024 ** 2, 91);
  const name = `meshdrop-ios-${id}.bin`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (recovery) {
    // Observe real committed progress and press Pause; storage and protocol state stay real.
    await receiver.evaluate(() => {
      const observer = new globalThis.MutationObserver(() => {
        const committed = Number(
          globalThis.document.querySelector('[data-testid="committed-bytes"]')?.textContent,
        );
        const button = [...globalThis.document.querySelectorAll('button')].find(
          (item) => item.textContent?.trim() === 'Pause transfer',
        );
        if (committed >= 1024 ** 2 && button) {
          observer.disconnect();
          button.click();
        }
      });
      observer.observe(globalThis.document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  }
  if (reverse) {
    await owner.evaluate(
      ({ name, size }) => {
        const input = globalThis.document.querySelector('#files-to-send');
        const data = new globalThis.DataTransfer();
        data.items.add(
          new globalThis.File([new Uint8Array(size).fill(91)], name, {
            type: 'application/octet-stream',
          }),
        );
        input.files = data.files;
        input.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
      },
      { name, size: bytes.length },
    );
    report.sourceSelection =
      'synthetic File assigned to the real input; native iOS picker not tested';
  } else {
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  }
  report.stage = 'offer';
  await clickButton(owner, 'Offer files');
  report.stage = 'accept';
  console.log('Fixture offered; checking the receiver storage policy.');
  for (let attempt = 0; attempt < 60; attempt++) {
    const strategy = await receiver
      .locator('[data-testid="receive-strategy"]')
      .textContent()
      .catch(() => '');
    if (strategy?.startsWith('Receive strategy:')) {
      report.receiveStrategy = strategy;
      break;
    }
    await setTimeout(250);
  }
  const limits = receiver.getByLabel(
    'I understand the storage and export limits and will keep both devices open',
    { exact: true },
  );
  if (await limits.isVisible()) await limits.click();
  await clickButton(receiver, 'Accept files');
  if (recovery) {
    await state(receiver, 'transfer-state', 'paused');
    await setTimeout(1000);
    const committed = Number(
      await receiver.locator('[data-testid="committed-bytes"]').textContent(),
    );
    if (committed < 1024 ** 2 || committed >= bytes.length)
      throw new Error('IOS_PARTIAL_CHECKPOINT_REQUIRED');
    report.reusedBytes = committed;
    report.stage = 'reload-recovery';
    console.log('Real iPhone retained partial bytes; reloading and renewing admission.');
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await owner.reload();
    await receiver.reload();
    await state(receiver, 'recovered-bytes', String(committed));
    await pair();
    await receiver.getByRole('button', { name: `Resume saved ${name}`, exact: true }).click();
    await state(receiver, 'transfer-state', 'reconnecting');
    await owner
      .getByLabel(`Reselect source ${name}`, { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await owner.getByRole('button', { name: `Prepare source ${name}`, exact: true }).click();
    await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
    await state(receiver, 'transfer-state', 'complete', 90000);
    await state(owner, 'reused-bytes', String(committed));
    await state(owner, 'attempt-bytes', String(bytes.length - committed));
    report.recoveryVerified = true;
    report.checks.push(
      'real iPhone reload rehashes its checkpoint; fresh admission/comparison and exact-source resume send only missing bytes',
    );
  }
  await state(receiver, 'transfer-state', 'complete', 90000);
  await state(owner, 'transfer-state', 'complete');
  await state(receiver, 'committed-bytes', String(bytes.length));
  await state(receiver, 'file-sha256', digest);
  report.bytes = bytes.length;
  report.sha256 = digest;
  report.checks.push(
    'receiver commits the entire fixture and completes final SHA-256 verification',
  );
  report.stage = 'native-export';
  const destination = resolve(directory, `${id}.bin`);
  if (android && reverse) {
    await clickButton(receiver, `Save ${name}`);
    const remotePath = `/sdcard/Download/${name}`;
    const deadline = Date.now() + 60000;
    let exported = false;
    while (Date.now() < deadline) {
      try {
        if (Number(adb('shell', 'stat', '-c', '%s', remotePath).trim()) === bytes.length) {
          exported = true;
          break;
        }
      } catch {
        /* Native download may still be writing. */
      }
      await setTimeout(500);
    }
    if (!exported) throw new Error('IOS_ANDROID_NATIVE_DOWNLOAD_MISSING');
    adb('pull', remotePath, destination);
    report.nativeExportRoute =
      'Android native Downloads; exact synthetic filename pulled for hashing';
  } else {
    const downloadEvent = receiver.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await clickButton(receiver, `Save ${name}`);
    const download = await downloadEvent;
    report.exportUiResult = await receiver
      .locator('[data-testid="file-export-result"]')
      .allTextContents();
    if (download) {
      await download.saveAs(destination);
      report.nativeExportRoute = reverse
        ? 'laptop Chromium browser download'
        : `${selected.label} download returned by the provider download stream`;
    } else {
      report.providerFileRetrievalAttempted = true;
      await receiver
        .evaluate(() => {}, 'browserstack_executor: {"action":"saveFile"}')
        .catch(() => {});
      let base64 = iosBrowser.nativeExport
        ? await iosBrowser.nativeExport(name)
        : await receiver
            .evaluate(
              () => {},
              `browserstack_executor: ${JSON.stringify({ action: 'getFileContent', arguments: { fileName: name } })}`,
            )
            .catch(() => null);
      if (typeof base64 !== 'string') base64 = await providerNativeExport(name).catch(() => null);
      if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/\s]+=*$/.test(base64))
        throw new Error('IOS_NATIVE_DOWNLOAD_NOT_OBSERVABLE');
      const retrieved = Buffer.from(base64, 'base64');
      if (retrieved.length !== bytes.length) throw new Error('IOS_EXPORTED_SIZE_MISMATCH');
      await writeFile(destination, retrieved);
      report.nativeExportRoute = `${selected.label} saved download returned by the provider file-retrieval executor`;
    }
  }
  if (
    createHash('sha256')
      .update(await readFile(destination))
      .digest('hex') !== digest
  )
    throw new Error('IOS_EXPORTED_DIGEST_MISMATCH');
  report.nativeExportVerified = true;
  report.checks.push('actual exported download independently hashes to the source digest');
  report.stage = 'complete';
  report.pass = true;
} catch (error) {
  // Playwright connection errors can embed the credential-bearing provider endpoint.
  const message = String(error?.message ?? '');
  report.error = message.match(/IOS_[A-Z_]+/)?.[0] ?? 'IOS_PROVIDER_OR_AUTOMATION_GATE_FAILED';
  report.errorKind = error?.name ?? 'Error';
  report.errorDetail = message
    .split('\n')[0]
    .replaceAll(values.BROWSERSTACK_ACCESS_KEY, '[redacted]')
    .replaceAll(values.BROWSERSTACK_USERNAME, '[redacted]')
    .replace(/wss:\/\/\S+/g, '[private endpoint]')
    .replace(/[A-Za-z0-9_-]{43,}/g, '[redacted token]')
    .slice(0, 180);
  for (const [name, page] of [
    [android ? 'android' : 'laptop', laptop],
    ['iphone', iphone],
  ]) {
    if (!page) continue;
    report[`${name}States`] = await page
      .locator(
        '[data-testid="peer-state"], [data-testid="connection-state"], [data-testid="transfer-state"]',
      )
      .allTextContents()
      .catch(() => []);
    report[`${name}Capabilities`] = await page
      .locator('.capability-list')
      .allTextContents()
      .catch(() => []);
    report[`${name}IcePath`] = await page
      .locator('[data-testid="ice-path"]')
      .allTextContents()
      .catch(() => []);
    report[`${name}StoragePolicy`] = await page
      .locator(
        '[data-testid="quota-preflight"], [data-testid="platform-limits"], [data-testid="receive-strategy"]',
      )
      .allTextContents()
      .catch(() => []);
  }
} finally {
  for (const page of [owner, receiver]) {
    if (!page) continue;
    await page
      .getByRole('button', { name: 'Clear transfer', exact: true })
      .click({ timeout: 2000 })
      .catch(() => {});
  }
  if (owner)
    await owner
      .getByRole('button', { name: 'Revoke room', exact: true })
      .click({ timeout: 3000 })
      .catch(() => {});
  await iosBrowser?.close().catch(() => {});
  await laptopBrowser?.close().catch(() => {});
  if (androidConnection) {
    await laptop?.close().catch(() => {});
    androidConnection.disconnect();
  }
  if (androidPort) {
    try {
      adb('forward', '--remove', `tcp:${androidPort}`);
    } catch {
      /* Reported device detach may prevent cleanup. */
    }
  }
  report.recordedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, `ios-${id}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
// A failed remote initialize can leave the client socket open until provider idle timeout.
process.exit(report.pass ? 0 : 1);
