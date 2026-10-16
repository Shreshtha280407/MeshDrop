import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pairPages } from '../../tests/helpers/peer.ts';

const baseURL = process.env.MESHDROP_TEST_URL ?? 'http://127.0.0.1:5173';
const artifactRoot = resolve('.meshdrop-artifacts/phase-3-streaming');
await mkdir(artifactRoot, { recursive: true });
const runDirectory = await mkdtemp(join(artifactRoot, 'run-'));
const sizes = process.env.MESHDROP_BENCH_BYTES
  ? process.env.MESHDROP_BENCH_BYTES.split(',').map(Number)
  : [100 * 1024 ** 2, 1024 ** 3];
if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0 || size > 1024 ** 3))
  throw new Error('Invalid benchmark size.');
const report = {
  phase: 'P3',
  startedAt: new Date().toISOString(),
  pass: false,
  cases: [],
  testBrowserFlag:
    '--disable-features=WebRtcHideLocalIpsWithMdns (two isolated persistent local Chromium profiles; application browser defaults are unchanged)',
  memoryScope:
    'Unforced-GC CDP Runtime.getHeapUsage sampled every 500ms for both page isolates and their dedicated workers, including ArrayBuffer/external-string backing storage. This measures JS-owned memory, not total browser RSS, OS file cache or native WebRTC buffers.',
  directory: runDirectory,
};
async function fixture(path, size) {
  const handle = await open(path, 'wx');
  const hash = createHash('sha256');
  try {
    const block = Buffer.alloc(1024 ** 2);
    for (let offset = 0; offset < size; offset += block.length) {
      for (let index = 0; index < block.length; index++)
        block[index] = (index * 31 + Math.floor(offset / block.length) * 17) % 251;
      const data = block.subarray(0, Math.min(block.length, size - offset));
      hash.update(data);
      let written = 0;
      while (written < data.length)
        written += (await handle.write(data, written, data.length - written)).bytesWritten;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 ** 2 }))
    hash.update(chunk);
  return hash.digest('hex');
}
async function heapSampler(context, page) {
  const cdp = await context.newCDPSession(page);
  const workers = new Set();
  const pending = new Map();
  let requestId = 0;
  cdp.on('Target.attachedToTarget', (event) => {
    if (event.targetInfo.type === 'worker') workers.add(event.sessionId);
  });
  cdp.on('Target.detachedFromTarget', (event) => workers.delete(event.sessionId));
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    const message = JSON.parse(event.message);
    const callback = pending.get(`${event.sessionId}:${message.id}`);
    if (callback) {
      pending.delete(`${event.sessionId}:${message.id}`);
      callback(message.result ?? null);
    }
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  async function workerHeap(sessionId) {
    const id = ++requestId;
    const key = `${sessionId}:${id}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(key);
        resolve(null);
      }, 1000);
      pending.set(key, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }),
        })
        .catch(() => {
          clearTimeout(timeout);
          pending.delete(key);
          resolve(null);
        });
    });
  }
  return {
    sample: async () => {
      const main = await cdp.send('Runtime.getHeapUsage');
      const child = (await Promise.all([...workers].map(workerHeap))).filter(Boolean);
      const total = [main, ...child].reduce(
        (sum, heap) => sum + heap.usedSize + (heap.backingStorageSize ?? 0),
        0,
      );
      return {
        total,
        main: main.usedSize + (main.backingStorageSize ?? 0),
        workers: child.length,
        workerTotal: child.reduce(
          (sum, heap) => sum + heap.usedSize + (heap.backingStorageSize ?? 0),
          0,
        ),
      };
    },
  };
}
let ownerContext;
let receiverContext;
try {
  ownerContext = await chromium.launchPersistentContext(join(runDirectory, 'owner-profile'), {
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  receiverContext = await chromium.launchPersistentContext(join(runDirectory, 'receiver-profile'), {
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 1080 },
    acceptDownloads: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
  report.browser = ownerContext.browser()?.version();
  const owner = ownerContext.pages()[0];
  const receiver = receiverContext.pages()[0];
  const pageErrors = [];
  for (const page of [owner, receiver])
    page.on('pageerror', (error) => pageErrors.push(error.message));
  let requests = 0;
  let unexpectedApiRequest = false;
  for (const page of [owner, receiver])
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/v1/')) return;
      requests++;
      if (
        !/^\/v1\/sessions(?:\/[a-f0-9-]+(?:\/(?:status|join|decisions|ws-ticket|ws|connection|ice-credentials))?)?$/.test(
          url.pathname,
        )
      )
        unexpectedApiRequest = true;
      if ((request.postDataBuffer()?.length ?? 0) > 8192) unexpectedApiRequest = true;
    });
  await pairPages(owner, receiver);
  const samplers = await Promise.all(
    [
      [ownerContext, owner],
      [receiverContext, receiver],
    ].map(([context, page]) => heapSampler(context, page)),
  );
  for (const size of sizes) {
    const source = join(runDirectory, `fixture-${size}.bin`);
    const expected = await fixture(source, size);
    const baseline = (await Promise.all(samplers.map((sampler) => sampler.sample()))).reduce(
      (sum, sample) => sum + sample.total,
      0,
    );
    const result = {
      bytes: size,
      expectedSha256: expected,
      baselineJsBytes: baseline,
      peakJsBytes: baseline,
      peakWorkerBytes: 0,
      workerSamples: 0,
      progress: [],
    };
    const started = Date.now();
    let sampling = true;
    let sampleError;
    const monitor = (async () => {
      while (sampling) {
        try {
          const heaps = await Promise.all(samplers.map((sampler) => sampler.sample()));
          result.peakJsBytes = Math.max(
            result.peakJsBytes,
            heaps.reduce((sum, heap) => sum + heap.total, 0),
          );
          result.peakWorkerBytes = Math.max(
            result.peakWorkerBytes,
            heaps.reduce((sum, heap) => sum + heap.workerTotal, 0),
          );
          result.workerSamples += heaps.reduce((sum, heap) => sum + heap.workers, 0);
          const committed = await owner
            .getByTestId('committed-bytes')
            .evaluateAll((elements) => Number(elements[0]?.textContent ?? '0'));
          if (result.progress.length < 4096)
            result.progress.push({ elapsedMs: Date.now() - started, committedBytes: committed });
        } catch (error) {
          sampleError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
    try {
      await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles(source);
      await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
      await expect(receiver.getByTestId('transfer-state')).toHaveText('negotiating', {
        timeout: 300000,
      });
      await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
      await expect(owner.getByTestId('transfer-state')).toHaveText('complete', { timeout: 600000 });
      await expect(receiver.getByTestId('transfer-state')).toHaveText('complete', {
        timeout: 30000,
      });
    } finally {
      sampling = false;
      await monitor;
    }
    if (sampleError) throw sampleError;
    result.elapsedMs = Date.now() - started;
    await expect(owner.getByTestId('committed-bytes')).toHaveText(String(size));
    await expect(receiver.getByTestId('file-sha256')).toHaveText(expected);
    const downloadEvent = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save fixture-${size}.bin`, exact: true }).click();
    const downloaded = join(runDirectory, `downloaded-${size}.bin`);
    await (await downloadEvent).saveAs(downloaded);
    result.downloadedSha256 = await fileDigest(downloaded);
    if (result.downloadedSha256 !== expected)
      throw new Error('Downloaded fixture checksum mismatch.');
    const receiptEvent = owner.waitForEvent('download');
    await owner.getByRole('button', { name: 'Save transfer receipt', exact: true }).click();
    const receiptPath = join(runDirectory, `receipt-${size}.json`);
    await (await receiptEvent).saveAs(receiptPath);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.totalBytes !== size || receipt.files[0]?.sha256 !== expected)
      throw new Error('Receipt does not match independently hashed fixture.');
    result.senderPeakBufferedBytes = Number(
      await owner.locator('.transfer-panel').getAttribute('data-buffer-peak'),
    );
    result.senderPeakBlockBytes = Number(
      await owner.locator('.transfer-panel').getAttribute('data-block-peak'),
    );
    result.receiverPeakBlockBytes = Number(
      await receiver.locator('.transfer-panel').getAttribute('data-block-peak'),
    );
    result.receiverPeakQueueBytes = Number(
      await receiver.locator('.signaling-panel').getAttribute('data-receive-queue-peak'),
    );
    result.jsGrowthBytes = result.peakJsBytes - baseline;
    result.intermediateProgressObserved = result.progress.some(
      (sample) => sample.committedBytes > 0 && sample.committedBytes < size,
    );
    if (
      result.senderPeakBufferedBytes > 512 * 1024 ||
      result.senderPeakBlockBytes > 1024 ** 2 ||
      result.receiverPeakBlockBytes > 1024 ** 2 ||
      result.receiverPeakQueueBytes > 2 * 1024 ** 2
    )
      throw new Error('Owned transfer queue bound exceeded.');
    if (
      result.peakJsBytes > 256 * 1024 ** 2 ||
      !result.workerSamples ||
      (size >= 100 * 1024 ** 2 && !result.intermediateProgressObserved)
    )
      throw new Error('Memory/progress measurement did not meet the 256 MiB JS budget.');
    await receiver.screenshot({ path: join(runDirectory, `received-${size}.png`), fullPage: true });
    result.pass = true;
    report.cases.push(result);
    console.log(
      `Verified ${size} bytes; peak page+worker JS/backing storage ${result.peakJsBytes} bytes; duration ${result.elapsedMs} ms.`,
    );
    for (const page of [owner, receiver]) {
      await page.getByRole('button', { name: 'Clear transfer', exact: true }).click();
      await expect(page.getByTestId('transfer-state')).toHaveText('idle');
    }
    await rm(source);
    await rm(downloaded);
  }
  report.unexpectedApiRequest = unexpectedApiRequest;
  report.apiRequests = requests;
  if (unexpectedApiRequest || pageErrors.length)
    throw new Error('Unexpected API file route/body or browser exception.');
  await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  report.pass = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Large-transfer verification failed';
} finally {
  await ownerContext?.close();
  await receiverContext?.close();
  report.completedAt = new Date().toISOString();
  await writeFile(
    join(runDirectory, 'phase-3-streaming.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(join(artifactRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.pass) {
    await rm(join(runDirectory, 'owner-profile'), { recursive: true, force: true });
    await rm(join(runDirectory, 'receiver-profile'), { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      pass: report.pass,
      report: join(runDirectory, 'phase-3-streaming.json'),
      error: report.error,
    }),
  );
}
process.exit(report.pass ? 0 : 1);
