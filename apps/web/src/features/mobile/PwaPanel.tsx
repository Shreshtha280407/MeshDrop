import { useEffect, useRef, useState } from 'react';
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
export function PwaPanel({ roomOpen }: { roomOpen: boolean }) {
  const install = useRef<InstallEvent | null>(null);
  const [installReady, setInstallReady] = useState(false);
  const [status, setStatus] = useState(
    import.meta.env.PROD
      ? 'Preparing offline shell…'
      : 'Install and offline shell are enabled in a production build.',
  );
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [offline, setOffline] = useState(navigator.onLine === false);
  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      install.current = event as InstallEvent;
      setInstallReady(true);
    };
    const installed = () => {
      install.current = null;
      setInstallReady(false);
      setStatus('App installation reported. Both peers must still stay open and connected.');
    };
    const online = () => setOffline(navigator.onLine === false);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installed);
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    let current = true;
    if (import.meta.env.PROD && 'serviceWorker' in navigator && globalThis.isSecureContext) {
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then(async (registration) => {
          if (!current) return;
          if (registration.waiting) setWaiting(registration.waiting);
          registration.addEventListener('updatefound', () => {
            const worker = registration.installing;
            worker?.addEventListener('statechange', () => {
              if (!current) return;
              if (worker.state === 'installed') {
                if (registration.waiting && navigator.serviceWorker.controller)
                  setWaiting(registration.waiting);
                else
                  setStatus(
                    'Static app shell cached. Transfers still require active peers and connectivity.',
                  );
              }
            });
          });
          await navigator.serviceWorker.ready;
          if (current)
            setStatus(
              'Static app shell cached. Transfers still require active peers and connectivity.',
            );
        })
        .catch(() => {
          if (current)
            setStatus(
              'Offline shell is unavailable in this browser mode. Online file transfer can still work.',
            );
        });
    } else if (import.meta.env.PROD) setStatus('This browser mode cannot cache an offline shell.');
    return () => {
      current = false;
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
    };
  }, []);
  return (
    <section className="demo-panel pwa-panel" aria-labelledby="pwa-title" data-testid="pwa-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">APP SHELL</p>
          <h2 id="pwa-title">A home-screen shortcut.</h2>
        </div>
        <span className="pill">{offline ? 'Offline' : 'Browser online'}</span>
      </div>
      <p role="status" data-testid="offline-shell-status">
        {status}
      </p>
      {offline && (
        <p className="status-note">
          Offline shell only. New pairing and file delivery need connectivity. Saved files can be
          rechecked and exported if this browser retained them.
        </p>
      )}
      {installReady ? (
        <button
          className="secondary"
          onClick={() => {
            const event = install.current;
            if (!event) return;
            void event
              .prompt()
              .then(() => event.userChoice)
              .then((choice) =>
                setStatus(
                  choice.outcome === 'accepted'
                    ? 'Install requested. Check the system home screen.'
                    : 'Install dismissed. You can keep using the browser.',
                ),
              )
              .catch(() =>
                setStatus('Use your browser menu to install or add to the home screen.'),
              );
            install.current = null;
            setInstallReady(false);
          }}
        >
          Install MeshDrop
        </button>
      ) : (
        <p className="muted">
          Android: browser menu → Install app / Add to Home screen. iPhone: Safari Share → Add to
          Home Screen. Menu availability depends on the browser. Installation does not guarantee
          background delivery or file retention.
        </p>
      )}
      {waiting && (
        <>
          <p className="muted">
            An updated shell is ready. Finish this room and close other MeshDrop transfer tabs
            before updating. Reloading loses in-memory room access.
          </p>
          <button
            className="secondary"
            disabled={roomOpen}
            onClick={() => {
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => location.reload(),
                { once: true },
              );
              waiting.postMessage('ACTIVATE_SHELL_UPDATE');
            }}
          >
            Apply app update
          </button>
        </>
      )}
    </section>
  );
}
