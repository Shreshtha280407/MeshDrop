export const EVENT_TEXT = {
  started: 'Transfer measurements started. Reports stay in this browser.',
  accepted: 'The receiver accepted the transfer.',
  paused: 'The transfer is paused. A throughput dip is expected while paused.',
  continued: 'The pause ended. New receiver confirmations can advance throughput.',
  'connection-interrupted':
    'The connection was interrupted. Retained bytes are awaiting revalidation.',
  'connection-restored':
    'A fresh peer connection is ready. Pairing and resume checks are still required.',
  'resume-started': 'Saved blocks and original source identity are being revalidated.',
  resumed: 'Resume authenticated. The reused byte count comes from verified receiver proofs.',
  'storage-full': 'Receiver storage is full. Confirmed earlier blocks remain retained.',
  'storage-recovered': 'Receiver storage accepted the pending block after retry.',
  verifying: 'All file bytes are confirmed. Final file hashes and receipt are being checked.',
  verified: 'The final hashes and receipt were verified by the transfer engine.',
  failed: 'The transfer failed before confirmed completion. No cause is inferred from throughput.',
  cancelled:
    'The user cancelled the attempt. Local transfer deletion follows its explicit controls.',
  'ack-stalled':
    'No new receiver-confirmed bytes for at least 5 seconds while active. This does not identify the network cause.',
  'buffer-pressure':
    'The local send buffer stayed above 384 KiB for at least 3 samples. This measures the browser send queue.',
  'relay-selected':
    'The selected candidate pair includes a relay. This observation alone does not explain throughput.',
  'slow-storage':
    'At least 3 observed receiver commits exceeded 250 ms. This includes worker processing, verification, flush and ledger work.',
  'sampling-gap':
    'Sampling was delayed for more than 3 seconds. The graph leaves a gap; background execution is not guaranteed.',
} as const;
export type EventCode = keyof typeof EVENT_TEXT;
export type Severity = 'info' | 'warning' | 'error';
export interface MeasuredEvidence {
  epoch?: number | undefined;
  committedBytes?: number | undefined;
  reusedBytes?: number | undefined;
  durationMs?: number | undefined;
  ackAgeMs?: number | undefined;
  bufferedBytes?: number | undefined;
  consecutiveSamples?: number | undefined;
  thresholdMs?: number | undefined;
}
export interface NetworkEvent {
  eventId: string;
  transferId: string;
  code: EventCode;
  severity: Severity;
  observedAt: number;
  measuredEvidence: MeasuredEvidence;
  userMessage: string;
}
export function networkEvent(
  transferId: string,
  code: EventCode,
  observedAt: number,
  measuredEvidence: MeasuredEvidence = {},
  severity: Severity = 'info',
): NetworkEvent {
  return {
    eventId: crypto.randomUUID(),
    transferId,
    code,
    severity,
    observedAt,
    measuredEvidence,
    userMessage: EVENT_TEXT[code],
  };
}
