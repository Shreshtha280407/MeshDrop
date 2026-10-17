import type { EventCode, MeasuredEvidence } from './Events';
export interface RuleObservation {
  at: number;
  active: boolean;
  ackAgeMs: number;
  bufferedBytes: number | null;
  path: 'direct' | 'relay' | null;
  storageCommitMs: number | null;
  storageSequence: number;
}
export class Rules {
  private bufferRun = 0;
  private bufferSince: number | null = null;
  private slowRun = 0;
  private storageSequence = -1;
  private activeCodes = new Set<EventCode>();
  evaluate(input: RuleObservation): { code: EventCode; evidence: MeasuredEvidence }[] {
    this.bufferRun =
      input.active && input.bufferedBytes !== null && input.bufferedBytes >= 384 * 1024
        ? this.bufferRun + 1
        : 0;
    if (this.bufferRun === 0) this.bufferSince = null;
    else this.bufferSince ??= input.at;
    if (input.storageSequence !== this.storageSequence) {
      this.storageSequence = input.storageSequence;
      this.slowRun =
        input.storageCommitMs !== null && input.storageCommitMs >= 250 ? this.slowRun + 1 : 0;
    }
    const result: { code: EventCode; evidence: MeasuredEvidence }[] = [];
    const record = (code: EventCode, condition: boolean, evidence: MeasuredEvidence) => {
      if (condition && !this.activeCodes.has(code)) result.push({ code, evidence });
      if (condition) this.activeCodes.add(code);
      else this.activeCodes.delete(code);
    };
    record('ack-stalled', input.active && input.ackAgeMs >= 5000, {
      ackAgeMs: input.ackAgeMs,
      thresholdMs: 5000,
    });
    record(
      'buffer-pressure',
      this.bufferRun >= 3 && this.bufferSince !== null && input.at - this.bufferSince >= 2000,
      {
        bufferedBytes: input.bufferedBytes ?? 0,
        consecutiveSamples: this.bufferRun,
        durationMs: this.bufferSince === null ? 0 : input.at - this.bufferSince,
      },
    );
    record('relay-selected', input.path === 'relay', {});
    record('slow-storage', this.slowRun >= 3, {
      durationMs: input.storageCommitMs ?? 0,
      thresholdMs: 250,
      consecutiveSamples: this.slowRun,
    });
    return result;
  }
}
