import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Public browser → gateway → Worker/DO → WebRTC → storage → actual export. */
export async function publicTransferSmoke(
  origin: string,
  directory: string,
  stage: string,
  options: {
    bytes?: number;
    relayOnly?: boolean;
    relayTransport?: 'udp' | 'tcp' | 'tls';
    disableUdp?: boolean;
  } = {},
) {
  await mkdir(directory, { recursive: true });
  const size = options.bytes ?? 1024 ** 2;
  if (!Number.isSafeInteger(size) || size < 1 || size > 16 * 1024 ** 2)
    throw new Error('Smoke fixtures must be 1 byte–16 MiB.');
  if ((options.relayTransport || options.disableUdp) && !options.relayOnly)
    throw new Error('Transport constraints require relay-only verification.');
  const browser = await chromium.launch({
    ...(options.disableUdp
      ? { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }
      : {}),
  });
  const owner = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const receiver = await (await browser.newContext({ acceptDownloads: true })).newPage();
  let created = false;
  let verified = false;
  let cleaned = true;
  let gate = 'LOAD';
  let result:
    | {
        scope: string;
        bytes: number;
        sha256: string;
        exportedFileVerified: boolean;
        receiptVerified: boolean;
        diagnosticsExported: boolean;
        relayProof?: {
          localCandidateType: string;
          remoteCandidateType: string;
          relayProtocol: string;
        }[];
        relayOnly?: boolean;
        udpDisabledByBrowserPolicy?: boolean;
      }
    | undefined;
  const bytes = Buffer.alloc(size, 91);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const name = `meshdrop-rollback-${randomUUID()}.bin`;
  const state = (page: Page, id: string, value: string) =>
    expect(page.getByTestId(id)).toHaveText(value, { timeout: 60000 });
  async function exportDownload(page: Page, button: string, destination: string) {
    const event = page.waitForEvent('download', { timeout: 30000 });
    await page.getByRole('button', { name: button, exact: true }).click();
    await (await event).saveAs(destination);
    return readFile(destination);
  }
  try {
    if (options.relayOnly)
      for (const page of [owner, receiver])
        await page.addInitScript(
          ({ transport }) => {
            const target = globalThis as typeof globalThis & {
              __meshdropSmokePeers: RTCPeerConnection[];
            };
            target.__meshdropSmokePeers = [];
            const Native = globalThis.RTCPeerConnection;
            globalThis.RTCPeerConnection = class extends Native {
              constructor(configuration?: RTCConfiguration) {
                const iceServers = (configuration?.iceServers ?? [])
                  .map((server) => {
                    const urls = (
                      typeof server.urls === 'string' ? [server.urls] : server.urls
                    ).filter((url) =>
                      transport === 'tls'
                        ? url.startsWith('turns:')
                        : transport === 'tcp'
                          ? url.startsWith('turn:') && url.includes('transport=tcp')
                          : transport === 'udp'
                            ? url.startsWith('turn:') && !url.includes('transport=tcp')
                            : /^turns?:/.test(url),
                    );
                    return { ...server, urls };
                  })
                  .filter((server) => server.urls.length > 0);
                super({ ...configuration, iceServers, iceTransportPolicy: 'relay' });
                target.__meshdropSmokePeers.push(this);
              }
            };
          },
          { transport: options.relayTransport },
        );
    for (const page of [owner, receiver]) page.setDefaultTimeout(30000);
    await Promise.all([owner.goto(origin), receiver.goto(origin)]);
    gate = 'ADMISSION';
    await owner.getByRole('button', { name: 'Create invitation', exact: true }).click();
    created = true;
    await state(owner, 'connection-state', 'connected');
    const invitation = await owner
      .getByLabel('Private invitation link', { exact: true })
      .inputValue();
    await receiver.getByLabel('Join with an invitation', { exact: true }).fill(invitation);
    await receiver.getByRole('button', { name: 'Request to join', exact: true }).click();
    await owner.getByRole('button', { name: 'Approve receiver', exact: true }).click();
    gate = 'PEER_CONNECTION';
    for (const page of [owner, receiver]) await state(page, 'peer-state', 'connected');
    const code = await owner.getByTestId('pairing-code').textContent();
    if (!code || code !== (await receiver.getByTestId('pairing-code').textContent()))
      throw new Error('PRODUCT_PAIRING_COMPARISON_FAILED');
    gate = 'COMPARISON';
    for (const page of [owner, receiver]) {
      await page.getByLabel('Code shown on the other device', { exact: true }).fill(code);
      await page.getByLabel('I compared using a separate trusted channel', { exact: true }).check();
      await page.getByRole('button', { name: 'Confirm comparison', exact: true }).click();
    }
    for (const page of [owner, receiver])
      await state(page, 'remote-verification', 'Other device comparison: confirmed');
    await owner.getByRole('button', { name: 'Send signed ping', exact: true }).click();
    await state(receiver, 'received-pings', '1');
    await state(owner, 'received-pongs', '1');
    gate = 'OFFER';
    await owner.getByLabel('Choose files to send', { exact: true }).setInputFiles({
      name,
      mimeType: 'application/octet-stream',
      buffer: bytes,
    });
    await owner.getByRole('button', { name: 'Offer files', exact: true }).click();
    await expect(receiver.getByTestId('receive-strategy')).toContainText('Receive strategy:', {
      timeout: 30000,
    });
    const limits = receiver.getByLabel(
      'I understand the storage and export limits and will keep both devices open',
      { exact: true },
    );
    if (await limits.isVisible()) await limits.check();
    await receiver.getByRole('button', { name: 'Accept files', exact: true }).click();
    gate = 'TRANSFER';
    for (const page of [owner, receiver]) await state(page, 'transfer-state', 'complete');
    await state(receiver, 'committed-bytes', String(bytes.length));
    await state(receiver, 'file-sha256', digest);
    gate = 'FILE_EXPORT';
    const exported = await exportDownload(
      receiver,
      `Save ${name}`,
      resolve(directory, `${stage}-file.bin`),
    );
    if (
      exported.length !== bytes.length ||
      createHash('sha256').update(exported).digest('hex') !== digest
    )
      throw new Error('PRODUCT_EXPORTED_BYTES_MISMATCH');
    gate = 'RECEIPT_EXPORT';
    const receipt = JSON.parse(
      (
        await exportDownload(
          owner,
          'Save transfer receipt',
          resolve(directory, `${stage}-receipt.json`),
        )
      ).toString(),
    );
    if (receipt.totalBytes !== bytes.length || receipt.files?.[0]?.sha256 !== digest)
      throw new Error('PRODUCT_RECEIPT_MISMATCH');
    gate = 'DIAGNOSTICS_EXPORT';
    const diagnostics = JSON.parse(
      (
        await exportDownload(
          owner,
          'Export diagnostics JSON',
          resolve(directory, `${stage}-diagnostics.json`),
        )
      ).toString(),
    );
    if (!diagnostics || typeof diagnostics !== 'object')
      throw new Error('PRODUCT_DIAGNOSTICS_EXPORT_FAILED');
    const relayProof = options.relayOnly
      ? await Promise.all(
          [owner, receiver].map((page) =>
            page.evaluate(async () => {
              const peers = (
                globalThis as typeof globalThis & { __meshdropSmokePeers: RTCPeerConnection[] }
              ).__meshdropSmokePeers;
              const pc = peers.find((peer) => peer.connectionState === 'connected');
              if (!pc) throw new Error('No connected peer.');
              const stats = await pc.getStats();
              let pair;
              stats.forEach((stat) => {
                if (stat.type === 'transport' && stat.selectedCandidatePairId)
                  pair = stats.get(stat.selectedCandidatePairId);
              });
              if (!pair)
                stats.forEach((stat) => {
                  if (
                    stat.type === 'candidate-pair' &&
                    stat.state === 'succeeded' &&
                    stat.nominated
                  )
                    pair = stat;
                });
              const ids = pair as
                | { localCandidateId?: string; remoteCandidateId?: string }
                | undefined;
              const local = ids?.localCandidateId ? stats.get(ids.localCandidateId) : undefined;
              const remote = ids?.remoteCandidateId ? stats.get(ids.remoteCandidateId) : undefined;
              if (local?.candidateType !== 'relay' || remote?.candidateType !== 'relay')
                throw new Error('Selected path is not relay-only.');
              return {
                localCandidateType: 'relay',
                remoteCandidateType: 'relay',
                relayProtocol: ['udp', 'tcp', 'tls'].includes(local.relayProtocol)
                  ? String(local.relayProtocol)
                  : 'unknown',
              };
            }),
          ),
        )
      : undefined;
    if (
      options.relayTransport &&
      relayProof?.some((path) => path.relayProtocol !== options.relayTransport)
    )
      throw new Error('PRODUCT_RELAY_TRANSPORT_GATE');
    verified = true;
    result = {
      scope: `two Chromium contexts; ${origin.startsWith('https:') ? 'public HTTPS/WSS' : 'local HTTP/WS'}; real WebRTC; synthetic file`,
      bytes: bytes.length,
      sha256: digest,
      exportedFileVerified: true,
      receiptVerified: true,
      diagnosticsExported: true,
      ...(relayProof
        ? { relayProof, relayOnly: true, udpDisabledByBrowserPolicy: options.disableUdp === true }
        : {}),
    };
  } catch (error) {
    throw new Error(`PRODUCT_BROWSER_${gate}_FAILED`, { cause: error });
  } finally {
    for (const page of [owner, receiver]) {
      try {
        await page
          .getByRole('button', { name: 'Clear transfer', exact: true })
          .click({ timeout: 3000 });
      } catch {
        if (verified) cleaned = false;
      }
    }
    if (created) {
      try {
        await owner
          .getByRole('button', { name: 'Revoke room', exact: true })
          .click({ timeout: 5000 });
        await state(owner, 'connection-state', 'disconnected');
      } catch {
        cleaned = false;
      }
    }
    await browser.close();
  }
  if (!cleaned || !result) throw new Error('PRODUCT_SYNTHETIC_CLEANUP_FAILED');
  return result;
}
