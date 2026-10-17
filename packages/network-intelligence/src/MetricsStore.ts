import {
  boundedReport,
  reportSchema,
  MAX_REPORTS,
  MAX_REPORT_BYTES,
  MAX_TOTAL_BYTES,
} from './Contracts';
import type { LocalReport } from './Contracts';
export const METRICS_DATABASE = 'meshdrop-diagnostics-v1';
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function parseStored(value: unknown, now: number): LocalReport | null {
  try {
    const report = reportSchema.parse(value);
    return size(report) <= MAX_REPORT_BYTES && Date.parse(report.expiresAt) > now ? report : null;
  } catch {
    return null;
  }
}
function retained(reports: LocalReport[]): LocalReport[] {
  const keep: LocalReport[] = [];
  let bytes = 0;
  for (const report of reports) {
    const length = size(report);
    if (keep.length < MAX_REPORTS && bytes + length <= MAX_TOTAL_BYTES) {
      keep.push(report);
      bytes += length;
    }
  }
  return keep;
}
export class MetricsStore {
  private async open(): Promise<IDBDatabase> {
    const request = indexedDB.open(METRICS_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('reports', { keyPath: 'reportId' });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.onversionchange = () => db.close();
    return db;
  }
  async put(input: LocalReport): Promise<void> {
    const report = boundedReport(input),
      now = Date.now(),
      db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('reports', 'readwrite'),
          store = tx.objectStore('reports');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Metrics transaction aborted.'));
        tx.onerror = () => {};
        const reading = store.getAll();
        reading.onsuccess = () => {
          try {
            const raw = reading.result as unknown[];
            const valid = raw
              .map((value) => parseStored(value, now))
              .filter(
                (value): value is LocalReport =>
                  value !== null && value.reportId !== report.reportId,
              )
              .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            const keep = retained([report, ...valid]);
            const ids = new Set(keep.map((value) => value.reportId));
            for (const value of raw) {
              const key = (value as { reportId: IDBValidKey }).reportId;
              if (!ids.has(key as string)) store.delete(key);
            }
            store.put(report);
          } catch {
            tx.abort();
          }
        };
      });
    } finally {
      db.close();
    }
  }
  async list(): Promise<LocalReport[]> {
    const db = await this.open();
    try {
      return await new Promise<LocalReport[]>((resolve, reject) => {
        const tx = db.transaction('reports', 'readwrite'),
          store = tx.objectStore('reports');
        let reports: LocalReport[] = [];
        tx.oncomplete = () => resolve(reports);
        tx.onabort = () => reject(tx.error ?? new Error('Metrics transaction aborted.'));
        tx.onerror = () => {};
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const now = Date.now(),
              raw = request.result as unknown[];
            reports = retained(
              raw
                .map((value) => parseStored(value, now))
                .filter((value): value is LocalReport => value !== null)
                .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
            );
            const ids = new Set(reports.map((report) => report.reportId));
            for (const value of raw) {
              const key = (value as { reportId: IDBValidKey }).reportId;
              if (!ids.has(key as string)) store.delete(key);
            }
          } catch {
            tx.abort();
          }
        };
      });
    } finally {
      db.close();
    }
  }
  async delete(reportId: string): Promise<void> {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('reports', 'readwrite');
        tx.objectStore('reports').delete(reportId);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => {};
      });
    } finally {
      db.close();
    }
  }
}
