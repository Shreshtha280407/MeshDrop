import { afterEach, expect, it, vi } from 'vitest';
import {
  HTTP_BODY_TIMEOUT_MS,
  MAX_HTTP_BODY_CHUNKS,
  readJson,
} from '../../apps/signaling/src/limits';
import { errorResponse } from '../../apps/signaling/src/errors';

afterEach(() => vi.useRealTimers());
const bodyRequest = (body: ReadableStream<Uint8Array>) =>
  new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
it('bounds chunk count including empty chunks', async () => {
  let pulls = 0;
  const request = bodyRequest(
    new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array());
      },
    }),
  );
  await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
  expect(pulls).toBeLessThanOrEqual(MAX_HTTP_BODY_CHUNKS + 2);
});
it('cancels an unfinished body after a total deadline', async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const request = bodyRequest(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const outcome = expect(readJson(request)).rejects.toMatchObject({ status: 408 });
  await vi.advanceTimersByTimeAsync(HTTP_BODY_TIMEOUT_MS);
  await outcome;
  expect(cancelled).toBe(true);
});
it('returns generic parse and unexpected errors without reflecting private input', async () => {
  const marker = 'private-capability-filename-sdp-canary';
  await expect(
    readJson(
      bodyRequest(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(marker));
            c.close();
          },
        }),
      ),
    ),
  ).rejects.toMatchObject({ message: 'Invalid JSON request.' });
  expect(await errorResponse(new Error(marker), crypto.randomUUID()).text()).not.toContain(marker);
});
