import { z } from 'zod';
import { EVENT_TEXT } from './Events';
import type { NetworkEvent } from './Events';
export const MAX_REPORTS = 10,
  MAX_REPORT_BYTES = 512 * 1024,
  MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_FRAMES = 240,
  MAX_EVENTS = 128,
  RETENTION_MS = 7 * 86400000;
export const DEFINITIONS = {
  'ack-interval': { unit: 'B/s', provenance: 'receiver-confirmations' },
  'ack-rolling': { unit: 'B/s', provenance: 'receiver-confirmations' },
  'ack-average': { unit: 'B/s', provenance: 'receiver-confirmations' },
  'application-rtt': { unit: 'ms', provenance: 'signed-control-round-trip' },
  'ice-rtt': { unit: 'ms', provenance: 'selected-candidate-pair' },
  'send-buffer': { unit: 'bytes', provenance: 'data-channel-buffer' },
  'storage-commit': { unit: 'ms', provenance: 'receiver-worker-commit' },
  'confirmed-bytes': { unit: 'bytes', provenance: 'receiver-confirmations' },
  'reused-bytes': { unit: 'bytes', provenance: 'authenticated-resume' },
  'attempt-payload': { unit: 'bytes', provenance: 'application-payload-counter' },
  'recovery-duration': { unit: 'ms', provenance: 'monotonic-clock' },
  'connection-path': { unit: 'state', provenance: 'selected-candidate-pair' },
  'candidate-state': { unit: 'state', provenance: 'selected-candidate-pair' },
} as const;
export type MetricName = keyof typeof DEFINITIONS;
export type AvailabilityReason =
  | 'unsupported'
  | 'not-connected'
  | 'insufficient-samples'
  | 'stale-sample'
  | 'sampler-error'
  | 'history-cap'
  | 'not-applicable';
export interface MetricSample {
  timestampMonotonic: number;
  metricName: MetricName;
  value: number | string | null;
  unit: (typeof DEFINITIONS)[MetricName]['unit'];
  provenance: (typeof DEFINITIONS)[MetricName]['provenance'];
  availabilityReason: AvailabilityReason | null;
}
export interface MetricFrame {
  timestampMonotonic: number;
  intervalDurationMs: number;
  epoch: number;
  state: string;
  samples: MetricSample[];
}
export interface LocalReport {
  schemaVersion: 1;
  reportId: string;
  transferId: string;
  role: 'owner' | 'receiver';
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  durationMs: number;
  status: 'recording' | 'interrupted' | 'complete' | 'failed' | 'cancelled';
  summary: {
    newlyConfirmedBytes: number;
    reusedBytes: number;
    attemptPayloadBytes: number;
    confirmedBytes: number;
    recoveryDurationMs: number | null;
  };
  samples: MetricFrame[];
  events: NetworkEvent[];
  droppedFrames: number;
  droppedEvents: number;
}
export interface TransportProbe {
  iceRttMs: number | null;
  applicationRttMs: number | null;
  bufferedBytes: number | null;
  path: 'direct' | 'relay' | null;
  candidateState: string | null;
  reason: AvailabilityReason;
}
export const emptyProbe = (reason: AvailabilityReason = 'not-connected'): TransportProbe => ({
  iceRttMs: null,
  applicationRttMs: null,
  bufferedBytes: null,
  path: null,
  candidateState: null,
  reason,
});
export function measurement(
  metricName: MetricName,
  value: MetricSample['value'],
  timestampMonotonic: number,
  availabilityReason: AvailabilityReason = 'unsupported',
): MetricSample {
  return {
    metricName,
    value,
    timestampMonotonic,
    ...DEFINITIONS[metricName],
    availabilityReason: value === null ? availabilityReason : null,
  };
}
const finite = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const sampleSchema = z
  .strictObject({
    timestampMonotonic: finite,
    metricName: z.enum(Object.keys(DEFINITIONS) as [MetricName, ...MetricName[]]),
    value: z
      .union([
        finite,
        z.enum(['direct', 'relay', 'waiting', 'in-progress', 'succeeded', 'failed', 'frozen']),
      ])
      .nullable(),
    unit: z.enum(['B/s', 'ms', 'bytes', 'state']),
    provenance: z.enum([
      'receiver-confirmations',
      'signed-control-round-trip',
      'selected-candidate-pair',
      'data-channel-buffer',
      'receiver-worker-commit',
      'authenticated-resume',
      'application-payload-counter',
      'monotonic-clock',
    ]),
    availabilityReason: z
      .enum([
        'unsupported',
        'not-connected',
        'insufficient-samples',
        'stale-sample',
        'sampler-error',
        'history-cap',
        'not-applicable',
      ])
      .nullable(),
  })
  .superRefine((value, ctx) => {
    const expected = DEFINITIONS[value.metricName];
    if (
      value.unit !== expected.unit ||
      value.provenance !== expected.provenance ||
      (value.value === null) !== (value.availabilityReason !== null) ||
      (value.value !== null && (value.unit === 'state') !== (typeof value.value === 'string'))
    )
      ctx.addIssue({ code: 'custom', message: 'Measurement labels or availability do not match.' });
  });
const evidenceSchema = z.strictObject({
  epoch: finite.optional(),
  committedBytes: finite.optional(),
  reusedBytes: finite.optional(),
  durationMs: finite.optional(),
  ackAgeMs: finite.optional(),
  bufferedBytes: finite.optional(),
  consecutiveSamples: finite.optional(),
  thresholdMs: finite.optional(),
});
const eventSchema = z
  .strictObject({
    eventId: z.uuid(),
    transferId: z.uuid(),
    code: z.enum(
      Object.keys(EVENT_TEXT) as [keyof typeof EVENT_TEXT, ...(keyof typeof EVENT_TEXT)[]],
    ),
    severity: z.enum(['info', 'warning', 'error']),
    observedAt: finite,
    measuredEvidence: evidenceSchema,
    userMessage: z.string().max(240),
  })
  .superRefine((event, ctx) => {
    if (event.userMessage !== EVENT_TEXT[event.code])
      ctx.addIssue({ code: 'custom', message: 'Event message must be derived from its code.' });
  });
const frameSchema = z
  .strictObject({
    timestampMonotonic: finite,
    intervalDurationMs: finite,
    epoch: z.number().int().min(1).max(0xffffffff),
    state: z.enum([
      'preparing',
      'negotiating',
      'active',
      'paused',
      'reconnecting',
      'verifying',
      'complete',
      'failed',
      'cancelled',
    ]),
    samples: z.array(sampleSchema).length(Object.keys(DEFINITIONS).length),
  })
  .superRefine((frame, ctx) => {
    if (
      new Set(frame.samples.map((s) => s.metricName)).size !== frame.samples.length ||
      frame.samples.some((s) => s.timestampMonotonic !== frame.timestampMonotonic)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Frame samples must share the same clock and unique names.',
      });
  });
export const reportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reportId: z.uuid(),
    transferId: z.uuid(),
    role: z.enum(['owner', 'receiver']),
    startedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    durationMs: finite,
    status: z.enum(['recording', 'interrupted', 'complete', 'failed', 'cancelled']),
    summary: z.strictObject({
      newlyConfirmedBytes: finite,
      reusedBytes: finite,
      attemptPayloadBytes: finite,
      confirmedBytes: finite,
      recoveryDurationMs: finite.nullable(),
    }),
    samples: z.array(frameSchema).max(MAX_REPORT_FRAMES),
    events: z.array(eventSchema).max(MAX_EVENTS),
    droppedFrames: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative(),
  })
  .superRefine((report, ctx) => {
    if (
      report.samples.some(
        (frame, index) =>
          frame.timestampMonotonic > report.durationMs ||
          (index > 0 && frame.timestampMonotonic <= report.samples[index - 1]!.timestampMonotonic),
      ) ||
      report.events.some(
        (event, index) =>
          event.transferId !== report.transferId ||
          event.observedAt > report.durationMs ||
          (index > 0 && event.observedAt < report.events[index - 1]!.observedAt),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Report timestamps or event scope are invalid.' });
  });
export function boundedReport(input: LocalReport): LocalReport {
  let result = {
    ...input,
    samples: input.samples.slice(-MAX_REPORT_FRAMES),
    events: input.events.slice(-MAX_EVENTS),
    droppedFrames: input.droppedFrames + Math.max(0, input.samples.length - MAX_REPORT_FRAMES),
    droppedEvents: input.droppedEvents + Math.max(0, input.events.length - MAX_EVENTS),
  };
  while (
    new TextEncoder().encode(JSON.stringify(result)).length > MAX_REPORT_BYTES &&
    result.samples.length > 2
  ) {
    const keep = result.samples.filter(
      (_, index) => index === 0 || index === result.samples.length - 1 || index % 2 === 0,
    );
    result = {
      ...result,
      samples: keep,
      droppedFrames: result.droppedFrames + result.samples.length - keep.length,
    };
  }
  return reportSchema.parse(result);
}
