import type { CapabilityResult } from '@meshdrop/platform';
import type { RoomView } from '../pairing/RoomClient';
export function MobilePanel({
  capabilities,
  error,
  refresh,
  view,
}: {
  capabilities: CapabilityResult | null;
  error: string;
  refresh(): void;
  view: RoomView;
}) {
  return (
    <section
      className="demo-panel mobile-panel"
      aria-labelledby="mobile-title"
      data-testid="mobile-capabilities"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ON THIS DEVICE</p>
          <h2 id="mobile-title">Keep both devices open.</h2>
        </div>
        <span className="pill">Foreground transfers</span>
      </div>
      <p className="demo-note">
        Screen lock and app switching can suspend this page. MeshDrop pauses when it can; committed
        checkpoints are rechecked after recovery. Installing the app does not enable closed-browser
        delivery.
      </p>
      {view.lifecycleMessage && (
        <p className="status-note" role="status" data-testid="lifecycle-message">
          {view.lifecycleMessage}
        </p>
      )}
      {!capabilities && !error && <p role="status">Checking usable local storage…</p>}
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
      {capabilities && (
        <>
          <dl className="capability-list">
            <div>
              <dt>Secure WebRTC</dt>
              <dd data-testid="capability-webrtc">
                {capabilities.webRtc ? 'Available' : 'Unavailable'}
              </dd>
            </div>
            <div>
              <dt>Verified browser file storage</dt>
              <dd data-testid="capability-opfs">{capabilities.opfs}</dd>
            </div>
            <div>
              <dt>Checkpoint database</dt>
              <dd>{capabilities.checkpointDb}</dd>
            </div>
            <div>
              <dt>Exclusive file access</dt>
              <dd>{capabilities.exclusiveAccess ? 'Available' : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Estimated browser space</dt>
              <dd>
                {capabilities.estimatedFreeBytes === null
                  ? 'Unknown'
                  : `${Math.floor(capabilities.estimatedFreeBytes / 1024 ** 2).toLocaleString()} MiB`}
              </dd>
            </div>
            <div>
              <dt>Persistent storage</dt>
              <dd>
                {capabilities.persistentStorage === null
                  ? 'Unknown'
                  : capabilities.persistentStorage
                    ? 'Granted; site-data clearing still removes files'
                    : 'Not granted; files may be evicted'}
              </dd>
            </div>
            <div>
              <dt>Choose-location save</dt>
              <dd>
                {capabilities.savePicker ? 'Available' : 'Use browser download / system share'}
              </dd>
            </div>
            <div>
              <dt>File selection</dt>
              <dd>{capabilities.filePicker ? 'Available' : 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Camera</dt>
              <dd>
                {capabilities.camera.supported
                  ? `Available API; permission ${capabilities.camera.permission}`
                  : 'Unavailable; paste an invitation'}
              </dd>
            </div>
            <div>
              <dt>App mode</dt>
              <dd data-testid="pwa-mode">{capabilities.pwaMode}</dd>
            </div>
          </dl>
          <p className="muted">
            A successful small storage probe and quota estimate do not certify a maximum file size.
            Offers from 300 MiB show an extra warning. Without a quota estimate, this app permits at
            most 64 MiB per new offer. Save/export may need additional device space.
          </p>
        </>
      )}
      <button className="secondary" onClick={refresh}>
        Recheck device capabilities
      </button>
    </section>
  );
}
