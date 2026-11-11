import { probeRequiredCrypto } from './CryptoProbe';

export type ProbeState = 'available' | 'unsupported' | 'unavailable';
export interface StorageProbe {
  worker: ProbeState;
  opfs: ProbeState;
  checkpointDb: ProbeState;
  exclusiveAccess: boolean;
}
export interface CapabilityResult extends StorageProbe {
  secureContext: boolean;
  crypto: ProbeState;
  webRtc: boolean;
  savePicker: boolean;
  filePicker: boolean;
  persistentStorage: boolean | null;
  estimatedFreeBytes: number | null;
  camera: { supported: boolean; permission: 'granted' | 'denied' | 'prompt' | 'unknown' };
  shareFiles: boolean;
  pwaMode: 'browser' | 'standalone';
  serviceWorker: boolean;
  backgroundRisk: 'foreground-required';
}
const unavailable = (worker: ProbeState = 'unavailable'): StorageProbe => ({
  worker,
  opfs: 'unavailable',
  checkpointDb: 'unavailable',
  exclusiveAccess: false,
});
export async function probeLocalStorage(): Promise<StorageProbe> {
  if (!globalThis.isSecureContext || typeof Worker !== 'function')
    return unavailable('unsupported');
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const done = (value: StorageProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => done(unavailable()), 5000);
    try {
      worker = new Worker(new URL('./capability.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<unknown>) =>
        done(isStorageProbe(event.data) ? event.data : unavailable());
      worker.onerror = () => done(unavailable());
      worker.onmessageerror = () => done(unavailable());
      worker.postMessage('probe');
    } catch {
      done(unavailable());
    }
  });
}
function isStorageProbe(value: unknown): value is StorageProbe {
  if (typeof value !== 'object' || value === null) return false;
  const probe = value as Record<string, unknown>;
  return (
    ['worker', 'opfs', 'checkpointDb'].every((key) =>
      ['available', 'unsupported', 'unavailable'].includes(probe[key] as string),
    ) && typeof probe.exclusiveAccess === 'boolean'
  );
}
async function bounded<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), 5000);
    void Promise.resolve()
      .then(operation)
      .then(resolve, () => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}
function probeWebRtc(): boolean {
  let peer: RTCPeerConnection | undefined;
  try {
    peer = new RTCPeerConnection({ iceServers: [] });
    const channel = peer.createDataChannel('meshdrop-capability');
    channel.close();
    peer.close();
    return true;
  } catch {
    try {
      peer?.close();
    } catch {
      /* The failed disposable probe owns no application connection. */
    }
    return false;
  }
}
/** Active bounded storage check; camera and export APIs are detected without asking permission. */
export async function probeCapabilities(
  storageProbe = probeLocalStorage,
): Promise<CapabilityResult> {
  const secureContext = globalThis.isSecureContext === true;
  const input = document.createElement('input');
  input.type = 'file';
  const camera: CapabilityResult['camera'] = {
    supported: secureContext && typeof navigator.mediaDevices?.getUserMedia === 'function',
    permission: 'unknown',
  };
  const permission = bounded(
    async () => {
      const value = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state;
      return ['granted', 'denied', 'prompt'].includes(value) ? value : 'unknown';
    },
    'unknown' as CapabilityResult['camera']['permission'],
  );
  const quota = bounded(
    async () => {
      const estimate = await navigator.storage?.estimate?.();
      if (
        estimate &&
        Number.isFinite(estimate.quota) &&
        Number.isFinite(estimate.usage) &&
        estimate.quota! >= 0 &&
        estimate.usage! >= 0
      )
        return Math.max(0, estimate.quota! - estimate.usage!);
      return null;
    },
    null as number | null,
  );
  const persistence = bounded(
    async () => {
      const value = await navigator.storage?.persisted?.();
      return typeof value === 'boolean' ? value : null;
    },
    null as boolean | null,
  );
  const [storageResult, cryptoState, permissionState, freeBytes, persistent] = await Promise.all([
    bounded(storageProbe, unavailable()),
    secureContext
      ? bounded(probeRequiredCrypto, 'unavailable' as ProbeState)
      : Promise.resolve('unsupported' as const),
    permission,
    quota,
    persistence,
  ]);
  const storage = isStorageProbe(storageResult) ? storageResult : unavailable();
  camera.permission = permissionState;
  let shareFiles = false;
  try {
    shareFiles =
      secureContext &&
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({
        files: [new File([new Uint8Array([71])], 'meshdrop-probe.txt', { type: 'text/plain' })],
      }) === true;
  } catch {
    /* A share symbol is not usable file sharing; no share dialog is opened. */
  }
  let standalone = false;
  try {
    standalone =
      (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    /* No install claim from an unavailable browser signal. */
  }
  return {
    ...storage,
    secureContext,
    crypto: cryptoState,
    webRtc: secureContext && probeWebRtc(),
    savePicker:
      secureContext &&
      typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    filePicker: input.type === 'file',
    persistentStorage: persistent,
    estimatedFreeBytes: freeBytes,
    camera,
    shareFiles,
    pwaMode: standalone ? 'standalone' : 'browser',
    serviceWorker: secureContext && 'serviceWorker' in navigator,
    backgroundRisk: 'foreground-required',
  };
}
