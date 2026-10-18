import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { sessionCreatedSchema, socketTicketSchema } from '@meshdrop/protocol';
import { API, Inbox, runtime } from './harness';

let worker: Miniflare;
beforeAll(async () => {
  worker = await runtime({ gateway: true, bindings: { ALLOWED_ORIGINS: API } });
});
afterAll(async () => {
  await worker.dispose();
});

it('routes an actual Worker/actor WebSocket through the Pages service binding', async () => {
  const created = await worker.dispatchFetch(`${API}/v1/sessions`, {
    method: 'POST',
    headers: { Origin: API, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(created.status).toBe(201);
  const room = sessionCreatedSchema.parse(await created.json());
  const ticketResponse = await worker.dispatchFetch(`${API}/v1/sessions/${room.roomId}/ws-ticket`, {
    method: 'POST',
    headers: {
      Origin: API,
      Authorization: `Bearer ${room.ownerCapability}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(ticketResponse.status).toBe(200);
  const ticket = socketTicketSchema.parse(await ticketResponse.json());
  const upgraded = await worker.dispatchFetch(`${API}/v1/sessions/${room.roomId}/ws`, {
    headers: {
      Origin: API,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `meshdrop.v1, meshdrop.ticket.${ticket.ticket}`,
    },
  });
  expect(upgraded.status).toBe(101);
  expect(upgraded.webSocket).toBeTruthy();
  const inbox = new Inbox(upgraded.webSocket!);
  try {
    expect((await inbox.next('JOINED')).roomId).toBe(room.roomId);
  } finally {
    inbox.close();
  }
});

it('keeps public assets protected, blocks aliases and preserves denial across the gateway', async () => {
  const asset = await worker.dispatchFetch(`${API}/`);
  expect(asset.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  expect((await worker.dispatchFetch('https://alias.meshdrop.test/')).status).toBe(403);
  const denied = await worker.dispatchFetch(`${API}/v1/sessions`, {
    method: 'POST',
    headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(denied.status).toBe(403);
  expect(denied.headers.get('Cache-Control')).toBe('no-store');
});
