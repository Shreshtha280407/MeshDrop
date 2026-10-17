/* global window, MutationObserver, document, RTCPeerConnection, fetch */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, mkdtemp, writeFile, readlink, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { pairPages } from '../../tests/helpers/peer.ts';
const baseURL = 'http://127.0.0.1:5173';
const blockBytes = 1024 ** 2,
  totalBytes = Number(process.env.MESHDROP_BENCH_BYTES ?? 1024 ** 3);
if (
  !Number.isSafeInteger(totalBytes) ||
  totalBytes < 10 * blockBytes ||
  totalBytes > 1024 ** 3 ||
  totalBytes % blockBytes
)
  throw new Error('Use 10–1024 whole MiB.');
const isolated =
  process.env.MESHDROP_ISOLATED_NETWORK === '1' &&
  process.env.MESHDROP_HOST_NETNS &&
  (await readlink('/proc/self/ns/net')) !== process.env.MESHDROP_HOST_NETNS &&
  /^\s*0\s+[1-9]\d*\s+1\s*$/m.test(await readFile('/proc/self/uid_map', 'utf8'));
if (!isolated) throw new Error('Run through bench:p5 in its guarded private network namespace.');
const directoryRoot = resolve('.meshdrop-artifacts/phase-5-resume');
await mkdir(directoryRoot, { recursive: true });
const directory = await mkdtemp(join(directoryRoot, 'run-')),
  source = join(directory, 'resume-source.bin');
const report = {
  phase: 'P5',
  pass: false,
  startedAt: new Date().toISOString(),
  totalBytes,
  targetBytes: Math.ceil((totalBytes / blockBytes) * 0.7) * blockBytes,
  directory,
  scope:
    'Two independent persistent Chromium processes; a real isolated Linux network namespace changes its sole candidate interface/subnet from 10.90.0.2/24 to 10.91.0.2/24. No host routes/interfaces changed. This is controlled network migration, not a physical Wi-Fi/mobile or public-NAT certification.',
  browserFlag:
    '--disable-features=WebRtcHideLocalIpsWithMdns (test processes only; application defaults unchanged)',
};
let ownerContext, receiverContext;
async function fixture() {
  const handle = await open(source, 'wx');
  const hash = createHash('sha256');
  try {
    const block = Buffer.alloc(blockBytes);
    for (let index = 0; index < totalBytes / blockBytes; index++) {
      for (let at = 0; at < block.length; at++) block[at] = (at * 31 + index * 17) % 251;
      hash.update(block);
      let written = 0;
      while (written < block.length)
        written += (await handle.write(block, written, block.length - written)).bytesWritten;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: blockBytes }))
    hash.update(chunk);
  return hash.digest('hex');
}
async function selected(page) {
  return page.evaluate(async () => {
    const pc = window.__meshdropP5Peers.at(-1);
    const stats = await pc.getStats();
    let pair;
    stats.forEach((stat) => {
      if (stat.type === 'transport' && stat.selectedCandidatePairId)
        pair = stats.get(stat.selectedCandidatePairId);
    });
    if (!pair)
      stats.forEach((stat) => {
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated)
          pair = stat;
      });
    const local = pair && stats.get(pair.localCandidateId),
      remote = pair && stats.get(pair.remoteCandidateId);
    return {
      local: local?.address,
      remote: remote?.address,
      localType: local?.candidateType,
      remoteType: remote?.candidateType,
      protocol: local?.protocol,
    };
  });
}
async function compare(owner, receiver) {
  for (const page of [owner, receiver])
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 60000 });
  const code = await owner.getByTestId('pairing-code').textContent();
  expect(await receiver.getByTestId('pairing-code').textContent()).toBe(code);
  for (const page of [owner, receiver]) {
    await page.getByLabel('Code shown on the other device', { exact: true }).fill(code);
    await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
    await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
  }
  for (const page of [owner, receiver])
    await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
}
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${baseURL}/`)).ok && (await fetch('http://127.0.0.1:8787/health')).ok)
        break;
    } catch {
      // Local servers are still starting.
    }
    if (attempt === 119) throw new Error('Isolated app servers did not become ready.');
    await setTimeout(500);
  }
  report.expectedSha256 = await fixture();
  const launch = async (profile) => {
    const context = await chromium.launchPersistentContext(join(directory, profile), {
      headless: true,
      baseURL,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1080 },
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
    await context.addInitScript(() => {
      globalThis.__name ??= (value) => value;
      window.__meshdropP5Peers = [];
      const Original = RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(...args) {
          super(...args);
          window.__meshdropP5Peers.push(this);
        }
      };
    });
    return context;
  };
  ownerContext = await launch('owner-profile');
  receiverContext = await launch('receiver-profile');
  report.browser = ownerContext.browser()?.version();
  const owner = ownerContext.pages()[0],
    receiver = receiverContext.pages()[0];
  await pairPages(owner, receiver);
  report.beforePath = await selected(owner);
  report.connectionsBefore = await owner.evaluate(() => window.__meshdropP5Peers.length);
  expect(report.beforePath.local).toBe('10.90.0.2');
  expect(report.beforePath.remote).toBe('10.90.0.2');
  await receiver.evaluate((target) => {
    const observer = new MutationObserver(() => {
      if (
        Number(document.querySelector('[data-testid="committed-bytes"]')?.textContent ?? 0) >=
        target
      ) {
        const button = [...document.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Pause transfer',
        );
        if (button) {
          button.click();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, report.targetBytes);
  await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(source);
  await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
  await receiver
    .getByRole('button', { name: 'Accept files', exact: true })
    .click({ timeout: 300000 });
  for (const page of [owner, receiver])
    await expect(page.getByTestId('transfer-state')).toHaveText('paused', { timeout: 300000 });
  await setTimeout(1000);
  report.committedBefore = Number(await receiver.getByTestId('committed-bytes').textContent());
  expect(report.committedBefore).toBeGreaterThanOrEqual(report.targetBytes);
  expect(report.committedBefore).toBeLessThan(totalBytes);
  report.interruptedPercent = (100 * report.committedBefore) / totalBytes;
  await receiver.screenshot({ path: join(directory, 'before-network-change.png'), fullPage: true });
  execFileSync('ip', ['link', 'delete', 'meshdrop-a']);
  execFileSync('ip', ['link', 'add', 'meshdrop-b', 'type', 'dummy']);
  execFileSync('ip', ['address', 'add', '10.91.0.2/24', 'dev', 'meshdrop-b']);
  execFileSync('ip', ['link', 'set', 'meshdrop-b', 'up']);
  execFileSync('ip', ['route', 'add', 'default', 'dev', 'meshdrop-b']);
  report.networkChangedAt = new Date().toISOString();
  // Explicit retry uses ICE restart first. A timed-out attempt falls back through the bounded policy.
  await owner.getByRole('button', { name: 'Restart ICE', exact: true }).click();
  await expect
    .poll(async () => Number(await owner.getByTestId('peer-epoch').textContent()), {
      timeout: 90000,
    })
    .toBeGreaterThan(1);
  await compare(owner, receiver);
  report.resumeEpoch = Number(await owner.getByTestId('peer-epoch').textContent());
  report.afterPath = await selected(owner);
  report.connectionsAfter = await owner.evaluate(() => window.__meshdropP5Peers.length);
  expect(report.afterPath.local).toBe('10.91.0.2');
  expect(report.afterPath.remote).toBe('10.91.0.2');
  await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
  await expect(owner.getByTestId('resume-state')).toContainText('Source ready', {
    timeout: 300000,
  });
  const resumedAt = Date.now();
  await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
  for (const page of [owner, receiver])
    await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 300000 });
  report.resumeDurationMs = Date.now() - resumedAt;
  report.reusedBytes = Number(await owner.getByTestId('reused-bytes').textContent());
  report.payloadBytesSentAfterResume = Number(
    await owner.getByTestId('attempt-bytes').textContent(),
  );
  expect(report.reusedBytes).toBe(report.committedBefore);
  expect(report.payloadBytesSentAfterResume).toBe(totalBytes - report.reusedBytes);
  const download = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Save resume-source.bin', exact: true }).click();
  const output = join(directory, 'received.bin');
  await (await download).saveAs(output);
  report.actualSha256 = await fileHash(output);
  expect(report.actualSha256).toBe(report.expectedSha256);
  const receiptDownload = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Save transfer receipt', exact: true }).click();
  await (await receiptDownload).saveAs(join(directory, 'receipt.json'));
  report.receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
  expect(report.receipt.epoch).toBe(report.resumeEpoch);
  expect(report.receipt.files[0].sha256).toBe(report.actualSha256);
  await receiver.screenshot({ path: join(directory, 'resumed-complete.png'), fullPage: true });
  await owner.screenshot({ path: join(directory, 'sender-missing-only.png'), fullPage: true });
  report.pass = true;
  report.completedAt = new Date().toISOString();
  console.log(
    `P5 passed: reused ${report.reusedBytes}; sent ${report.payloadBytesSentAfterResume}; SHA-256 exact.`,
  );
  await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  for (const [name, context] of [
    ['owner', ownerContext],
    ['receiver', receiverContext],
  ]) {
    const page = context?.pages()[0];
    if (!page) continue;
    report[`${name}Diagnostics`] = await page
      .locator('.signaling-panel')
      .innerText()
      .catch(() => 'Page unavailable.');
    await page
      .screenshot({ path: join(directory, `${name}-failure.png`), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await ownerContext?.close().catch(() => {});
  await receiverContext?.close().catch(() => {});
  await writeFile(join(directory, 'phase-5-resume.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.pass) {
    for (const name of ['owner-profile', 'receiver-profile', 'resume-source.bin', 'received.bin'])
      await rm(join(directory, name), { recursive: true, force: true });
  }
  console.log(`Evidence: ${join(directory, 'phase-5-resume.json')}`);
}
