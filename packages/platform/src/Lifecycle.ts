export type LifecycleEvent =
  | 'hidden'
  | 'visible'
  | 'pagehide'
  | 'pageshow'
  | 'freeze'
  | 'offline'
  | 'online';
export function observeLifecycle(callback: (event: LifecycleEvent) => void): () => void {
  const visibility = () => callback(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
  const listeners = ['pagehide', 'pageshow', 'offline', 'online'] as const;
  const handlers = listeners.map((event) => {
    const listener = () => callback(event);
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  });
  const freeze = () => callback('freeze');
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('freeze', freeze);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('freeze', freeze);
    for (const remove of handlers) remove();
  };
}
