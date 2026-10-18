import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import WebSocket from 'ws';
import {
  iceConfigurationSchema,
  sessionCreatedSchema,
  socketTicketSchema,
} from '@meshdrop/protocol';
import { deploymentConfig, environment } from './config';

const target = environment(process.argv[2]);
const values = parseEnv(await readFile(`infrastructure/cloudflare/${target}/.env`, 'utf8'));
const config = deploymentConfig(target, values, process.cwd());
const report = {
  phase: 'P9',
  scope: 'public HTTPS/WSS control plane; not physical file delivery',
  environment: target,
  origin: config.origin,
  pass: false,
  checks: [] as string[],
};
const api = (
  path: string,
  method = 'GET',
  token?: string,
  body?: unknown,
  origin = config.origin,
) =>
  fetch(`${config.origin}${path}`, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
let socket: WebSocket | undefined;
let closeRoom: (() => Promise<unknown>) | undefined;
try {
  const shell = await api('/');
  if (!shell.ok || !shell.headers.get('Content-Security-Policy')?.includes("script-src 'self'"))
    throw new Error('SHELL_POLICY_GATE');
  if (!(await api('/ready')).ok) throw new Error('READINESS_GATE');
  report.checks.push('public HTTPS shell/CSP/readiness');
  if (
    (await api('/v1/sessions', 'POST', undefined, {}, 'https://untrusted.invalid')).status !== 403
  )
    throw new Error('ORIGIN_GATE');
  const created = await api('/v1/sessions', 'POST', undefined, {});
  if (created.status !== 201) throw new Error('CREATE_GATE');
  const room = sessionCreatedSchema.parse(await created.json());
  const base = `/v1/sessions/${room.roomId}`;
  closeRoom = () => api(base, 'DELETE', room.ownerCapability);
  const guest = { peerId: randomUUID(), peerCapability: randomBytes(32).toString('base64url') };
  if (!(await api(`${base}/join`, 'POST', room.inviteCapability, guest)).ok)
    throw new Error('JOIN_GATE');
  if (
    !(
      await api(`${base}/decisions`, 'POST', room.ownerCapability, {
        candidatePeerId: guest.peerId,
        decision: 'approve',
      })
    ).ok
  )
    throw new Error('APPROVAL_GATE');
  report.checks.push('untrusted origin denied; create/join/owner approval');
  const iceResponse = await api(`${base}/ice-credentials`, 'POST', guest.peerCapability, {});
  if (!iceResponse.ok) throw new Error('ICE_CREDENTIALS_GATE');
  const ice = iceConfigurationSchema.parse(await iceResponse.json());
  if (ice.relayAvailable !== (config.worker.vars.TURN_PROVIDER !== 'direct'))
    throw new Error('RELAY_CONFIGURATION_GATE');
  report.checks.push(
    ice.relayAvailable
      ? 'approved member receives temporary relay credentials'
      : 'explicit direct-only ICE configuration',
  );
  const ticketResponse = await api(`${base}/ws-ticket`, 'POST', room.ownerCapability, {});
  const ticket = socketTicketSchema.parse(await ticketResponse.json());
  socket = new WebSocket(
    `${config.origin.replace('https:', 'wss:')}${base}/ws`,
    ['meshdrop.v1', `meshdrop.ticket.${ticket.ticket}`],
    { origin: config.origin, handshakeTimeout: 20000 },
  );
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('WSS_JOIN_GATE')), 20000);
    socket!.on('message', (bytes) => {
      try {
        if (JSON.parse(bytes.toString()).type === 'JOINED') {
          clearTimeout(timer);
          accept();
        }
      } catch {
        clearTimeout(timer);
        reject(new Error('WSS_MESSAGE_GATE'));
      }
    });
    socket!.once('error', () => {
      clearTimeout(timer);
      reject(new Error('WSS_CONNECT_GATE'));
    });
  });
  report.checks.push('WSS upgrade through Pages service binding and actor JOINED');
  const operatorPath = `/ops/rooms/${room.roomId}/revoke`;
  if ((await api(operatorPath, 'POST', room.ownerCapability)).status !== 403)
    throw new Error('OPERATOR_SEPARATION_GATE');
  const closed = new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('REVOCATION_SOCKET_GATE')), 10000);
    socket!.once('close', () => {
      clearTimeout(timer);
      accept();
    });
  });
  void closed.catch(() => {});
  if (!(await api(operatorPath, 'POST', values.OPS_REVOKE_SECRET)).ok)
    throw new Error('REVOCATION_GATE');
  await closed;
  if ((await api(`${base}/ws-ticket`, 'POST', room.ownerCapability, {})).status !== 410)
    throw new Error('CLOSED_ROOM_GATE');
  report.checks.push('owner cannot use operator route; operator closes socket and revokes tickets');
  report.pass = true;
} finally {
  socket?.terminate();
  await closeRoom?.().catch(() => {});
  await mkdir('.meshdrop-artifacts/phase-9', { recursive: true });
  await writeFile(
    `.meshdrop-artifacts/phase-9/public-smoke-${target}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
