import type { CapacityResult } from './ReceiverStore';
export async function estimateCapacity(requiredBytes: number): Promise<CapacityResult> {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0)
    throw new Error('Invalid storage size.');
  if (!navigator.storage?.getDirectory || typeof indexedDB === 'undefined' || !navigator.locks)
    return {
      available: false,
      estimatedFreeBytes: null,
      persistent: false,
      warnings: ['This browser cannot provide checkpoint storage and exclusive access.'],
    };
  const estimate: StorageEstimate = (await navigator.storage.estimate?.().catch(() => ({}))) ?? {};
  const free =
    !Number.isFinite(estimate.quota) ||
    !Number.isFinite(estimate.usage) ||
    estimate.quota! < 0 ||
    estimate.usage! < 0
      ? null
      : Math.max(0, estimate.quota! - estimate.usage!);
  const persistent = (await navigator.storage.persisted?.().catch(() => false)) ?? false;
  const warnings: string[] = [];
  if (!persistent) warnings.push('Browser storage can be evicted. Save important files elsewhere.');
  if (free === null) warnings.push('Available browser storage could not be estimated.');
  if (requiredBytes >= 300 * 1024 ** 2)
    warnings.push('Large files need free local disk space. Keep the browser in the foreground.');
  const available =
    free === null
      ? requiredBytes <= 64 * 1024 ** 2
      : free >= requiredBytes + Math.max(4 * 1024 ** 2, Math.ceil(requiredBytes * 0.1));
  if (free === null && !available)
    warnings.push('Offers above 64 MiB require a usable quota estimate in this app.');
  if (!available && free !== null)
    warnings.push(
      'Not enough estimated browser storage. Clear saved transfers or free disk space before accepting.',
    );
  return { available, estimatedFreeBytes: free, persistent, warnings };
}
export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.().catch(() => false)) ?? false;
}
