export type LifecycleEvent =
  | 'hidden'
  | 'visible'
  | 'pagehide'
  | 'pageshow'
  | 'freeze'
  | 'resume'
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
  const resume = () => callback('resume');
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('freeze', freeze);
  document.addEventListener('resume', resume);
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('freeze', freeze);
    document.removeEventListener('resume', resume);
    for (const remove of handlers) remove();
  };
}
