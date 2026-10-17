import { boundedReport, reportSchema } from './Contracts';
import type { LocalReport, MetricFrame } from './Contracts';
import type { NetworkEvent } from './Events';
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const HEADER = [
  'rowType',
  'timestampMonotonicMs',
  'intervalDurationMs',
  'epoch',
  'state',
  'metricName',
  'value',
  'unit',
  'provenance',
  'availabilityReason',
  'eventId',
  'eventCode',
  'severity',
  'userMessage',
  'measuredEvidenceJson',
  'metadataJson',
];
export function exportJson(report: LocalReport): string {
  return JSON.stringify(boundedReport(report), null, 2) + '\n';
}
export function parseJson(text: string): LocalReport {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    throw new Error('Report too large.');
  return reportSchema.parse(JSON.parse(text));
}
const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
export function exportCsv(input: LocalReport): string {
  const report = boundedReport(input);
  const { samples, events, ...metadata } = report;
  const rows: unknown[][] = [HEADER, ['report', ...Array(14).fill(''), JSON.stringify(metadata)]];
  const timeline = [
    ...samples.map((frame) => ({ at: frame.timestampMonotonic, frame, event: null })),
    ...events.map((event) => ({ at: event.observedAt, frame: null, event })),
  ].sort((a, b) => a.at - b.at);
  for (const entry of timeline) {
    if (entry.frame) {
      const frame = entry.frame;
      for (const sample of frame.samples)
        rows.push([
          'sample',
          frame.timestampMonotonic,
          frame.intervalDurationMs,
          frame.epoch,
          frame.state,
          sample.metricName,
          sample.value,
          sample.unit,
          sample.provenance,
          sample.availabilityReason,
          '',
          '',
          '',
          '',
          '',
          '',
        ]);
    } else {
      const event = entry.event!;
      rows.push([
        'event',
        event.observedAt,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        event.eventId,
        event.code,
        event.severity,
        event.userMessage,
        JSON.stringify(event.measuredEvidence),
        '',
      ]);
    }
  }
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
function csvRows(text: string): string[][] {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES)
    throw new Error('Report too large.');
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') {
      if (field) throw new Error('Invalid CSV quote.');
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
export function parseCsv(text: string): LocalReport {
  const rows = csvRows(text);
  if (JSON.stringify(rows.shift()) !== JSON.stringify(HEADER))
    throw new Error('Unknown CSV schema.');
  const meta = rows.shift();
  if (meta?.[0] !== 'report' || !meta[15]) throw new Error('Missing report metadata.');
  const metadata: unknown = JSON.parse(meta[15]);
  const frames = new Map<number, MetricFrame>();
  const events: NetworkEvent[] = [];
  for (const row of rows) {
    if (row.length !== HEADER.length) throw new Error('Malformed CSV row.');
    const at = Number(row[1]);
    if (!row[1] || !Number.isFinite(at)) throw new Error('Invalid sample time.');
    if (row[0] === 'event') {
      events.push({
        eventId: row[10]!,
        transferId: (metadata as { transferId: string }).transferId,
        code: row[11] as NetworkEvent['code'],
        severity: row[12] as NetworkEvent['severity'],
        observedAt: at,
        userMessage: row[13]!,
        measuredEvidence: JSON.parse(row[14]!),
      });
    } else if (row[0] === 'sample') {
      let frame = frames.get(at);
      if (!frame) {
        frame = {
          timestampMonotonic: at,
          intervalDurationMs: Number(row[2]),
          epoch: Number(row[3]),
          state: row[4]!,
          samples: [],
        };
        frames.set(at, frame);
      }
      if (
        frame.intervalDurationMs !== Number(row[2]) ||
        frame.epoch !== Number(row[3]) ||
        frame.state !== row[4]
      )
        throw new Error('Conflicting frame context.');
      frame.samples.push({
        timestampMonotonic: at,
        metricName: row[5] as MetricFrame['samples'][number]['metricName'],
        value: row[6] === '' ? null : row[7] === 'state' ? row[6]! : Number(row[6]),
        unit: row[7] as MetricFrame['samples'][number]['unit'],
        provenance: row[8] as MetricFrame['samples'][number]['provenance'],
        availabilityReason:
          row[9] === '' ? null : (row[9] as MetricFrame['samples'][number]['availabilityReason']),
      });
    } else throw new Error('Unknown CSV row type.');
  }
  return reportSchema.parse({ ...(metadata as object), samples: [...frames.values()], events });
}
export function downloadReport(report: LocalReport, format: 'json' | 'csv'): void {
  const data = format === 'json' ? exportJson(report) : exportCsv(report);
  const url = URL.createObjectURL(
    new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `meshdrop-diagnostics-${report.reportId}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
