import { afterEach, expect, it, vi } from 'vitest';
import { observeLifecycle } from '../../packages/platform/src/Lifecycle';

afterEach(() => vi.unstubAllGlobals());

it('a document resume following freeze reaches the lifecycle controller exactly once', () => {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  const observed: string[] = [];
  const stop = observeLifecycle((event) => observed.push(event));
  try {
    document.dispatchEvent(new Event('freeze'));
    document.dispatchEvent(new Event('resume'));
    expect(observed).toEqual(['freeze', 'resume']);
  } finally {
    stop();
  }
});

it('component cleanup removes freeze, resume, visibility and network callbacks', () => {
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  const window = new EventTarget();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const observed = vi.fn();
  const stop = observeLifecycle(observed);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(observed).toHaveBeenLastCalledWith('hidden');
  stop();
  for (const name of ['freeze', 'resume', 'visibilitychange'])
    document.dispatchEvent(new Event(name));
  for (const name of ['pagehide', 'pageshow', 'offline', 'online'])
    window.dispatchEvent(new Event(name));
  expect(observed).toHaveBeenCalledTimes(1);
});
