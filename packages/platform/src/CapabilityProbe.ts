export type ProbeState = 'available' | 'unsupported' | 'unavailable';
export interface StorageProbe {
  opfs: ProbeState;
  checkpointDb: ProbeState;
  exclusiveAccess: boolean;
}
export interface CapabilityResult extends StorageProbe {
  secureContext: boolean;
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
const unavailable = (): StorageProbe => ({
  opfs: 'unavailable',
  checkpointDb: 'unavailable',
  exclusiveAccess: false,
});
export async function probeLocalStorage(): Promise<StorageProbe> {
  if (!globalThis.isSecureContext || typeof Worker === 'undefined') return unavailable();
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./capability.worker.ts', import.meta.url), {
      type: 'module',
    });
    const done = (value: StorageProbe) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => done(unavailable()), 5000);
    worker.onmessage = (event: MessageEvent<StorageProbe>) => done(event.data);
    worker.onerror = () => done(unavailable());
    worker.postMessage('probe');
  });
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
  try {
    camera.permission = (
      await navigator.permissions.query({ name: 'camera' as PermissionName })
    ).state;
  } catch {
    /* Safari may not expose this permission query. */
  }
  let estimatedFreeBytes: number | null = null,
    persistentStorage: boolean | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (
      estimate &&
      Number.isFinite(estimate.quota) &&
      Number.isFinite(estimate.usage) &&
      estimate.quota! >= 0 &&
      estimate.usage! >= 0
    )
      estimatedFreeBytes = Math.max(0, estimate.quota! - estimate.usage!);
  } catch {
    /* Unknown space is distinct from zero. */
  }
  try {
    persistentStorage = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    /* No durability claim. */
  }
  let storage = unavailable();
  try {
    storage = await storageProbe();
  } catch {
    /* Permission/mode restrictions are an unavailable result. */
  }
  return {
    ...storage,
    secureContext,
    webRtc: secureContext && typeof RTCPeerConnection === 'function',
    savePicker:
      secureContext &&
      typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
    filePicker: input.type === 'file',
    persistentStorage,
    estimatedFreeBytes,
    camera,
    shareFiles: typeof navigator.share === 'function' && typeof navigator.canShare === 'function',
    pwaMode:
      matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
        ? 'standalone'
        : 'browser',
    serviceWorker: secureContext && 'serviceWorker' in navigator,
    backgroundRisk: 'foreground-required',
  };
}
