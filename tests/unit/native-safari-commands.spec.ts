import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error This JavaScript verification adapter is tested through its runtime interface.
import { connectNativeSafari } from '../../scripts/local-dev/cloud-safari-webdriver.mjs';
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.unstubAllGlobals());
function fixture(failLockQuery = false) {
  let locked = false,
    appState = 4;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push(path);
      if (path === '/wd/hub/session')
        return Response.json({
          value: {
            sessionId: 'a'.repeat(40),
            capabilities: { browserName: 'safari', platformName: 'iOS' },
          },
        });
      if (path.endsWith('/execute/sync'))
        return Response.json({ value: { error: 'unknown command' } }, { status: 404 });
      if (path.endsWith('/lock')) locked = true;
      if (path.endsWith('/unlock')) locked = false;
      if (path.endsWith('/is_locked')) {
        if (failLockQuery)
          return Response.json({ value: { error: 'unknown command' } }, { status: 404 });
        return Response.json({ value: locked });
      }
      if (path.endsWith('/background')) {
        expect(body.seconds).toBe(-1);
        appState = 2;
      }
      if (path.endsWith('/activate_app')) {
        expect(body.appId).toBe('com.apple.mobilesafari');
        appState = 4;
      }
      if (path.endsWith('/app_state')) return Response.json({ value: appState });
      return Response.json({ value: null });
    }),
  );
  return { calls, locked: () => locked };
}
const caps = {
  'browserstack.username': 'synthetic',
  'browserstack.accessKey': 'synthetic',
  deviceName: 'iPhone test',
  osVersion: '26',
  name: 'scoped synthetic native command test',
  build: 'local unit',
};
describe('owned native Safari OS command adapter', () => {
  it('verifies lock/unlock through the documented protocol fallback', async () => {
    const f = fixture();
    const browser = await connectNativeSafari(caps);
    expect(await browser.osInterruption('lock')).toMatchObject({ locked: true, unlocked: true });
    expect(f.calls.some((p) => p.endsWith('/appium/device/lock'))).toBe(true);
    expect(f.locked()).toBe(false);
    expect(f.calls.some((p) => p.endsWith('/execute/sync'))).toBe(false);
  });
  it('verifies actual background and foreground app states', async () => {
    const f = fixture();
    const browser = await connectNativeSafari(caps);
    expect(await browser.osInterruption('background')).toMatchObject({
      backgroundState: 2,
      foregroundState: 4,
    });
    expect(f.calls.some((p) => p.endsWith('/appium/device/activate_app'))).toBe(true);
  });
  it('attempts unlock even when lock-state verification fails', async () => {
    const f = fixture(true);
    const browser = await connectNativeSafari(caps);
    await expect(browser.osInterruption('lock')).rejects.toThrow(
      'IOS_NATIVE_SAFARI_COMMAND_FAILED',
    );
    expect(f.locked()).toBe(false);
    expect(f.calls.some((p) => p.endsWith('/execute/sync'))).toBe(false);
  });
});
