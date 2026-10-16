import { chromium } from '@playwright/test';
import NetworkWebSocket from 'ws';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  connectionEpochSchema,
  iceConfigurationSchema,
  parseSignalingMessage,
} from '@meshdrop/protocol';
import type { PeerSession, PeerView } from '../../packages/peer-connection/src/PeerSession';
import { approve, connect, create, join, request, runtime } from '../../tests/integration/harness';

declare global {
  interface Window {
    relayPeer: PeerSession;
    relayView: PeerView;
    relayQueue: Promise<void>;
  }
}
const output = process.env.MESHDROP_EVIDENCE_DIR ?? '/tmp/meshdrop-p2-relay';
const turnserver = process.env.MESHDROP_TURNSERVER ?? '/tmp/coturn-4.7.0/bin/turnserver';
await mkdir(output, { recursive: true });
const envFile = `${output}/.env`;
// The temporary provider secret is confined to a private .env. Never use this loopback config in production.
await writeFile(
  envFile,
  `listening-ip=127.0.0.1\nrelay-ip=127.0.0.1\nlistening-port=13478\nmin-port=13500\nmax-port=13520\nrealm=meshdrop.local\nuse-auth-secret\nstatic-auth-secret=${randomBytes(32).toString('base64url')}\nno-tls\nno-dtls\nno-cli\nno-multicast-peers\nallow-loopback-peers\nuser-quota=4\ntotal-quota=8\nmax-allocate-lifetime=120\nlog-file=stdout\n`,
  { mode: 0o600 },
);
const secret = (await readFile(envFile, 'utf8')).match(/^static-auth-secret=(.+)$/m)![1]!;
const relay = spawn(turnserver, ['-c', envFile, '--pidfile', `${output}/turnserver.pid`], {
  stdio: 'ignore',
});
let relayError: Error | undefined;
relay.on('error', (error) => {
  relayError = error;
});
const worker = await runtime({
  bindings: { TURN_URLS: 'turn:127.0.0.1:13478?transport=udp', TURN_SHARED_SECRET: secret },
});
const browser = await chromium.launch();
const report: Record<string, unknown> = {
  kind: 'forced-local-turn',
  browser: browser.version(),
  startedAt: new Date().toISOString(),
  scope:
    'Two real browser peer connections use iceTransportPolicy=relay; actual Worker/SQLite authorization and SDP/ICE forwarding; isolated coturn on loopback. This does not simulate a restrictive external NAT.',
};
const sockets: Awaited<ReturnType<typeof connect>>[] = [];
try {
  await new Promise((resolve) => setTimeout(resolve, 750));
  if (relayError || relay.exitCode !== null)
    throw relayError ?? new Error('coturn exited before testing.');
  const room = await create(worker);
  const { guest } = await join(worker, room);
  await approve(worker, room, guest.peerId);
  const members = [
    { peerId: room.peerId, token: room.ownerCapability, role: 'owner' as const },
    { peerId: guest.peerId, token: guest.peerCapability, role: 'receiver' as const },
  ];
  const pages = await Promise.all(
    members.map(async () => {
      const context = await browser.newContext();
      return context.newPage();
    }),
  );
  for (const [index, page] of pages.entries()) {
    const member = members[index]!;
    const socket = await connect(worker, room.roomId, member.token);
    sockets.push(socket);
    let seq = 0;
    await page.exposeBinding(
      'routeSignal',
      (_source, value: { type: string; payload: unknown }) => {
        socket.socket.send(
          JSON.stringify({
            version: 1,
            ...value,
            roomId: room.roomId,
            peerId: member.peerId,
            epoch: 1,
            seq: seq++,
            messageId: randomUUID(),
            sentAt: new Date().toISOString(),
          }),
        );
      },
    );
    if (!(socket.socket instanceof NetworkWebSocket))
      throw new Error('TCP signaling socket required.');
    socket.socket.on('message', (raw) => {
      const envelope = parseSignalingMessage(raw.toString());
      if (!['SDP_OFFER', 'SDP_ANSWER', 'ICE_CANDIDATE'].includes(envelope.type)) return;
      void page
        .evaluate((message) => {
          window.relayQueue = window.relayQueue
            .then(async () => {
              await window.relayPeer.receiveSignal(
                message as Parameters<PeerSession['receiveSignal']>[0],
              );
            })
            .catch(() => window.relayPeer.fail('Relay signaling failed.'));
        }, envelope)
        .catch(() => {});
    });
    await page.addInitScript('globalThis.__name = (fn) => fn;');
    await page.goto('http://127.0.0.1:5173/');
    await page.evaluate(
      async ({ moduleUrl, roomId, peerId, role }) => {
        const { PeerSession } = await import(/* @vite-ignore */ moduleUrl);
        window.relayQueue = Promise.resolve();
        window.relayPeer = new PeerSession({
          roomId,
          peerId,
          role,
          iceTransportPolicy: 'relay',
          sendSignal: (type: string, payload: unknown) => {
            void (window as unknown as { routeSignal(value: unknown): Promise<void> }).routeSignal({
              type,
              payload,
            });
          },
          onChange: (view: PeerView) => {
            window.relayView = view;
          },
        });
      },
      {
        moduleUrl: `/@fs/${resolve('packages/peer-connection/src/index.ts')}`,
        roomId: room.roomId,
        peerId: member.peerId,
        role: member.role,
      },
    );
  }
  const response = await request(worker, `/v1/sessions/${room.roomId}/connection`, {
    method: 'POST',
    token: room.ownerCapability,
    body: { expectedEpoch: 0, mode: 'new-connection' },
  });
  const epoch = connectionEpochSchema.parse(await response.json());
  for (const index of [1, 0]) {
    const configuration = iceConfigurationSchema.parse(
      await (
        await request(worker, `/v1/sessions/${room.roomId}/ice-credentials`, {
          method: 'POST',
          token: members[index]!.token,
          body: {},
        })
      ).json(),
    );
    await pages[index]!.evaluate(
      async ({ epoch, configuration }) => {
        await window.relayPeer.start(epoch, configuration);
      },
      { epoch, configuration },
    );
  }
  for (const page of pages)
    await page.waitForFunction(
      () => window.relayView?.ready && window.relayView.path?.kind === 'relay',
      { timeout: 30000 },
    );
  await pages[0]!.evaluate(async () => {
    await window.relayPeer.ping();
  });
  await pages[1]!.waitForFunction(() => window.relayView.pingsReceived === 1);
  await pages[0]!.waitForFunction(() => window.relayView.pongsReceived === 1);
  await pages[1]!.evaluate(async () => {
    await window.relayPeer.ping();
  });
  await pages[0]!.waitForFunction(() => window.relayView.pingsReceived === 1);
  await pages[1]!.waitForFunction(() => window.relayView.pongsReceived === 1);
  report.peers = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => ({
        path: window.relayView.path,
        ready: window.relayView.ready,
        pings: window.relayView.pingsReceived,
        pongs: window.relayView.pongsReceived,
      })),
    ),
  );
  const codes = await Promise.all(pages.map((page) => page.evaluate(() => window.relayView.code)));
  if (codes[0] !== codes[1]) throw new Error('Pairing transcript mismatch over relay.');
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.error = error instanceof Error ? error.message : 'Relay test failed';
} finally {
  for (const socket of sockets) socket.close();
  await browser.close();
  await worker.dispose();
  relay.kill('SIGTERM');
  report.completedAt = new Date().toISOString();
  await writeFile(`${output}/phase-2-relay.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
process.exit(report.pass ? 0 : 1);
