import type { AvailabilityReason } from './Contracts';
/** Receiver-confirmed deltas only. Reused checkpoints are never inserted as newly transferred bytes. */
export class Aggregator {
  private acknowledgments: { at: number; bytes: number }[] = [];
  private cutoffLost = -Infinity;
  private lastSampleAt: number | null = null;
  private previousTotal = 0;
  private lastAckAt = 0;
  totalBytes = 0;
  acknowledge(at: number, bytes: number): void {
    if (
      !Number.isFinite(at) ||
      at < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      at < this.lastAckAt
    )
      throw new Error('Invalid monotonic ACK evidence.');
    if (!bytes) return;
    this.totalBytes += bytes;
    this.lastAckAt = at;
    this.acknowledgments.push({ at, bytes });
    this.prune(at);
    if (this.acknowledgments.length > 4096) {
      this.cutoffLost = this.acknowledgments[0]!.at;
      this.acknowledgments.shift();
    }
  }
  private prune(at: number) {
    this.acknowledgments = this.acknowledgments.filter((ack) => ack.at > at - 10000);
  }
  sample(at: number): {
    interval: number | null;
    rolling: number | null;
    average: number | null;
    intervalDurationMs: number;
    rollingReason: AvailabilityReason;
    ackAgeMs: number;
  } {
    if (!Number.isFinite(at) || at < 0 || (this.lastSampleAt !== null && at < this.lastSampleAt))
      throw new Error('Sampling clock regressed.');
    this.prune(at);
    const duration = this.lastSampleAt === null ? 0 : at - this.lastSampleAt;
    const interval =
      duration > 0 ? ((this.totalBytes - this.previousTotal) * 1000) / duration : null;
    const window = Math.min(at, 10000),
      missing = this.cutoffLost >= at - 10000;
    const rolling =
      window > 0 && !missing
        ? (this.acknowledgments.reduce((sum, ack) => sum + ack.bytes, 0) * 1000) / window
        : null;
    const average = at > 0 ? (this.totalBytes * 1000) / at : null;
    this.lastSampleAt = at;
    this.previousTotal = this.totalBytes;
    return {
      interval,
      rolling,
      average,
      intervalDurationMs: duration,
      rollingReason: missing ? 'history-cap' : 'insufficient-samples',
      ackAgeMs: Math.max(0, at - this.lastAckAt),
    };
  }
}
export function megabytesPerSecond(bytesPerSecond: number): number {
  return bytesPerSecond / 1000000;
}
export function megabitsPerSecond(bytesPerSecond: number): number {
  return (bytesPerSecond * 8) / 1000000;
}
