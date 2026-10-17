import { memo, useEffect, useMemo, useState } from 'react';
import {
  downloadReport,
  MetricsStore,
  megabytesPerSecond,
  megabitsPerSecond,
} from '@meshdrop/network-intelligence';
import type {
  LocalReport,
  MetricFrame,
  MetricName,
  MetricSample,
} from '@meshdrop/network-intelligence';
import type { RoomClient, RoomView } from '../pairing/RoomClient';
const LABELS: Record<MetricName, string> = {
  'ack-interval': 'Receiver confirmations — last sample interval',
  'ack-rolling': 'Receiver confirmations — rolling 10 seconds',
  'ack-average': 'Average confirmations over this report',
  'application-rtt': 'Application round trip',
  'ice-rtt': 'ICE candidate round trip',
  'send-buffer': 'Local send buffer',
  'storage-commit': 'Latest receiver storage commit',
  'confirmed-bytes': 'Receiver-confirmed bytes',
  'reused-bytes': 'Current attempt reused bytes',
  'attempt-payload': 'Current attempt payload bytes',
  'recovery-duration': 'Interruption to authenticated resume',
  'connection-path': 'Selected connection path',
  'candidate-state': 'Selected candidate pair state',
};
function metric(frame: MetricFrame | undefined, name: MetricName): MetricSample | undefined {
  return frame?.samples.find((sample) => sample.metricName === name);
}
function format(sample: MetricSample | undefined): string {
  if (!sample || sample.value === null) return 'Unavailable';
  if (typeof sample.value === 'string') return sample.value;
  if (sample.unit === 'B/s')
    return `${megabytesPerSecond(sample.value).toFixed(2)} MB/s · ${megabitsPerSecond(sample.value).toFixed(2)} Mbps`;
  return `${sample.value.toLocaleString(undefined, { maximumFractionDigits: sample.unit === 'ms' ? 2 : 0 })} ${sample.unit}`;
}
const REASONS: Record<string, string> = {
  unsupported: 'The browser did not provide this field.',
  'not-connected': 'No connected transport was observed.',
  'insufficient-samples': 'Not enough measurements yet.',
  'stale-sample': 'The previous transport measurement is too old.',
  'sampler-error': 'Browser statistics could not be read.',
  'history-cap': 'The bounded history cannot support this rolling window.',
  'not-applicable': 'Measured on the receiving device.',
};
function description(sample: MetricSample | undefined): string {
  if (!sample) return 'Waiting for a measurement.';
  if (sample.value === null)
    return REASONS[sample.availabilityReason ?? ''] ?? 'No measurement is available.';
  return sample.provenance === 'signed-control-round-trip'
    ? 'Includes channel queuing, peer processing and signature verification.'
    : sample.provenance === 'receiver-worker-commit'
      ? 'Worker request through write, hash verification, flush and ledger commit.'
      : sample.provenance === 'selected-candidate-pair'
        ? 'Observed from the selected ICE candidate pair.'
        : sample.provenance === 'receiver-confirmations'
          ? 'New receiver confirmations; revalidated reused bytes are excluded from throughput.'
          : sample.provenance === 'data-channel-buffer'
            ? 'Bytes currently queued in this browser’s data channel.'
            : sample.provenance === 'authenticated-resume'
              ? 'Revalidated receiver proofs accepted by the sender.'
              : 'Measured locally with a monotonic clock.';
}
function chartValue(frame: MetricFrame, name: MetricName): number | null {
  const value = metric(frame, name)?.value;
  return typeof value === 'number'
    ? name.startsWith('ack-')
      ? megabytesPerSecond(value)
      : value
    : null;
}
function Timeline({ frames, report }: { frames: MetricFrame[]; report: LocalReport }) {
  const [name, setName] = useState<MetricName>('ack-interval');
  const [selectedAt, setSelectedAt] = useState<number | null>(null);
  const latest = frames.at(-1),
    selected =
      selectedAt === null
        ? latest
        : frames.reduce<MetricFrame | undefined>(
            (best, frame) =>
              !best ||
              Math.abs(frame.timestampMonotonic - selectedAt) <
                Math.abs(best.timestampMonotonic - selectedAt)
                ? frame
                : best,
            undefined,
          );
  const first = frames[0]?.timestampMonotonic ?? 0,
    last = latest?.timestampMonotonic ?? 1,
    span = Math.max(1, last - first);
  const max = Math.max(0.01, ...frames.map((frame) => chartValue(frame, name) ?? 0));
  const x = (at: number) => 52 + ((at - first) / span) * 700,
    y = (value: number) => 185 - (value / max) * 155;
  const segments: string[] = [];
  let previous: MetricFrame | undefined;
  for (const frame of frames) {
    const value = chartValue(frame, name);
    if (value === null) {
      previous = undefined;
      continue;
    }
    segments.push(
      `${!previous || frame.timestampMonotonic - previous.timestampMonotonic > 3000 ? 'M' : 'L'}${x(frame.timestampMonotonic).toFixed(2)},${y(value).toFixed(2)}`,
    );
    previous = frame;
  }
  const events = report.events.filter(
    (event) => event.observedAt >= first && event.observedAt <= last,
  );
  const unit = name.startsWith('ack-') ? 'MB/s' : name === 'send-buffer' ? 'bytes' : 'ms';
  const index = Math.max(
    0,
    frames.findIndex((frame) => frame === selected),
  );
  return (
    <div className="metrics-chart">
      <label>
        Chart measurement
        <select
          aria-label="Chart measurement"
          value={name}
          onChange={(event) => setName(event.target.value as MetricName)}
        >
          {(
            [
              'ack-interval',
              'ack-rolling',
              'application-rtt',
              'ice-rtt',
              'send-buffer',
              'storage-commit',
            ] as MetricName[]
          ).map((name) => (
            <option key={name} value={name}>
              {LABELS[name]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {LABELS[name]} ({unit}); time is seconds since this local report began. Missing values and
        sampling gaps are left blank.
      </p>
      <svg
        viewBox="0 0 800 230"
        role="img"
        aria-label={`${LABELS[name]} timeline with pause, connection and recovery annotations`}
        data-testid="metrics-chart"
      >
        <title>Locally measured transfer timeline</title>
        <path d="M52 25V185H752" fill="none" stroke="#a5b9ad" />
        <text x="4" y="30">
          {max.toFixed(2)}
        </text>
        <text x="27" y="188">
          0
        </text>
        <text x="52" y="215">
          {(first / 1000).toFixed(1)} s
        </text>
        <text x="690" y="215">
          {(last / 1000).toFixed(1)} s
        </text>
        {events.map((event) => (
          <g key={event.eventId} data-event-code={event.code}>
            <title>
              {event.code} at {(event.observedAt / 1000).toFixed(2)} s: {event.userMessage}
            </title>
            <line
              x1={x(event.observedAt)}
              x2={x(event.observedAt)}
              y1="30"
              y2="185"
              stroke={event.severity === 'warning' ? '#a56f26' : '#91a998'}
              strokeDasharray="3 5"
            />
            <circle cx={x(event.observedAt)} cy="25" r="3" fill="#a56f26" />
          </g>
        ))}
        <path d={segments.join(' ')} fill="none" stroke="#164d42" strokeWidth="2.5" />
        {selected && (
          <line
            x1={x(selected.timestampMonotonic)}
            x2={x(selected.timestampMonotonic)}
            y1="25"
            y2="185"
            stroke="#4a7566"
          />
        )}
      </svg>
      {frames.length > 0 && (
        <>
          <label htmlFor={`sample-${report.reportId}`}>
            Inspect sample ({((selected?.timestampMonotonic ?? 0) / 1000).toFixed(3)} s)
          </label>
          <input
            id={`sample-${report.reportId}`}
            aria-label="Inspect measurement sample"
            type="range"
            min="0"
            max={frames.length - 1}
            value={index}
            onChange={(event) =>
              setSelectedAt(frames[Number(event.target.value)]!.timestampMonotonic)
            }
          />
          <button className="secondary" onClick={() => setSelectedAt(null)}>
            Follow latest sample
          </button>
          <p data-testid="selected-measurement">
            <strong>{format(metric(selected, name))}</strong> · interval{' '}
            {((selected?.intervalDurationMs ?? 0) / 1000).toFixed(3)} s.{' '}
            {description(metric(selected, name))}
          </p>
        </>
      )}
    </div>
  );
}
export const NetworkPanel = memo(function NetworkPanel({
  client,
  view,
}: {
  client: RoomClient;
  view: Pick<RoomView, 'diagnostics' | 'diagnosticsError'>;
}) {
  const store = useMemo(() => new MetricsStore(), []);
  const [history, setHistory] = useState<LocalReport[]>([]);
  const [selected, setSelected] = useState('live');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const live = view.diagnostics;
  const report =
    selected === 'live' ? live?.report : history.find((report) => report.reportId === selected);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setHistory(await store.list());
    } catch {
      setError(
        'Local measurement history is unavailable in this browser mode. File transfer can continue.',
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let current = true;
    void store
      .list()
      .then((value) => {
        if (current) setHistory(value);
      })
      .catch(() => {
        if (current) setError('Local measurement history is unavailable in this browser mode.');
      });
    return () => {
      current = false;
    };
  }, [store]);
  const frames = selected === 'live' ? (live?.liveFrames ?? []) : (report?.samples ?? []);
  const last = frames.at(-1);
  async function remove() {
    if (!report) return;
    setBusy(true);
    try {
      await client.deleteDiagnostics(report.reportId);
      setHistory(await store.list());
      setSelected('live');
    } catch {
      setError('The local report could not be deleted. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="demo-panel network-panel"
      aria-labelledby="network-title"
      data-testid="network-intelligence"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">MEASURED ON THIS DEVICE</p>
          <h2 id="network-title">Transfer insights</h2>
        </div>
        <span className="pill">Local reports</span>
      </div>
      <p className="demo-note">
        Measurements explain observed behavior. Low throughput alone does not establish Wi-Fi
        congestion, ISP throttling or a remote device problem. No diagnostics are uploaded.
      </p>
      <div className="actions">
        <label>
          Measurement report
          <select
            aria-label="Measurement report"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="live">Current page session</option>
            {history
              .filter((report) => report.reportId !== live?.report.reportId)
              .map((report) => (
                <option key={report.reportId} value={report.reportId}>
                  {new Date(report.startedAt).toLocaleString()} · {report.role} ·{' '}
                  {report.status === 'recording' ? 'saved snapshot' : report.status}
                </option>
              ))}
          </select>
        </label>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
        >
          Refresh local reports
        </button>
      </div>
      {error && (
        <p role="status" className="error">
          {error}
        </p>
      )}
      {view.diagnosticsError && (
        <p role="status" className="status-note">
          {view.diagnosticsError}
        </p>
      )}
      {!report && (
        <p className="muted">
          Start a transfer to collect measurements, or select a saved local report. Unsupported
          metrics will display Unavailable.
        </p>
      )}
      {report && (
        <>
          <p className="muted">
            {selected === 'live' ? 'Current page session' : 'Saved snapshot'} · elapsed{' '}
            <strong data-testid="metrics-duration">{(report.durationMs / 1000).toFixed(2)}</strong>{' '}
            s · history{' '}
            <strong data-testid="metrics-persistence">
              {selected === 'live' ? live?.persistence : 'saved'}
            </strong>
            . Receiver-confirmed speed uses decimal MB/s and Mbps.
          </p>
          {live?.persistence === 'unavailable' && selected === 'live' && (
            <p role="status" className="status-note">
              Local history could not be saved. Live measurements and file verification remain
              independent; export this report if needed.
            </p>
          )}
          <div className="metrics-grid">
            {(
              [
                'ack-interval',
                'ack-rolling',
                'application-rtt',
                'ice-rtt',
                'send-buffer',
                'storage-commit',
                'connection-path',
                'candidate-state',
              ] as MetricName[]
            ).map((name) => (
              <div className="metric-card" key={name}>
                <span>{LABELS[name]}</span>
                <strong data-testid={`metric-${name}`}>{format(metric(last, name))}</strong>
                <small>{description(metric(last, name))}</small>
              </div>
            ))}
          </div>
          <p className="status-note">
            New receiver-confirmed bytes on this page:{' '}
            <strong data-testid="metrics-new-bytes">{report.summary.newlyConfirmedBytes}</strong>.
            Current authenticated reuse:{' '}
            <strong data-testid="metrics-reused-bytes">{report.summary.reusedBytes}</strong> bytes.
            Reused bytes are excluded from speed measurements.
          </p>
          <Timeline key={report.reportId} frames={frames} report={report} />
          <details open>
            <summary>Observed events ({report.events.length})</summary>
            <ol className="measurement-events" data-testid="measurement-events">
              {report.events.map((event) => (
                <li key={event.eventId} data-event-code={event.code}>
                  <strong>
                    {(event.observedAt / 1000).toFixed(2)} s · {event.code}
                  </strong>
                  <span>{event.userMessage}</span>
                  {event.measuredEvidence.reusedBytes !== undefined && (
                    <small>
                      Exactly {event.measuredEvidence.reusedBytes} verified bytes reused.
                    </small>
                  )}
                </li>
              ))}
            </ol>
          </details>
          <div className="actions">
            <button className="secondary" onClick={() => downloadReport(report, 'json')}>
              Export diagnostics JSON
            </button>
            <button className="secondary" onClick={() => downloadReport(report, 'csv')}>
              Export diagnostics CSV
            </button>
            <button
              className="secondary"
              disabled={busy || (selected === 'live' && report.status === 'recording')}
              onClick={() => {
                void remove();
              }}
            >
              Delete local report
            </button>
          </div>
          <p className="muted">
            Reports include byte counters, timing, categories and events; they omit filenames, file
            hashes, candidate addresses and credentials. Export only when you choose to share.
            History retains at most 10 reports / 4 MiB for 7 days.{' '}
            {report.droppedFrames || report.droppedEvents
              ? `This bounded snapshot removed ${report.droppedFrames} older sample frames and ${report.droppedEvents} events.`
              : ''}
          </p>
        </>
      )}
    </section>
  );
});
