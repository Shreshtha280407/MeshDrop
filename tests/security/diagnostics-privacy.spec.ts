import { afterEach, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  DiagnosticsSession,
  emptyProbe,
  exportJson,
  exportCsv,
  parseCsv,
  parseJson,
  readWebRtcStats,
} from '../../packages/network-intelligence/src';
import { networkEvent } from '../../packages/network-intelligence/src/Events';
import type { LocalReport } from '../../packages/network-intelligence/src';

const canary = 'task15-private-value-' + 'Z'.repeat(32);
function report(): LocalReport {
  const session = new DiagnosticsSession({
    transferId: crypto.randomUUID(),
    role: 'owner',
    epoch: 1,
    probe: async () => emptyProbe('unsupported'),
    autoStart: false,
    clock: () => 0,
    store: { put: async () => {} },
  });
  session.observe({
    transferId: session.getSnapshot().report.transferId,
    epoch: 1,
    state: 'negotiating',
    committedBytes: 0,
    reusedBytes: 0,
    attemptPayloadBytes: 0,
    paused: false,
    storageFull: false,
    recoveryAccepted: false,
  });
  session.capture(emptyProbe('unsupported'));
  const value = structuredClone(session.getSnapshot().report);
  session.abandon();
  return value;
}
function rejected(value: unknown) {
  for (const exporter of [exportJson, exportCsv]) {
    let denied = false;
    try {
      exporter(value as LocalReport);
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
  }
}
afterEach(() => vi.restoreAllMocks());
it('exports measured JSON/CSV with intact measurements and only documented non-secret identifiers', () => {
  const r = report();
  for (const text of [exportJson(r), exportCsv(r)]) expect(text.includes(canary)).toBe(false);
  expect(parseJson(exportJson(r))).toEqual(r);
  expect(parseCsv(exportCsv(r))).toEqual(r);
  expect(r.transferId).toMatch(/^[a-f0-9-]{36}$/);
});
it.each([
  'ownerCapability',
  'inviteCapability',
  'ticket',
  'turnUsername',
  'turnPassword',
  'operatorProof',
  'filename',
  'roomId',
  'peerId',
  'ip',
  'sdp',
  'candidate',
  'path',
])('rejects an injected %s instead of exporting private report fields', (field) =>
  rejected({ ...report(), [field]: canary }),
);
it('rejects private event evidence and free-text messages, including spreadsheet formulas', () => {
  const r = report();
  const event = networkEvent(r.transferId, 'started', 0);
  for (const text of [canary, '=HYPERLINK(1)', '+cmd', '@payload', '\t=1', '＝1', '\r-1']) {
    rejected({ ...r, events: [{ ...event, userMessage: text }] });
    rejected({ ...r, events: [{ ...event, measuredEvidence: { credential: text } }] });
    rejected({
      ...r,
      samples: r.samples.map((f) => ({
        ...f,
        samples: f.samples.map((s, i) => (i === 0 ? { ...s, value: text } : s)),
      })),
    });
  }
});
it('rejects CSV row substitution rather than importing a user-controlled formula as a metric', () => {
  const r = report(),
    csv = exportCsv(r);
  expect(csv.includes('ack-interval')).toBe(true);
  let denied = false;
  try {
    parseCsv(csv.replace('ack-interval', '=HYPERLINK(1)'));
  } catch {
    denied = true;
  }
  expect(denied).toBe(true);
});
it('extracts only selected-pair category/timing and never exports raw RTC credentials or endpoints', () => {
  const raw = new Map<string, unknown>([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        type: 'candidate-pair',
        state: 'succeeded',
        currentRoundTripTime: 0.025,
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        request: canary,
      },
    ],
    [
      'local',
      {
        type: 'local-candidate',
        candidateType: 'host',
        address: canary,
        ip: canary,
        port: 1234,
        usernameFragment: canary,
        url: canary,
        password: canary,
      },
    ],
    ['remote', { type: 'remote-candidate', candidateType: 'relay', address: canary, url: canary }],
  ]);
  const extracted = readWebRtcStats(raw as unknown as RTCStatsReport);
  expect(extracted).toEqual({ iceRttMs: 25, path: 'relay', candidateState: 'succeeded' });
  expect(JSON.stringify(extracted).includes(canary)).toBe(false);
});
it('application audit logs contain fixed classifications without any supplied secret', async () => {
  const { audit } = await import(pathToFileURL(resolve('apps/signaling/src/audit.ts')).href);
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const operation of [canary, 'create', 'join', 'ws', 'revoke', 'control'])
    audit({ AUDIT_LOGS: 'true', ENVIRONMENT: canary }, operation, 403);
  expect(spy.mock.calls).toHaveLength(6);
  for (const args of spy.mock.calls) {
    const line = String(args[0]);
    expect(line.includes(canary)).toBe(false);
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      'environment',
      'event',
      'operation',
      'status',
    ]);
  }
});
