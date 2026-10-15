import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_FRAME_BYTES, PROTOCOL_VERSION } from '@meshdrop/protocol';
import {
  INITIAL_DEMO,
  applyDemoRoomMessage,
  demoRoomMessage,
  runDemoLifecycle,
} from '@meshdrop/protocol/demo';
import { detectDeviceCapabilities } from '@meshdrop/platform';
import './style.css';

function App() {
  const [snapshot, setSnapshot] = useState(INITIAL_DEMO);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [error, setError] = useState('');
  const capabilities = detectDeviceCapabilities();
  function dispatch(type: 'PEER_PENDING' | 'PEER_APPROVED' | 'ROOM_CLOSED') {
    try {
      const raw = demoRoomMessage(type);
      const next = applyDemoRoomMessage(snapshot, raw);
      setSnapshot(next);
      setHistory((items) => [...items, `${type} → room ${next.room}`]);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Event rejected.');
    }
  }
  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="MeshDrop home">
          <img src="/icon.svg" alt="" />
          MeshDrop<span className="version">v{PROTOCOL_VERSION}</span>
        </a>
        <span className="phase-label">
          <i />
          Foundation / Phase 0
        </span>
      </header>
      <main>
        <section className="intro">
          <p className="eyebrow">A DIRECT CONNECTION. A SMALLER FOOTPRINT.</p>
          <h1>
            Your files.
            <br />
            Between your devices.
          </h1>
          <p className="lede">
            Private sharing starts with a clear boundary: devices carry the files. The cloud only
            coordinates the connection.
          </p>
          <div className="principles">
            <span>Account-free by design</span>
            <span>Local storage</span>
            <span>WebRTC transport</span>
          </div>
        </section>
        <aside className="connection-map" aria-label="Planned architecture">
          <div className="device">
            <span>↗</span>Your device<small>Sender</small>
          </div>
          <div className="connection-line">
            <span>ENCRYPTED DATA CHANNEL</span>
            <div />
            <small>Planned in Phase 2</small>
          </div>
          <div className="device">
            <span>↙</span>Other device<small>Receiver</small>
          </div>
          <p>Cloudflare coordinates. File bytes stay on the device path.</p>
        </aside>
        <section className="demo-panel" aria-labelledby="demo-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">PROTOCOL WORKBENCH</p>
              <h2 id="demo-title">A foundation you can inspect.</h2>
            </div>
            <span className="pill">Local simulation</span>
          </div>
          <p className="demo-note">
            This Phase 0 demo uses synthetic lifecycle events. It does not create a room, connect
            peers, or transfer files.
          </p>
          <div className="state-grid">
            {Object.entries(snapshot).map(([label, state]) => (
              <div className="state-card" key={label}>
                <span>{label} state</span>
                <strong data-testid={`${label}-state`}>{state}</strong>
              </div>
            ))}
          </div>
          <div className="actions">
            <button onClick={() => dispatch('PEER_PENDING')}>Request peer</button>
            <button onClick={() => dispatch('PEER_APPROVED')}>Approve peer</button>
            <button onClick={() => dispatch('ROOM_CLOSED')}>Close demo room</button>
            <button
              className="secondary"
              onClick={() => {
                const steps = runDemoLifecycle();
                setSnapshot(steps.at(-1) ?? INITIAL_DEMO);
                setHistory(
                  steps.map(
                    (step) => `room ${step.room} · peer ${step.peer} · transfer ${step.transfer}`,
                  ),
                );
                setError('');
              }}
            >
              Run demo lifecycle
            </button>
            <button
              className="text-button"
              onClick={() => {
                setSnapshot(INITIAL_DEMO);
                setHistory([]);
                setError('');
              }}
            >
              Reset
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="event-log" aria-live="polite">
            <span className="log-label">EVENT LOG</span>
            {history.length === 0 ? (
              <p>Ready for a schema-validated event.</p>
            ) : (
              <ol>
                {history.map((entry, i) => (
                  <li key={i}>{entry}</li>
                ))}
              </ol>
            )}
          </div>
        </section>
        <section className="details-grid">
          <div>
            <p className="eyebrow">ON THIS BROWSER</p>
            <h2>Capabilities, observed.</h2>
            <p className="muted">
              API presence does not guarantee permission, available space, or persistent recovery.
            </p>
            <dl>
              {Object.entries(capabilities).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {
                      {
                        secureContext: 'Secure context',
                        webRtc: 'WebRTC API',
                        opfsApi: 'OPFS API',
                        indexedDbApi: 'IndexedDB API',
                        savePickerApi: 'Save picker API',
                        storageEstimateApi: 'Storage estimate API',
                      }[key]
                    }
                  </dt>
                  <dd>{value ? 'Available' : 'Unavailable'}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="next-panel">
            <p className="eyebrow">THE CONTRACT</p>
            <h2>
              Small frames.
              <br />
              Explicit states.
            </h2>
            <p>
              Protocol v{PROTOCOL_VERSION} starts with a {DEFAULT_FRAME_BYTES / 1024} KiB frame
              ceiling and 1 MiB verification blocks. Completion requires verified integrity and
              finalized receiver storage.
            </p>
            <div className="next-phase">
              <span>UP NEXT · PHASE 1</span>
              <strong>Authorized signaling rooms</strong>
              <p>Invitations, peer approval, and scoped WebSocket admission.</p>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <span>MeshDrop / built for the path between devices</span>
        <span>Phase 0 · No live transfer available</span>
      </footer>
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
