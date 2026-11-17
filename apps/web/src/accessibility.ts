import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Restore context only when a focused control disappears; never steal existing focus. */
export function useFocusRecovery(scope: RefObject<HTMLElement | null>) {
  const previous = useRef<{ element: HTMLElement; targetId: string } | null>(null);
  useEffect(() => {
    const remember = () => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return;
      if (!scope.current?.contains(element)) {
        previous.current = null;
        return;
      }
      const section = element.closest('section') ?? scope.current;
      const target = section.querySelector<HTMLElement>('[data-focus-target]');
      previous.current = target ? { element, targetId: target.id } : null;
    };
    document.addEventListener('focusin', remember);
    remember();
    return () => document.removeEventListener('focusin', remember);
  }, [scope]);
  useLayoutEffect(() => {
    const last = previous.current;
    if (!last || document.activeElement !== document.body) return;
    if (last.element.isConnected && !last.element.matches(':disabled')) return;
    const target = document.getElementById(last.targetId);
    if (target && scope.current?.contains(target) && !target.matches(':disabled')) target.focus();
  });
}

export function readableBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

/** State changes only: byte counters must not become a constantly speaking live region. */
export function transferAnnouncement(
  state: string | null,
  storageFull: boolean,
  localPaused: boolean,
  remotePaused: boolean,
): string {
  if (storageFull)
    return 'Storage is full. Committed blocks are retained. Free space, then retry storage.';
  if (state === 'active' || state === 'paused')
    return localPaused || remotePaused || state === 'paused'
      ? 'Transfer paused. Confirmed bytes are retained. Both devices must be ready to resume.'
      : 'Transfer active. Progress counts only bytes confirmed in receiver storage.';
  const messages: Record<string, string> = {
    preparing: 'Preparing selected files. You can cancel while preparation runs.',
    negotiating: 'File offer ready. The receiver must choose whether to accept.',
    verifying:
      'Verifying stored file hashes and the final receipt. Completion is not yet confirmed.',
    complete: 'Transfer verified and stored. Save a separate copy before clearing browser data.',
    cancelled:
      'Transfer cancelled. It cannot resume or become complete. Clear transfer to remove its local state.',
    failed:
      'Transfer could not finish. Review the error and recheck any saved blocks before recovery.',
    reconnecting:
      'Connection interrupted. Saved blocks must be rechecked and a fresh pairing confirmed before resuming.',
  };
  return state
    ? (messages[state] ?? 'Transfer state changed.')
    : 'No active transfer. Pair both devices to offer files.';
}
