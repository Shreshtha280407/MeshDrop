import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { devices, expect, test } from '@playwright/test';
import { pairForTransfer } from '../helpers/peer';
import { exportReport, jsonReport, pauseAt, reports } from '../helpers/diagnostics';
import { parseCsv } from '../../packages/network-intelligence/src';
test.use({ trace: 'off', video: 'off' });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('measured pause dip, connection recovery, exact reuse and durable JSON/CSV reports', async ({
  browser,
}, info) => {
  test.setTimeout(100000);
  const pair = await pairForTransfer(browser, {
    ...devices[info.project.name === 'mobile-chromium' ? 'Pixel 7' : 'Desktop Chrome']!,
    baseURL: 'http://127.0.0.1:5173',
  });
  const { owner, receiver } = pair;
  const name = 'private-diagnostics-gate.bin',
    buffer = Buffer.alloc(24 * 1024 ** 2);
  for (let i = 0; i < buffer.length; i++)
    buffer[i] = (i * 31 + Math.floor(i / 1024 ** 2) * 17) % 251;
  try {
    await pauseAt(receiver, 8 * 1024 ** 2);
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    await expect
      .poll(
        async () => {
          const report = (await reports(owner))[0];
          const pause = report?.events.find((event) => event.code === 'paused');
          return (
            !!pause &&
            report!.samples.some(
              (frame) =>
                frame.timestampMonotonic > pause.observedAt + 1500 &&
                frame.samples.some(
                  (sample) => sample.metricName === 'ack-interval' && sample.value === 0,
                ),
            )
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);
    await expect(owner.getByTestId('metric-application-rtt')).not.toHaveText('Unavailable');
    const committed = Number(await receiver.getByTestId('committed-bytes').textContent());
    await expect(owner.getByTestId('committed-bytes')).toHaveText(String(committed));
    await owner
      .getByTestId('network-intelligence')
      .screenshot({ path: info.outputPath('phase-6-paused.png') });
    const pausedReport = await jsonReport(owner, info);
    await writeFile(info.outputPath('paused-report.json'), JSON.stringify(pausedReport, null, 2));
    await owner.getByRole('button', { name: 'Restart ICE', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('peer-epoch')).toHaveText('2');
      await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 40000 });
    }
    const code = await owner.getByTestId('pairing-code').textContent();
    expect(await receiver.getByTestId('pairing-code').textContent()).toBe(code);
    for (const page of [owner, receiver]) {
      await page.getByLabel('Code shown on the other device', { exact: true }).fill(code!);
      await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
    }
    for (const page of [owner, receiver])
      await expect(page.getByTestId('remote-verification')).toContainText('confirmed');
    await owner.getByRole('button', { name: 'Prepare original source', exact: true }).click();
    await expect(owner.getByTestId('resume-state')).toContainText('Source ready');
    await receiver.getByRole('button', { name: 'Resume saved transfer', exact: true }).click();
    for (const page of [owner, receiver]) {
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 45000 });
      await expect(page.getByTestId('metrics-persistence')).toHaveText('saved');
      await expect(page.getByTestId('metrics-new-bytes')).toHaveText(String(buffer.length));
      await expect(page.getByTestId('metrics-reused-bytes')).toHaveText(String(committed));
    }
    const final = await jsonReport(owner, info);
    const csv = await exportReport(owner, info, 'csv');
    expect(parseCsv(csv)).toEqual(final);
    expect(final.summary).toMatchObject({
      newlyConfirmedBytes: buffer.length,
      reusedBytes: committed,
      attemptPayloadBytes: buffer.length - committed,
      confirmedBytes: buffer.length,
    });
    expect(final.events.map((event) => event.code)).toEqual(
      expect.arrayContaining([
        'paused',
        'connection-interrupted',
        'connection-restored',
        'resumed',
        'verified',
      ]),
    );
    expect(
      final.events.find((event) => event.code === 'resumed')?.measuredEvidence.reusedBytes,
    ).toBe(committed);
    expect(final.summary.recoveryDurationMs).toBeGreaterThan(0);
    expect(JSON.stringify(final)).not.toContain(name);
    expect(JSON.stringify(final)).not.toContain(sha(buffer));
    expect(JSON.stringify(final)).not.toMatch(
      /candidateAddress|ownerCapability|joinSecret|iceServers|192\.168\./,
    );
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const output = info.outputPath('verified-output.bin');
    await (await downloading).saveAs(output);
    expect(sha(await readFile(output))).toBe(sha(buffer));
    await owner
      .getByTestId('network-intelligence')
      .screenshot({ path: info.outputPath('phase-6-complete.png') });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await writeFile(
      info.outputPath('phase-6-gate.json'),
      JSON.stringify(
        {
          scenario:
            'two real local WebRTC peers, injected pause, ICE restart, fresh comparison, authenticated missing-block resume',
          totalBytes: buffer.length,
          reusedBytes: committed,
          missingPayloadBytes: buffer.length - committed,
          sourceSha256: sha(buffer),
          savedSha256: sha(await readFile(output)),
          reportId: final.reportId,
          recoveryDurationMs: final.summary.recoveryDurationMs,
          pauseDip: true,
          jsonCsvRoundTrip: true,
          redaction: true,
        },
        null,
        2,
      ),
    );
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
    await owner.reload();
    await expect(
      owner
        .getByLabel('Measurement report', { exact: true })
        .locator(`option[value="${final.reportId}"]`),
    ).toHaveCount(1);
    await owner
      .getByLabel('Measurement report', { exact: true })
      .selectOption(final.reportId, { timeout: 10000 });
    expect(await jsonReport(owner, info)).toEqual(final);
    await owner.getByRole('button', { name: 'Delete local report', exact: true }).click();
    await expect(owner.getByTestId('network-intelligence')).not.toContainText(
      'New receiver-confirmed bytes on this page',
    );
    await owner.reload();
    expect(await reports(owner)).toHaveLength(0);
  } catch (error) {
    for (const [role, page] of [
      ['owner', owner],
      ['receiver', receiver],
    ] as const) {
      await info.attach(`${role}-diagnostics-failure`, {
        body: JSON.stringify({
          peer: await page.getByTestId('peer-state').allTextContents(),
          alerts: await page.getByRole('alert').allTextContents(),
          reports: await reports(page),
        }),
        contentType: 'application/json',
      });
    }
    throw error;
  } finally {
    await pair.close();
  }
});
test('missing browser stats and failed diagnostics persistence preserve a verified file transfer', async ({
  browser,
}, info) => {
  const pair = await pairForTransfer(
    browser,
    { baseURL: 'http://127.0.0.1:5173' },
    async (owner, receiver) => {
      for (const page of [owner, receiver])
        await page.addInitScript(() => {
          RTCPeerConnection.prototype.getStats = async () => {
            throw new Error('Injected unsupported browser stats');
          };
          const open = IDBFactory.prototype.open;
          IDBFactory.prototype.open = function (name, version) {
            if (name === 'meshdrop-diagnostics-v1')
              throw new DOMException(
                'Injected local diagnostics quota failure',
                'QuotaExceededError',
              );
            return open.call(this, name, version);
          };
        });
    },
  );
  const { owner, receiver } = pair,
    buffer = Buffer.alloc(4 * 1024 ** 2, 53),
    name = 'independent-storage.bin';
  try {
    await pauseAt(receiver, 1024 ** 2);
    await owner
      .getByLabel('Choose files to send', { exact: true })
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    await expect(receiver.getByTestId('transfer-state')).toHaveText('paused');
    await expect(owner.getByTestId('metric-application-rtt')).not.toHaveText('Unavailable', {
      timeout: 10000,
    });
    await expect(owner.getByTestId('metric-ice-rtt')).toHaveText('Unavailable');
    await expect(owner.getByTestId('metric-connection-path')).toHaveText('Unavailable');
    await expect(owner.getByTestId('metrics-persistence')).toHaveText('unavailable');
    const paused = await jsonReport(owner, info);
    expect(
      paused.samples.at(-1)?.samples.find((sample) => sample.metricName === 'ice-rtt'),
    ).toMatchObject({ value: null, availabilityReason: 'sampler-error' });
    await receiver.getByRole('button', { name: 'Resume transfer', exact: true }).click();
    for (const page of [owner, receiver])
      await expect(page.getByTestId('transfer-state')).toHaveText('complete', { timeout: 30000 });
    const downloading = receiver.waitForEvent('download');
    await receiver.getByRole('button', { name: `Save ${name}`, exact: true }).click();
    const path = info.outputPath(name);
    await (await downloading).saveAs(path);
    expect(sha(await readFile(path))).toBe(sha(buffer));
    await owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});

test('timing replies remain available with transfer-sized local buffer pressure', async ({
  browser,
}) => {
  const pair = await pairForTransfer(
    browser,
    { baseURL: 'http://127.0.0.1:5173' },
    async (owner) => {
      await owner.addInitScript(() => {
        const original = Object.getOwnPropertyDescriptor(
          RTCDataChannel.prototype,
          'bufferedAmount',
        )!.get!;
        Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount', {
          get() {
            const actual = original.call(this) as number;
            return document.documentElement.dataset.injectBufferPressure === 'yes'
              ? Math.max(96 * 1024, actual)
              : actual;
          },
        });
      });
    },
  );
  try {
    await pair.owner.evaluate(() => {
      document.documentElement.dataset.injectBufferPressure = 'yes';
    });
    await pair.receiver.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await expect(pair.receiver.getByTestId('received-pongs')).toHaveText('1');
    for (const page of [pair.owner, pair.receiver])
      await expect(page.getByTestId('peer-state')).toHaveText('connected');
    await pair.owner.getByRole('button', { name: 'Revoke room', exact: true }).click();
  } finally {
    await pair.close();
  }
});
