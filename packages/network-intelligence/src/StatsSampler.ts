import { emptyProbe } from './Contracts';
import type { TransportProbe } from './Contracts';
interface ReportLike {
  get(id: string): unknown;
  forEach(callback: (value: unknown) => void): void;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
const positive = (value: unknown): number | null =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
/** Extract only allowlisted scalars. Raw candidate dictionaries never leave this function. */
export function readWebRtcStats(
  report: ReportLike,
): Pick<TransportProbe, 'iceRttMs' | 'path' | 'candidateState'> {
  const selected = new Set<string>();
  const fallback: Record<string, unknown>[] = [];
  report.forEach((raw) => {
    const row = object(raw);
    if (row?.type === 'transport' && typeof row.selectedCandidatePairId === 'string')
      selected.add(row.selectedCandidatePairId);
    if (row?.type === 'candidate-pair' && row.nominated === true && row.state === 'succeeded')
      fallback.push(row);
  });
  let pair: Record<string, unknown> | null = null;
  if (selected.size === 1) pair = object(report.get([...selected][0]!));
  else if (selected.size === 0 && fallback.length === 1) pair = fallback[0]!;
  if (pair?.type !== 'candidate-pair') return { iceRttMs: null, path: null, candidateState: null };
  const local =
    typeof pair.localCandidateId === 'string' ? object(report.get(pair.localCandidateId)) : null;
  const remote =
    typeof pair.remoteCandidateId === 'string' ? object(report.get(pair.remoteCandidateId)) : null;
  const types = new Set(['host', 'srflx', 'prflx', 'relay']);
  const localType = local?.type === 'local-candidate' ? local.candidateType : null;
  const remoteType = remote?.type === 'remote-candidate' ? remote.candidateType : null;
  const current = positive(pair.currentRoundTripTime);
  const usable = pair.state === 'succeeded';
  return {
    iceRttMs:
      usable && current !== null && current * 1000 <= Number.MAX_SAFE_INTEGER
        ? current * 1000
        : null,
    path: !usable
      ? null
      : localType === 'relay' || remoteType === 'relay'
        ? 'relay'
        : types.has(String(localType)) && types.has(String(remoteType))
          ? 'direct'
          : null,
    candidateState: ['waiting', 'in-progress', 'succeeded', 'failed', 'frozen'].includes(
      String(pair.state),
    )
      ? String(pair.state)
      : null,
  };
}
/** One 1-second scheduler, at most one underlying probe. A hung getStats never accumulates probes. */
export class StatsSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private probe: Promise<TransportProbe> | null = null;
  private last: TransportProbe = emptyProbe();
  private lastAt = -Infinity;
  private stopped = false;
  private generation = 0;
  constructor(
    private readonly getProbe: () => Promise<TransportProbe>,
    private readonly collect: (probe: TransportProbe) => void,
    private readonly clock = () => performance.now(),
  ) {}
  start(): void {
    if (this.timer || this.stopped) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.probe) {
      const generation = this.generation;
      const operation = Promise.resolve().then(this.getProbe);
      this.probe = operation;
      void operation
        .then(
          (value) => {
            if (!this.stopped && generation === this.generation) {
              this.last = value;
              this.lastAt = this.clock();
            }
          },
          () => {
            if (!this.stopped && generation === this.generation) {
              this.last = emptyProbe('sampler-error');
              this.lastAt = this.clock();
            }
          },
        )
        .finally(() => {
          if (this.probe === operation) this.probe = null;
        });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.probe.catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 200);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!this.stopped) this.collect(this.latest());
  }
  latest(): TransportProbe {
    return this.clock() - this.lastAt <= 3000
      ? this.last
      : emptyProbe(this.lastAt === -Infinity ? 'insufficient-samples' : 'stale-sample');
  }
  invalidate(): void {
    this.generation++;
    this.last = emptyProbe('not-connected');
    this.lastAt = this.clock();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
