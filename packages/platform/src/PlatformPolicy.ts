import type { CapabilityResult } from './CapabilityProbe';
export const LARGE_FILE_WARNING_BYTES = 300 * 1024 ** 2;
export const UNKNOWN_SPACE_LIMIT_BYTES = 64 * 1024 ** 2;
export interface ReceivePolicy {
  allowed: boolean;
  strategy: 'opfs-checkpoint' | 'unavailable';
  exportStrategy: 'picker-or-download' | 'share-or-download';
  warnings: string[];
  requiresAcknowledgement: boolean;
}
/** Sender requirements differ from receiving/checkpoint requirements; export remains a separate action. */
export function transferSupport(capabilities: CapabilityResult, role: 'sender' | 'receiver') {
  const reasons: string[] = [];
  if (!capabilities.secureContext)
    reasons.push('Use HTTPS or loopback for a secure browser context.');
  if (!capabilities.webRtc) reasons.push('This browser could not create a WebRTC data channel.');
  if (capabilities.crypto !== 'available')
    reasons.push('Required SHA-256 and signed pairing cryptography are unavailable.');
  if (capabilities.worker !== 'available')
    reasons.push('This browser could not start the required file worker.');
  if (role === 'sender' && !capabilities.filePicker)
    reasons.push('This browser has no file-selection input.');
  if (role === 'receiver') {
    if (capabilities.opfs !== 'available')
      reasons.push('Verified browser file storage is unavailable.');
    if (capabilities.checkpointDb !== 'available')
      reasons.push('The checkpoint database could not commit and read back data.');
    if (!capabilities.exclusiveAccess)
      reasons.push('Exclusive access to saved transfer files is unavailable.');
  }
  return { supported: reasons.length === 0, reasons };
}
/** Limits are product safeguards, not measured universal browser/phone maxima. */
export function receivePolicy(
  capabilities: CapabilityResult,
  requiredBytes: number,
): ReceivePolicy {
  const warnings: string[] = [];
  const support = transferSupport(capabilities, 'receiver');
  let allowed = support.supported && Number.isSafeInteger(requiredBytes) && requiredBytes >= 0;
  if (!allowed)
    warnings.push(
      'This browser mode cannot provide verified file storage. Use a regular supported browser over HTTPS or loopback.',
    );
  warnings.push(...support.reasons);
  const free = capabilities.estimatedFreeBytes;
  if (free === null) {
    warnings.push(
      'Free browser space is unknown. This app limits a new offer to 64 MiB until a quota estimate is available.',
    );
    if (requiredBytes > UNKNOWN_SPACE_LIMIT_BYTES) allowed = false;
  } else if (free < requiredBytes + Math.max(4 * 1024 ** 2, Math.ceil(requiredBytes * 0.1))) {
    allowed = false;
    warnings.push(
      'Insufficient estimated browser space including checkpoint headroom. Free space or reduce this offer.',
    );
  }
  if (capabilities.persistentStorage !== true)
    warnings.push('Local files can be evicted. Save a separate copy after verification.');
  const large = requiredBytes >= LARGE_FILE_WARNING_BYTES;
  if (large)
    warnings.push(
      'Large-file receive and export have not been certified for every phone. Check free disk space, keep both screens open and try a smaller file first.',
    );
  if (!capabilities.savePicker)
    warnings.push(
      'Save uses the browser download or system share flow. A universal iPhone size limit or 10 GB export is not guaranteed.',
    );
  return {
    allowed,
    strategy: allowed ? 'opfs-checkpoint' : 'unavailable',
    exportStrategy: capabilities.savePicker ? 'picker-or-download' : 'share-or-download',
    warnings,
    requiresAcknowledgement: large || free === null,
  };
}
