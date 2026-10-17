import type { DeviceCapabilities } from '@meshdrop/shared-types';
export * from './CapabilityProbe';
export * from './PlatformPolicy';
export * from './Lifecycle';

/** API presence only. This does not assert permission, quota, or durability. */
export function detectDeviceCapabilities(): DeviceCapabilities {
  return {
    secureContext: globalThis.isSecureContext === true,
    webRtc: typeof RTCPeerConnection !== 'undefined',
    opfsApi:
      typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
    indexedDbApi: typeof indexedDB !== 'undefined',
    savePickerApi: 'showSaveFilePicker' in globalThis,
    storageEstimateApi:
      typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function',
  };
}
