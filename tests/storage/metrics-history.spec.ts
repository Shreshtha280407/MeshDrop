import { expect, test } from '@playwright/test';
import { diagnosticsUrl, reports } from '../helpers/diagnostics';
import type * as Diagnostics from '../../packages/network-intelligence/src';
test.use({ trace: 'off', video: 'off' });
test('local metrics history enforces count, expiry, strict privacy shape and explicit deletion', async ({
  page,
}) => {
  await page.goto('/foundation');
  const result = await page.evaluate(async (url) => {
    const { MetricsStore, METRICS_DATABASE } = (await import(url)) as typeof Diagnostics;
    const store = new MetricsStore();
    const now = Date.now(),
      transferId = crypto.randomUUID();
    const make = (index: number) => ({
      schemaVersion: 1 as const,
      reportId: crypto.randomUUID(),
      transferId,
      role: 'owner' as const,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now + index).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      durationMs: 0,
      status: 'complete' as const,
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
    });
    for (let index = 0; index < 12; index++) await store.put(make(index));
    const before = await store.list();
    let rejected = false;
    try {
      await store.put({ ...make(13), filename: 'private.txt' } as ReturnType<typeof make>);
    } catch {
      rejected = true;
    }
    const open = indexedDB.open(METRICS_DATABASE, 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite'),
        raw = tx.objectStore('reports');
      raw.put({ ...make(14), expiresAt: new Date(now - 1).toISOString() });
      raw.put({ ...make(15), filename: 'unsafe.txt' });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const cleaned = await store.list();
    const remaining = await new Promise<number>((resolve) => {
      const r = db.transaction('reports').objectStore('reports').count();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    await store.delete(cleaned[0]!.reportId);
    return { countBefore: before.length, countCleaned: cleaned.length, remaining, rejected };
  }, diagnosticsUrl);
  expect(result).toEqual({ countBefore: 10, countCleaned: 10, remaining: 10, rejected: true });
  await page.reload();
  expect(await reports(page)).toHaveLength(9);
});
test('aggregate logical JSON byte cap is enforced on existing history and subsequent writes', async ({
  page,
}) => {
  await page.goto('/foundation');
  const result = await page.evaluate(async (url) => {
    const {
      MetricsStore,
      METRICS_DATABASE,
      DEFINITIONS,
      measurement,
      MAX_TOTAL_BYTES,
      MAX_REPORT_BYTES,
      reportSchema,
    } = (await import(url)) as typeof Diagnostics;
    const now = Date.now(),
      transferId = crypto.randomUUID();
    const base = {
      schemaVersion: 1 as const,
      reportId: crypto.randomUUID(),
      transferId,
      role: 'receiver' as const,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      durationMs: 240000,
      status: 'complete' as const,
      summary: {
        newlyConfirmedBytes: 0,
        reusedBytes: 0,
        attemptPayloadBytes: 0,
        confirmedBytes: 0,
        recoveryDurationMs: null,
      },
      samples: [] as Diagnostics.MetricFrame[],
      events: [],
      droppedFrames: 0,
      droppedEvents: 0,
    };
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    for (let index = 0; index < 240; index++) {
      const at = index * 1000;
      base.samples.push({
        timestampMonotonic: at,
        intervalDurationMs: 1000,
        epoch: 1,
        state: 'active',
        samples: (Object.keys(DEFINITIONS) as (keyof typeof DEFINITIONS)[]).map((name) =>
          measurement(
            name,
            name === 'connection-path' ? 'direct' : name === 'candidate-state' ? 'succeeded' : 1,
            at,
          ),
        ),
      });
      if (bytes(base) > 490000) {
        base.samples.pop();
        break;
      }
    }
    reportSchema.parse(base);
    const store = new MetricsStore();
    await store.put(base);
    const open = indexedDB.open(METRICS_DATABASE, 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    // Seed an over-cap database to verify cleanup when opening history without another transfer.
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('reports', 'readwrite');
      for (let i = 1; i < 12; i++)
        tx.objectStore('reports').put({
          ...base,
          reportId: crypto.randomUUID(),
          updatedAt: new Date(now + i).toISOString(),
        });
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const cleaned = await store.list();
    const rowCount = await new Promise<number>((resolve) => {
      const r = db.transaction('reports').objectStore('reports').count();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    await store.put({ ...base, reportId: crypto.randomUUID() });
    const after = await store.list();
    return {
      singleBytes: bytes(base),
      singleCap: MAX_REPORT_BYTES,
      totalCap: MAX_TOTAL_BYTES,
      cleanedCount: cleaned.length,
      rowCount,
      cleanedBytes: cleaned.reduce((sum, report) => sum + bytes(report), 0),
      afterCount: after.length,
      afterBytes: after.reduce((sum, report) => sum + bytes(report), 0),
    };
  }, diagnosticsUrl);
  expect(result.singleBytes).toBeGreaterThan(450000);
  expect(result.singleBytes).toBeLessThanOrEqual(result.singleCap);
  expect(result.cleanedCount).toBeLessThan(10);
  expect(result.rowCount).toBe(result.cleanedCount);
  expect(result.cleanedBytes).toBeLessThanOrEqual(result.totalCap);
  expect(result.afterCount).toBeLessThan(10);
  expect(result.afterBytes).toBeLessThanOrEqual(result.totalCap);
});
