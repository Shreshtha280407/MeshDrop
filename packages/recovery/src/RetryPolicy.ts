export interface RetryView {
  attempt: number;
  nextAt: number | null;
  exhausted: boolean;
}
export class RetryPolicy {
  private attempts = 0;
  constructor(
    readonly maximum = 5,
    readonly baseMs = 1000,
    readonly capMs = 16000,
  ) {}
  next(now = Date.now()): RetryView {
    if (this.attempts >= this.maximum)
      return { attempt: this.attempts, nextAt: null, exhausted: true };
    const delay = Math.min(this.capMs, this.baseMs * 2 ** this.attempts++);
    return { attempt: this.attempts, nextAt: now + delay, exhausted: false };
  }
  reset(): void {
    this.attempts = 0;
  }
  mode(attempt: number): 'ice-restart' | 'new-connection' {
    return attempt === 1 ? 'ice-restart' : 'new-connection';
  }
}
