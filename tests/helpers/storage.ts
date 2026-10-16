import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
declare global {
  interface Window {
    storageHarness: {
      request(operation: string, payload: unknown): Promise<unknown>;
      stop(): void;
      stage: string;
      completed: number;
      lastError: string;
    };
  }
}
export async function startStoreHarness(page: Page): Promise<void> {
  // tsx preserves callback names with this helper; Playwright's own TS loader does not need it.
  // Install only in the isolated test page before serializing nested harness callbacks.
  await page.evaluate('globalThis.__name ??= (value) => value');
  const url = `/@fs${fileURLToPath(new URL('../storage/store-harness.worker.ts', import.meta.url))}`;
  await page.evaluate((url) => {
    const worker = new Worker(url, { type: 'module' });
    let next = 0;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    const harness = {
      stage: '',
      completed: 0,
      lastError: '',
      request: (operation: string, payload: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, operation, payload });
        }),
      stop: () => {
        worker.terminate();
        for (const p of pending.values()) p.reject(new Error('Terminated test worker.'));
        pending.clear();
      },
    };
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        event?: string;
        stage?: string;
        ok: boolean;
        result: unknown;
        error?: string;
      }>,
    ) => {
      if (event.data.event === 'stage') {
        harness.stage = event.data.stage!;
        return;
      }
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      if (event.data.ok) {
        harness.completed++;
        p.resolve(event.data.result);
      } else {
        harness.lastError = event.data.error ?? 'Error';
        p.reject(new Error(harness.lastError));
      }
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error('Test worker failed.'));
      pending.clear();
    };
    window.storageHarness = harness;
  }, url);
}
export async function storeRequest<T = unknown>(
  page: Page,
  operation: string,
  payload: unknown = null,
): Promise<T> {
  return page.evaluate(
    ({ operation, payload }) => window.storageHarness.request(operation, payload),
    { operation, payload },
  ) as Promise<T>;
}
