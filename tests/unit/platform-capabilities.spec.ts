import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCapabilities, probeLocalStorage } from '../../packages/platform/src/CapabilityProbe';
import { probeRequiredCrypto } from '../../packages/platform/src/CryptoProbe';
import { receivePolicy, transferSupport } from '../../packages/platform/src/PlatformPolicy';
import { startFileDownload } from '../../packages/storage/src/SaveAdapters';

const originalCrypto = globalThis.crypto;
const usableStorage = {
  worker: 'available' as const,
  opfs: 'available' as const,
  checkpointDb: 'available' as const,
  exclusiveAccess: true,
};

function mainThread() {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', originalCrypto);
  vi.stubGlobal('document', { createElement: () => ({ type: 'file' }) });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('navigator', {
    permissions: { query: async () => ({ state: 'prompt' }) },
    storage: {
      estimate: async () => ({ quota: 1024 ** 3, usage: 0 }),
      persisted: async () => false,
    },
    canShare: () => false,
    share: async () => {},
  });
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      createDataChannel() {
        return { close() {} };
      }
      close() {}
    },
  );
}

async function workerProbe(
  options: {
    closeFails?: boolean;
    storedValue?: unknown;
    fault?: 'short-write' | 'bad-read' | 'flush' | 'remove' | 'commit' | 'delete' | 'lock';
  } = {},
) {
  const close = vi.fn(async () => {
    if (options.closeFails) throw new Error('Synthetic close failure');
  });
  const readback = vi.fn();
  const removeEntry = vi.fn(async () => {
    if (options.fault === 'remove') throw Error('Cleanup denied');
  });
  vi.stubGlobal('crypto', originalCrypto);
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createSyncAccessHandle: async () => ({
            write: () => (options.fault === 'short-write' ? 0 : 1),
            read: (bytes: Uint8Array) => {
              bytes[0] = options.fault === 'bad-read' ? 72 : 71;
              return 1;
            },
            async flush() {
              if (options.fault === 'flush') throw Error('Flush failed');
            },
            close,
          }),
        }),
        removeEntry,
      }),
    },
    locks: {
      request: async (_name: string, _options: unknown, callback: (lock: object) => void) =>
        callback(options.fault === 'lock' ? null! : {}),
    },
  });
  const database = {
    createObjectStore() {},
    close() {},
    transaction() {
      const tx = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        objectStore: () => ({
          put() {
            queueMicrotask(() => (options.fault === 'commit' ? tx.onabort?.() : tx.oncomplete?.()));
          },
          get() {
            readback();
            const request = {
              result: options.storedValue ?? 71,
              onsuccess: undefined as (() => void) | undefined,
              onerror: undefined as (() => void) | undefined,
            };
            queueMicrotask(() => {
              request.onsuccess?.();
              tx.oncomplete?.();
            });
            return request;
          },
        }),
      };
      return tx;
    },
  };
  vi.stubGlobal('indexedDB', {
    open() {
      const request = {
        result: database,
        onupgradeneeded: undefined as (() => void) | undefined,
        onsuccess: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase() {
      const request = { onsuccess: undefined as (() => void) | undefined };
      queueMicrotask(() => (options.fault === 'delete' ? undefined : request.onsuccess?.()));
      if (options.fault === 'delete')
        return {
          set onsuccess(_value: unknown) {},
          set onerror(value: () => void) {
            queueMicrotask(value);
          },
        };
      return request;
    },
  });
  const scope = {
    onmessage: undefined as (() => Promise<void>) | undefined,
    postMessage: vi.fn(),
  };
  vi.stubGlobal('self', scope);
  vi.resetModules();
  await import('../../packages/platform/src/capability.worker');
  await scope.onmessage!();
  return { result: scope.postMessage.mock.calls[0]![0], close, readback, removeEntry };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Safari, Windows and Chromium capability boundaries (deterministic fixtures)', () => {
  it('proves one-byte storage I/O and awaits Safari-style asynchronous flush/close', async () => {
    const probe = await workerProbe();
    expect(probe.result).toEqual(usableStorage);
    expect(probe.close).toHaveBeenCalledOnce();
    expect(probe.readback).toHaveBeenCalledOnce();
  });
  it.each(['short-write', 'bad-read', 'flush', 'remove'] as const)(
    'rejects OPFS %s failures',
    async (fault) => {
      expect((await workerProbe({ fault })).result.opfs).toBe('unavailable');
    },
  );
  it.each(['commit', 'delete'] as const)('rejects checkpoint %s failures', async (fault) => {
    expect((await workerProbe({ fault })).result.checkpointDb).toBe('unavailable');
  });
  it('cannot claim recovery without exclusive storage ownership', async () => {
    expect((await workerProbe({ fault: 'lock' })).result.exclusiveAccess).toBe(false);
  });
  it('requires actual protocol crypto operations, not method names', async () => {
    vi.stubGlobal('crypto', originalCrypto);
    expect(await probeRequiredCrypto()).toBe('available');
    vi.stubGlobal('crypto', {
      randomUUID: () => originalCrypto.randomUUID(),
      getRandomValues: (a: Uint8Array) => originalCrypto.getRandomValues(a),
      subtle: {
        digest: async () => new Uint8Array(32),
        generateKey() {},
        exportKey() {},
        importKey() {},
        sign() {},
        verify() {},
      },
    });
    expect(await probeRequiredCrypto()).toBe('unavailable');
  });
  it('rejects unavailable signing algorithms even with functional SHA-256', async () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => originalCrypto.randomUUID(),
      getRandomValues: (a: Uint8Array) => originalCrypto.getRandomValues(a),
      subtle: {
        digest: originalCrypto.subtle.digest.bind(originalCrypto.subtle),
        generateKey: async () => {
          throw Error('NotSupportedError');
        },
        exportKey() {},
        importKey() {},
        sign() {},
        verify() {},
      },
    });
    expect(await probeRequiredCrypto()).toBe('unavailable');
  });
  it('allows sending without claiming receiver checkpoint support', async () => {
    mainThread();
    const result = await probeCapabilities(async () => ({
      ...usableStorage,
      opfs: 'unsupported',
      checkpointDb: 'unsupported',
      exclusiveAccess: false,
    }));
    expect(transferSupport(result, 'sender').supported).toBe(true);
    expect(transferSupport(result, 'receiver').supported).toBe(false);
  });
  it('handles iPad standalone mode and missing permission/quota APIs without permission prompts', async () => {
    mainThread();
    vi.stubGlobal('navigator', { standalone: true });
    const result = await probeCapabilities(async () => usableStorage);
    expect(result.pwaMode).toBe('standalone');
    expect(result.camera.permission).toBe('unknown');
    expect(result.estimatedFreeBytes).toBeNull();
    expect(result.persistentStorage).toBeNull();
    expect(result.savePicker).toBe(false);
    expect(result.shareFiles).toBe(false);
    expect(result.crypto).toBe('available');
  });
  it('exposes Windows picker presence without opening a privileged dialog', async () => {
    mainThread();
    const picker = vi.fn();
    vi.stubGlobal('showSaveFilePicker', picker);
    const result = await probeCapabilities(async () => usableStorage);
    expect(result.savePicker).toBe(true);
    expect(picker).not.toHaveBeenCalled();
  });
  it('keeps malformed quota and persistence observations unknown', async () => {
    mainThread();
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: NaN, usage: -1 }), persisted: async () => 'yes' },
    });
    const result = await probeCapabilities(async () => usableStorage);
    expect(result.estimatedFreeBytes).toBeNull();
    expect(result.persistentStorage).toBeNull();
  });
  it('blocks both roles in insecure contexts', async () => {
    mainThread();
    vi.stubGlobal('isSecureContext', false);
    const result = await probeCapabilities(async () => usableStorage);
    expect(transferSupport(result, 'sender').supported).toBe(false);
    expect(transferSupport(result, 'receiver').supported).toBe(false);
    expect(result.crypto).toBe('unsupported');
  });
  it.each(['constructor', 'postMessage', 'malformed', 'error'] as const)(
    'settles worker %s failures and cleans up',
    async (fault) => {
      mainThread();
      const terminate = vi.fn();
      vi.stubGlobal(
        'Worker',
        class {
          onmessage?: (e: { data: unknown }) => void;
          onerror?: () => void;
          constructor() {
            if (fault === 'constructor') throw Error('Blocked');
          }
          terminate = terminate;
          postMessage() {
            if (fault === 'postMessage') throw Error('Stopped');
            queueMicrotask(() =>
              fault === 'malformed'
                ? this.onmessage?.({ data: { opfs: 'available' } })
                : this.onerror?.(),
            );
          }
        },
      );
      expect((await probeLocalStorage()).worker).toBe('unavailable');
      expect(terminate).toHaveBeenCalledTimes(fault === 'constructor' ? 0 : 1);
    },
  );
  it('times out an unresponsive worker without hanging the application', async () => {
    mainThread();
    vi.useFakeTimers();
    const terminate = vi.fn();
    vi.stubGlobal(
      'Worker',
      class {
        terminate = terminate;
        postMessage() {}
      },
    );
    const pending = probeLocalStorage();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).opfs).toBe('unavailable');
    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe('active cross-platform capability checks', () => {
  it('does not report usable OPFS when the browser cannot close the written file', async () => {
    const probe = await workerProbe({ closeFails: true });
    expect(probe.result.opfs).toBe('unavailable');
    expect(probe.close).toHaveBeenCalledOnce();
    expect(probe.removeEntry).toHaveBeenCalledOnce();
  });

  it('does not certify a checkpoint database without exact committed readback', async () => {
    const probe = await workerProbe({ storedValue: 'damaged' });
    expect(probe.result.checkpointDb).toBe('unavailable');
    expect(probe.readback).toHaveBeenCalledOnce();
  });

  it('rejects receive support when required Web Crypto is missing', async () => {
    mainThread();
    vi.stubGlobal('crypto', { randomUUID: originalCrypto.randomUUID.bind(originalCrypto) });
    const result = await probeCapabilities(async () => usableStorage);
    expect(receivePolicy(result, 1).allowed).toBe(false);
  });

  it('does not infer WebRTC usability from a constructor symbol that throws', async () => {
    mainThread();
    vi.stubGlobal('RTCPeerConnection', function () {
      throw new DOMException('Browser policy denied construction', 'NotAllowedError');
    });
    const result = await probeCapabilities(async () => usableStorage);
    expect(result.webRtc).toBe(false);
  });

  it('does not claim file sharing when canShare rejects an actual probe file', async () => {
    mainThread();
    const result = await probeCapabilities(async () => usableStorage);
    expect(result.shareFiles).toBe(false);
  });

  it('releases its anchor and object URL when a browser refuses the download action', () => {
    const remove = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:owned-capability-test',
      revokeObjectURL,
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        click() {
          throw new DOMException('Download denied', 'NotAllowedError');
        },
        remove,
      }),
      body: { append() {} },
    });
    expect(() => startFileDownload(new File(['bytes'], 'original.bin'), 'saved.bin')).toThrow();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:owned-capability-test');
  });
});
