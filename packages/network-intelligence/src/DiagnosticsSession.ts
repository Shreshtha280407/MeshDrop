import { Aggregator } from './Aggregator';
import { Rules } from './Rules';
import { StatsSampler } from './StatsSampler';
import { MetricsStore } from './MetricsStore';
import { boundedReport, emptyProbe, measurement, MAX_EVENTS, RETENTION_MS } from './Contracts';
import type { LocalReport, MetricFrame, TransportProbe } from './Contracts';
import { networkEvent } from './Events';
import type { EventCode, MeasuredEvidence, Severity } from './Events';
export interface TransferObservation {
  transferId: string;
  epoch: number;
  state: string;
  committedBytes: number;
  reusedBytes: number;
  attemptPayloadBytes: number;
  paused: boolean;
  storageFull: boolean;
  recoveryAccepted: boolean;
}
export interface DiagnosticsView {
  report: LocalReport;
  liveFrames: MetricFrame[];
  persistence: 'saving' | 'saved' | 'unavailable';
}
export class DiagnosticsSession {
  private report: LocalReport;
  private liveFrames: MetricFrame[] = [];
  private durable: MetricFrame[] = [];
  private aggregator = new Aggregator();
  private rules = new Rules();
  private sampler: StatsSampler;
  private previous: TransferObservation | null = null;
  private current: TransferObservation;
  private baseline = 0;
  private activeSince = 0;
  private interruptedAt: number | null = null;
  private recoveryDuration: number | null = null;
  private lastRestoredEpoch = 0;
  private storageMs: number | null = null;
  private storageSequence = 0;
  private lastFrameAt = -1;
  private durableAt = -Infinity;
  private origin: number;
  private clock: () => number;
  private persistence: DiagnosticsView['persistence'] = 'saving';
  private endedAt: number | null = null;
  private capturedFrames = 0;
  private stopped = false;
  private writing = false;
  private wanted: LocalReport | null = null;
  private settled: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private view: DiagnosticsView;
  constructor(input: {
    transferId: string;
    role: 'owner' | 'receiver';
    epoch: number;
    probe: () => Promise<TransportProbe>;
    store?: Pick<MetricsStore, 'put'>;
    clock?: () => number;
    wallClock?: () => number;
    autoStart?: boolean;
  }) {
    this.clock = input.clock ?? (() => performance.now());
    this.origin = this.clock();
    this.wall = input.wallClock ?? Date.now;
    this.store = input.store ?? new MetricsStore();
    const now = this.wall();
    this.report = {
      schemaVersion: 1,
      reportId: crypto.randomUUID(),
      transferId: input.transferId,
      role: input.role,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RETENTION_MS).toISOString(),
      durationMs: 0,
      status: 'recording',
      summary: {
        newlyConfirmedBytes: 0,
        reusedBytes: 0,
        attemptPayloadBytes: 0,
        confirmedBytes: 0,
        recoveryDurationMs: null,
      },
      samples: [],
      events: [],
      droppedFrames: 0,
      droppedEvents: 0,
    };
    this.current = {
      transferId: input.transferId,
      epoch: input.epoch,
      state: 'negotiating',
      committedBytes: 0,
      reusedBytes: 0,
      attemptPayloadBytes: 0,
      paused: false,
      storageFull: false,
      recoveryAccepted: false,
    };
    this.probeForRestart = input.probe;
    this.sampler = new StatsSampler(input.probe, (probe) => this.capture(probe), this.clock);
    this.view = { report: this.report, liveFrames: [], persistence: 'saving' };
    this.event('started', {});
    if (input.autoStart !== false) this.sampler.start();
  }
  private wall: () => number;
  private store: Pick<MetricsStore, 'put'>;
  readonly getSnapshot = () => this.view;
  get isStopped(): boolean {
    return this.stopped;
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private at(): number {
    return Math.max(0, this.clock() - this.origin);
  }
  private event(
    code: EventCode,
    evidence: MeasuredEvidence,
    severity: Severity = 'info',
    observedAt = this.at(),
  ): void {
    const event = networkEvent(this.report.transferId, code, observedAt, evidence, severity);
    this.report = {
      ...this.report,
      events: [...this.report.events, event].slice(-MAX_EVENTS),
      droppedEvents: this.report.droppedEvents + (this.report.events.length >= MAX_EVENTS ? 1 : 0),
    };
  }
  observe(input: TransferObservation): void {
    if (this.stopped || input.transferId !== this.report.transferId) return;
    const at = this.at(),
      previous = this.previous;
    if (
      previous &&
      (input.epoch !== previous.epoch ||
        (input.state === 'reconnecting' && previous.state !== 'reconnecting'))
    )
      this.sampler.invalidate();
    this.current = input;
    if (this.report.status !== 'recording' && input.state === 'preparing') this.restartSampling();
    const changed =
      !previous ||
      input.epoch !== previous.epoch ||
      input.state !== previous.state ||
      input.paused !== previous.paused ||
      input.storageFull !== previous.storageFull ||
      input.recoveryAccepted !== previous.recoveryAccepted;
    if (
      input.state === 'preparing' ||
      input.state === 'negotiating' ||
      input.state === 'reconnecting' ||
      !previous ||
      input.reusedBytes !== previous.reusedBytes ||
      input.epoch !== previous.epoch
    )
      this.baseline = input.committedBytes;
    else if (input.committedBytes > this.baseline) {
      this.aggregator.acknowledge(at, input.committedBytes - this.baseline);
      this.baseline = input.committedBytes;
    } else this.baseline = input.committedBytes;
    if (input.state === 'active' && previous?.state !== 'active') this.activeSince = at;
    if (previous && input.paused !== previous.paused)
      this.event(input.paused ? 'paused' : 'continued', {
        epoch: input.epoch,
        committedBytes: input.committedBytes,
      });
    if (input.state === 'reconnecting' && previous?.state !== 'reconnecting') {
      this.interruptedAt ??= at;
      this.event('connection-interrupted', {
        epoch: input.epoch,
        committedBytes: input.committedBytes,
      });
    }
    if (
      input.state === 'preparing' &&
      previous &&
      ['reconnecting', 'failed'].includes(previous.state)
    )
      this.event('resume-started', { epoch: input.epoch });
    if (input.recoveryAccepted && !previous?.recoveryAccepted) {
      this.recoveryDuration = this.interruptedAt === null ? null : at - this.interruptedAt;
      this.event('resumed', {
        epoch: input.epoch,
        reusedBytes: input.reusedBytes,
        ...(this.recoveryDuration === null ? {} : { durationMs: this.recoveryDuration }),
      });
      this.interruptedAt = null;
    }
    if (input.storageFull !== previous?.storageFull && (input.storageFull || previous?.storageFull))
      this.event(
        input.storageFull ? 'storage-full' : 'storage-recovered',
        { committedBytes: input.committedBytes },
        input.storageFull ? 'warning' : 'info',
      );
    if (input.state !== previous?.state) {
      if (input.state === 'active' && previous?.state === 'negotiating' && !input.recoveryAccepted)
        this.event('accepted', { epoch: input.epoch });
      if (['verifying', 'complete', 'failed', 'cancelled'].includes(input.state))
        this.event(
          input.state === 'complete'
            ? 'verified'
            : (input.state as 'verifying' | 'failed' | 'cancelled'),
          { committedBytes: input.committedBytes },
          input.state === 'failed' ? 'error' : 'info',
        );
    }
    this.previous = { ...input };
    if (changed) this.capture(this.sampler.latest());
    if (['complete', 'failed', 'cancelled'].includes(input.state)) {
      this.report = { ...this.report, status: input.state as 'complete' | 'failed' | 'cancelled' };
      this.sampler.stop();
      this.endedAt = this.report.durationMs;
      this.publish();
      this.persist();
      // A failed/cancelled attempt can be retried manually under the same transfer report.
    }
  }
  connectionRestored(epoch: number): void {
    if (
      this.stopped ||
      this.report.status !== 'recording' ||
      this.interruptedAt === null ||
      epoch === this.lastRestoredEpoch
    )
      return;
    this.lastRestoredEpoch = epoch;
    this.sampler.invalidate();
    this.current = { ...this.current, epoch };
    this.event('connection-restored', { epoch });
    this.capture(this.sampler.latest());
  }
  storageCommitted(durationMs: number): void {
    if (this.stopped || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.storageMs = durationMs;
    this.storageSequence++;
  }
  restartSampling(): void {
    if (this.stopped) return;
    this.endedAt = null;
    this.sampler.stop();
    this.sampler = new StatsSampler(
      this.probeForRestart,
      (probe) => this.capture(probe),
      this.clock,
    );
    this.report = { ...this.report, status: 'recording' };
    this.sampler.start();
  }
  private probeForRestart: () => Promise<TransportProbe> = async () => emptyProbe();
  setProbe(probe: () => Promise<TransportProbe>): void {
    this.probeForRestart = probe;
  }
  capture(probe: TransportProbe = emptyProbe()): void {
    try {
      this.captureMeasured(probe);
    } catch {
      this.abandon();
    }
  }
  abandon(): void {
    this.stopped = true;
    this.sampler.stop();
    this.persistence = 'unavailable';
    this.publish();
  }
  private captureMeasured(probe: TransportProbe): void {
    if (this.stopped || this.endedAt !== null) return;
    const at = this.at();
    if (at <= this.lastFrameAt) return;
    const rate = this.aggregator.sample(at);
    if (this.lastFrameAt >= 0 && at - this.lastFrameAt > 3000)
      this.event('sampling-gap', { durationMs: at - this.lastFrameAt }, 'warning', at);
    this.lastFrameAt = at;
    this.capturedFrames++;
    const sample = (...args: Parameters<typeof measurement>) => measurement(...args);
    const frame: MetricFrame = {
      timestampMonotonic: at,
      intervalDurationMs: rate.intervalDurationMs,
      epoch: this.current.epoch,
      state: this.current.state,
      samples: [
        sample('ack-interval', rate.interval, at, 'insufficient-samples'),
        sample('ack-rolling', rate.rolling, at, rate.rollingReason),
        sample('ack-average', rate.average, at, 'insufficient-samples'),
        sample(
          'application-rtt',
          probe.applicationRttMs,
          at,
          probe.reason === 'unsupported' ? 'insufficient-samples' : probe.reason,
        ),
        sample('ice-rtt', probe.iceRttMs, at, probe.reason),
        sample('send-buffer', probe.bufferedBytes, at, probe.reason),
        sample(
          'storage-commit',
          this.storageMs,
          at,
          this.report.role === 'owner' ? 'not-applicable' : 'insufficient-samples',
        ),
        sample('confirmed-bytes', this.current.committedBytes, at),
        sample('reused-bytes', this.current.reusedBytes, at),
        sample('attempt-payload', this.current.attemptPayloadBytes, at),
        sample('recovery-duration', this.recoveryDuration, at, 'insufficient-samples'),
        sample('connection-path', probe.path, at, probe.reason),
        sample('candidate-state', probe.candidateState, at, probe.reason),
      ],
    };
    for (const rule of this.rules.evaluate({
      at,
      active: this.current.state === 'active' && !this.current.paused,
      ackAgeMs: Math.min(rate.ackAgeMs, at - this.activeSince),
      bufferedBytes: probe.bufferedBytes,
      path: probe.path,
      storageCommitMs: this.storageMs,
      storageSequence: this.storageSequence,
    }))
      this.event(rule.code, rule.evidence, rule.code === 'relay-selected' ? 'info' : 'warning', at);
    this.liveFrames = [...this.liveFrames, frame]
      .filter((point) => point.timestampMonotonic >= at - 120000)
      .slice(-180);
    if (at - this.durableAt >= 5000) {
      this.durable.push(frame);
      this.durableAt = at;
      if (this.durable.length > 120) {
        const old = this.durable;
        this.durable = old.filter(
          (_, index) => index === 0 || index === old.length - 1 || index % 2 === 0,
        );
        this.report = {
          ...this.report,
          droppedFrames: this.report.droppedFrames + old.length - this.durable.length,
        };
      }
    }
    const points = new Map(
      [...this.durable, ...this.liveFrames].map((frame) => [frame.timestampMonotonic, frame]),
    );
    const now = this.wall();
    this.report = boundedReport({
      ...this.report,
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + RETENTION_MS).toISOString(),
      durationMs: at,
      samples: [...points.values()].sort((a, b) => a.timestampMonotonic - b.timestampMonotonic),
      summary: {
        newlyConfirmedBytes: this.aggregator.totalBytes,
        reusedBytes: this.current.reusedBytes,
        attemptPayloadBytes: this.current.attemptPayloadBytes,
        confirmedBytes: this.current.committedBytes,
        recoveryDurationMs: this.recoveryDuration,
      },
    });
    this.report = {
      ...this.report,
      droppedFrames: this.capturedFrames - this.report.samples.length,
    };
    this.publish();
    this.persist();
  }
  private publish(): void {
    this.view = { report: this.report, liveFrames: this.liveFrames, persistence: this.persistence };
    for (const listener of this.listeners) listener();
  }
  private persist(): void {
    this.wanted = this.report;
    this.persistence = 'saving';
    if (this.writing) {
      this.publish();
      return;
    }
    this.writing = true;
    this.publish();
    this.settled = (async () => {
      while (this.wanted) {
        const report = this.wanted;
        this.wanted = null;
        try {
          await this.store.put(report);
          this.persistence = this.wanted ? 'saving' : 'saved';
        } catch {
          this.persistence = 'unavailable';
        }
        this.publish();
      }
      this.writing = false;
    })();
  }
  async flush(): Promise<void> {
    await this.settled;
  }
  stop(): void {
    if (this.stopped) return;
    this.capture(this.sampler.latest());
    this.sampler.stop();
    this.stopped = true;
    if (this.report.status === 'recording') this.report = { ...this.report, status: 'interrupted' };
    this.publish();
    this.persist();
  }
}
