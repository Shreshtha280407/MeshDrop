import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  Aggregator,
  megabitsPerSecond,
  megabytesPerSecond,
  readWebRtcStats,
  StatsSampler,
  Rules,
  DiagnosticsSession,
  emptyProbe,
  exportJson,
  parseJson,
  exportCsv,
  parseCsv,
  reportSchema,
  MAX_REPORT_BYTES,
} from '../../packages/network-intelligence/src/index';
import type {
  MetricName,
  LocalReport,
  TransportProbe,
  TransferObservation,
} from '../../packages/network-intelligence/src/index';
const probe: TransportProbe = {
  iceRttMs: 15,
  applicationRttMs: 24,
  bufferedBytes: 0,
  path: 'direct',
  candidateState: 'succeeded',
  reason: 'unsupported',
};
function fixture(role: 'owner' | 'receiver' = 'owner') {
  let time = 0;
  const persisted: LocalReport[] = [];
  const session = new DiagnosticsSession({
    transferId: randomUUID(),
    role,
    epoch: 1,
    probe: async () => probe,
    autoStart: false,
    clock: () => time,
    wallClock: () => 1760000000000 + time,
    store: {
      put: async (report) => {
        persisted.push(report);
      },
    },
  });
  let state: TransferObservation = {
    transferId: session.getSnapshot().report.transferId,
    epoch: 1,
    state: 'negotiating',
    committedBytes: 0,
    reusedBytes: 0,
    attemptPayloadBytes: 0,
    paused: false,
    storageFull: false,
    recoveryAccepted: false,
  };
  const observe = (at: number, patch: Partial<TransferObservation> = {}) => {
    time = at;
    state = { ...state, ...patch };
    session.observe(state);
  };
  const capture = (at: number, measurement = probe) => {
    time = at;
    session.capture(measurement);
  };
  observe(0);
  return {
    session,
    observe,
    capture,
    persisted,
    setTime: (at: number) => {
      time = at;
    },
  };
}
const value = (report: LocalReport, name: MetricName) =>
  report.samples.at(-1)!.samples.find((sample) => sample.metricName === name)!;
it('calculates exact monotonic interval, rolling and session ACK averages using decimal units', () => {
  const a = new Aggregator();
  expect(a.sample(0).interval).toBeNull();
  a.acknowledge(1000, 1000000);
  expect(a.sample(1000)).toMatchObject({
    interval: 1000000,
    rolling: 1000000,
    average: 1000000,
    intervalDurationMs: 1000,
  });
  a.acknowledge(3000, 2000000);
  expect(a.sample(3000)).toMatchObject({
    interval: 1000000,
    rolling: 1000000,
    average: 1000000,
    intervalDurationMs: 2000,
  });
  expect(a.sample(6000)).toMatchObject({ interval: 0, rolling: 500000, average: 500000 });
  expect(a.sample(12000)).toMatchObject({ interval: 0, rolling: 200000, average: 250000 });
  expect(megabytesPerSecond(1250000)).toBe(1.25);
  expect(megabitsPerSecond(1250000)).toBe(10);
  expect(() => a.sample(100)).toThrow();
  expect(() => a.acknowledge(1, -1)).toThrow();
});
it('bounds very dense ACK history and marks an unsupported rolling window instead of inventing data', () => {
  const a = new Aggregator();
  a.sample(0);
  for (let index = 1; index <= 4200; index++) a.acknowledge(index, 1);
  expect(a.sample(5000)).toMatchObject({
    rolling: null,
    rollingReason: 'history-cap',
    interval: 840,
    average: 840,
  });
  expect(a.sample(20000).rolling).toBe(0);
});
it.each(['host', 'srflx', 'prflx', 'relay'])(
  'uses the selected %s candidate pair without returning address metadata',
  (type) => {
    const report = new Map<string, unknown>([
      ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
      [
        'selected',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
          currentRoundTripTime: 0.035,
        },
      ],
      [
        'local',
        {
          type: 'local-candidate',
          candidateType: type,
          address: '203.0.113.9',
          port: 5000,
          url: 'turn:private.example',
          username: 'private-user',
        },
      ],
      ['remote', { type: 'remote-candidate', candidateType: 'host', address: '192.0.2.10' }],
      [
        'other',
        {
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'unselected-relay',
        },
      ],
      ['unselected-relay', { type: 'local-candidate', candidateType: 'relay' }],
    ]);
    const result = readWebRtcStats(report);
    expect(result).toEqual({
      iceRttMs: 35,
      path: type === 'relay' ? 'relay' : 'direct',
      candidateState: 'succeeded',
    });
    for (const secret of [
      '203.0.113',
      '192.0.2',
      'private-user',
      'private.example',
      'address',
      'port',
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
  },
);
it('returns unavailable for missing, nonfinite, disconnected or ambiguous statistics; a measured zero remains valid', () => {
  expect(readWebRtcStats(new Map())).toEqual({ iceRttMs: null, path: null, candidateState: null });
  const report = new Map<string, unknown>([
    [
      'p',
      {
        type: 'candidate-pair',
        nominated: true,
        state: 'succeeded',
        currentRoundTripTime: 0,
        localCandidateId: 'l',
        remoteCandidateId: 'r',
      },
    ],
    ['l', { type: 'local-candidate', candidateType: 'host' }],
    ['r', { type: 'remote-candidate', candidateType: 'host' }],
  ]);
  expect(readWebRtcStats(report)).toMatchObject({ iceRttMs: 0, path: 'direct' });
  report.set('other', {
    type: 'candidate-pair',
    nominated: true,
    state: 'succeeded',
    currentRoundTripTime: 0.1,
  });
  expect(readWebRtcStats(report).path).toBeNull();
  report.delete('other');
  report.set('p', {
    type: 'candidate-pair',
    nominated: true,
    state: 'succeeded',
    currentRoundTripTime: Infinity,
  });
  expect(readWebRtcStats(report).iceRttMs).toBeNull();
  report.set('t', { type: 'transport', selectedCandidatePairId: 'failed' });
  report.set('failed', { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 0.1 });
  expect(readWebRtcStats(report)).toEqual({ iceRttMs: null, path: null, candidateState: 'failed' });
});
it('rules report observed pressure/stalls/relay/storage only, deduplicate and suppress expected paused dips', () => {
  const rules = new Rules();
  const base = {
    at: 0,
    active: false,
    ackAgeMs: 9000,
    bufferedBytes: 500000,
    path: null,
    storageCommitMs: null,
    storageSequence: 0,
  } as const;
  expect(rules.evaluate(base)).toEqual([]);
  const active = { ...base, active: true, path: 'relay' as const, storageCommitMs: 300 };
  expect(rules.evaluate({ ...active, storageSequence: 1 }).map((event) => event.code)).toEqual([
    'ack-stalled',
    'relay-selected',
  ]);
  expect(rules.evaluate({ ...active, at: 1000, storageSequence: 2 })).toEqual([]);
  expect(
    rules.evaluate({ ...active, at: 2000, storageSequence: 3 }).map((event) => event.code),
  ).toEqual(['buffer-pressure', 'slow-storage']);
  expect(rules.evaluate({ ...active, at: 3000, storageSequence: 3 })).toEqual([]);
  expect(rules.evaluate({ ...base, at: 4000, bufferedBytes: 0, storageSequence: 4 })).toEqual([]);
  expect(
    rules
      .evaluate({ ...active, ackAgeMs: 1, bufferedBytes: 0, storageSequence: 5 })
      .some((event) => event.code === 'ack-stalled'),
  ).toBe(false);
});
it('retains exact pause, new connection and reused evidence without inflating receiver-confirmed throughput', async () => {
  const f = fixture();
  f.observe(1000, { state: 'active' });
  f.observe(2000, { committedBytes: 1000000, attemptPayloadBytes: 1000000 });
  f.capture(2100);
  expect(value(f.session.getSnapshot().report, 'ack-average').value).toBeCloseTo(
    (1000000 * 1000) / 2100,
  );
  f.observe(3000, { state: 'paused', paused: true });
  f.capture(4000);
  expect(value(f.session.getSnapshot().report, 'ack-interval').value).toBe(0);
  f.observe(5000, { state: 'reconnecting' });
  f.setTime(6000);
  f.session.connectionRestored(2);
  f.observe(7000, {
    state: 'preparing',
    epoch: 2,
    committedBytes: 0,
    reusedBytes: 0,
    attemptPayloadBytes: 0,
    paused: false,
  });
  f.observe(8000, {
    state: 'negotiating',
    recoveryAccepted: true,
    committedBytes: 1000000,
    reusedBytes: 1000000,
  });
  f.observe(8100, { state: 'active' });
  f.observe(9000, { committedBytes: 1500000, attemptPayloadBytes: 500000 });
  f.observe(10000, { state: 'complete' });
  const report = f.session.getSnapshot().report;
  expect(report.summary).toEqual({
    newlyConfirmedBytes: 1500000,
    reusedBytes: 1000000,
    attemptPayloadBytes: 500000,
    confirmedBytes: 1500000,
    recoveryDurationMs: 3000,
  });
  expect(report.events.map((event) => event.code)).toEqual(
    expect.arrayContaining([
      'started',
      'accepted',
      'paused',
      'connection-interrupted',
      'connection-restored',
      'resume-started',
      'resumed',
      'verified',
    ]),
  );
  expect(report.events.find((event) => event.code === 'resumed')?.measuredEvidence).toMatchObject({
    reusedBytes: 1000000,
    durationMs: 3000,
  });
  expect(report.status).toBe('complete');
  f.setTime(60000);
  f.session.stop();
  expect(f.session.getSnapshot().report.durationMs).toBe(10000);
  await f.session.flush();
  expect(f.persisted.at(-1)?.status).toBe('complete');
});
it('preserves metrics, labels, unavailable reasons, durations and event timestamps through JSON and CSV round trips', () => {
  const f = fixture('receiver');
  f.observe(100, { state: 'active' });
  f.session.storageCommitted(21.25);
  f.observe(1000, { committedBytes: 25, attemptPayloadBytes: 25 });
  f.capture(1500, emptyProbe('unsupported'));
  f.observe(2000, { state: 'complete' });
  const report = f.session.getSnapshot().report;
  expect(
    report.samples
      .find((frame) => frame.timestampMonotonic === 1500)
      ?.samples.find((sample) => sample.metricName === 'ice-rtt'),
  ).toMatchObject({
    value: null,
    unit: 'ms',
    availabilityReason: 'unsupported',
  });
  expect(value(report, 'storage-commit')).toMatchObject({
    value: 21.25,
    unit: 'ms',
    provenance: 'receiver-worker-commit',
  });
  expect(parseJson(exportJson(report))).toEqual(report);
  expect(parseCsv(exportCsv(report))).toEqual(report);
  expect(exportCsv(report)).toContain('timestampMonotonicMs');
  expect(exportJson(report)).not.toMatch(
    /filename|manifestDigest|candidateAddress|ownerCapability/,
  );
  expect(() => parseJson(JSON.stringify({ ...report, filename: 'private.txt' }))).toThrow();
  const changed = structuredClone(report);
  changed.samples[0]!.samples[0]!.unit = 'ms';
  expect(reportSchema.safeParse(changed).success).toBe(false);
  const reversed = structuredClone(report);
  reversed.samples.reverse();
  expect(reportSchema.safeParse(reversed).success).toBe(false);
  expect(() =>
    parseCsv(exportCsv(report).replace('receiver-confirmations', 'invented-provenance')),
  ).toThrow();
  f.session.stop();
});
it('marks source-only storage unavailable, does not substitute zero, and leaves file counters independent of persistence failure', async () => {
  let time = 0;
  const session = new DiagnosticsSession({
    transferId: randomUUID(),
    role: 'owner',
    epoch: 1,
    autoStart: false,
    clock: () => time,
    probe: async () => emptyProbe(),
    store: {
      put: async () => {
        throw new Error('Injected metrics storage failure');
      },
    },
  });
  const input = {
    transferId: session.getSnapshot().report.transferId,
    epoch: 1,
    state: 'active',
    committedBytes: 0,
    reusedBytes: 0,
    attemptPayloadBytes: 0,
    paused: false,
    storageFull: false,
    recoveryAccepted: false,
  };
  session.observe(input);
  time = 1000;
  session.observe({ ...input, committedBytes: 500 });
  session.capture(emptyProbe('unsupported'));
  await session.flush();
  expect(session.getSnapshot().persistence).toBe('unavailable');
  expect(session.getSnapshot().report.summary.newlyConfirmedBytes).toBe(500);
  expect(value(session.getSnapshot().report, 'storage-commit')).toMatchObject({
    value: null,
    availabilityReason: 'not-applicable',
  });
  session.stop();
});
it('downsamples old history, keeps bounded recent detail and events, and exports within the logical byte cap', () => {
  const f = fixture();
  f.observe(1, { state: 'active' });
  for (let index = 1; index <= 400; index++) {
    f.observe(index * 1000, {
      committedBytes: index * 100,
      paused: index % 2 === 0,
      state: index % 2 === 0 ? 'paused' : 'active',
    });
    f.capture(index * 1000 + 1);
  }
  const report = f.session.getSnapshot().report;
  expect(report.samples.length).toBeLessThanOrEqual(240);
  expect(report.events.length).toBeLessThanOrEqual(128);
  expect(report.droppedEvents).toBeGreaterThan(0);
  expect(report.droppedFrames).toBeGreaterThan(0);
  expect(f.session.getSnapshot().liveFrames.length).toBeLessThanOrEqual(180);
  expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThanOrEqual(
    MAX_REPORT_BYTES,
  );
  expect(parseCsv(exportCsv(report))).toEqual(report);
  f.session.stop();
});
it('samples once per second, does not overlap a hung browser probe, and stops cleanly', async () => {
  vi.useFakeTimers();
  const collect = vi.fn(),
    getProbe = vi.fn(() => new Promise<TransportProbe>(() => {}));
  const sampler = new StatsSampler(getProbe, collect);
  try {
    sampler.start();
    await vi.advanceTimersByTimeAsync(3300);
    expect(getProbe).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledTimes(4);
    expect(collect.mock.calls.every((call) => call[0].iceRttMs === null)).toBe(true);
    sampler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(collect).toHaveBeenCalledTimes(4);
  } finally {
    sampler.stop();
    vi.useRealTimers();
  }
});
it('clears previous-connection measurements immediately and ignores a late old probe after invalidation', async () => {
  let release: (probe: TransportProbe) => void = () => {};
  const first = { ...emptyProbe(), iceRttMs: 12, path: 'direct' as const };
  const second = { ...emptyProbe(), iceRttMs: 27, path: 'relay' as const };
  const getProbe = vi
    .fn<() => Promise<TransportProbe>>()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(second);
  const sampler = new StatsSampler(getProbe, () => {});
  try {
    await sampler.tick();
    expect(sampler.latest().iceRttMs).toBe(12);
    const pending = sampler.tick();
    await Promise.resolve();
    sampler.invalidate();
    expect(sampler.latest()).toMatchObject({ iceRttMs: null, path: null, reason: 'not-connected' });
    release(first);
    await pending;
    expect(sampler.latest().iceRttMs).toBeNull();
    await sampler.tick();
    expect(sampler.latest()).toMatchObject({ iceRttMs: 27, path: 'relay' });
  } finally {
    sampler.stop();
  }
});
