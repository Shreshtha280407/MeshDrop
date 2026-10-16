import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RoomClient } from './features/pairing/RoomClient';
import { detectDeviceCapabilities } from '@meshdrop/platform';

export default function RoomApp({ initialInvitation }: { initialInvitation: string }) {
  const client = useMemo(() => new RoomClient(), []);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [invite, setInvite] = useState(initialInvitation);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => () => client.dispose(), [client]);
  const status = view.status;
  const isOwner = status?.role === 'owner';
  const capabilities = detectDeviceCapabilities();
  async function copyInvitation() {
    try {
      await navigator.clipboard.writeText(view.invitation);
      setCopied(true);
      setCopyError('');
    } catch {
      setCopyError('Clipboard unavailable. Select the invitation field and copy it manually.');
    }
  }
  return (
    <div className="app-shell">
      <header>
        <a className="brand" href="/" aria-label="MeshDrop home">
          <img src="/icon.svg" alt="" />
          MeshDrop<span className="version">v1</span>
        </a>
        <span className="phase-label">
          <i />
          Secure rooms / Phase 1
        </span>
      </header>
      <main>
        <section className="intro">
          <p className="eyebrow">PRIVATE SHARING STARTS WITH PERMISSION.</p>
          <h1>
            Your invitation.
            <br />
            Your decision.
          </h1>
          <p className="lede">
            Create a short-lived room and approve the person joining you. Your files will travel
            between devices, with no account required.
          </p>
          <div className="principles">
            <span>Explicit approval</span>
            <span>Two devices per room</span>
            <span>Expiring access</span>
          </div>
        </section>
        <aside className="connection-map" aria-label="Planned architecture">
          <div className="device">
            <span>↗</span>Your device<small>Room owner</small>
          </div>
          <div className="connection-line">
            <span>AUTHORIZED SIGNALING</span>
            <div />
            <small>Live in Phase 1</small>
          </div>
          <div className="device">
            <span>↙</span>Other device<small>Approved receiver</small>
          </div>
          <p>File transport is planned in Phases 2–3.</p>
        </aside>
        <section className="demo-panel room-panel" aria-labelledby="room-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">MAKE A CONNECTION</p>
              <h2 id="room-title">A room for two.</h2>
            </div>
            <span className="pill">Live local backend</span>
          </div>
          <p className="demo-note">
            This phase provides real room authorization and signaling. File transfer is not
            available yet. Keep both browser windows open.
          </p>
          {!status ? (
            <div className="entry-grid">
              <div>
                <h3>Start a room</h3>
                <p className="muted">Create a private invitation. You decide who gets in.</p>
                <button
                  disabled={view.busy}
                  onClick={() => {
                    setCopied(false);
                    void client.createRoom();
                  }}
                >
                  Create invitation
                </button>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void client.joinRoom(invite);
                }}
              >
                <label htmlFor="join-invitation">Join with an invitation</label>
                <p className="muted">Paste the complete link from the room owner.</p>
                <input
                  id="join-invitation"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste private invitation link"
                  value={invite}
                  onChange={(event) => setInvite(event.target.value)}
                  required
                />
                <button disabled={view.busy || !invite.trim()} type="submit">
                  Request to join
                </button>
              </form>
            </div>
          ) : (
            <>
              <div className="state-grid">
                <div className="state-card">
                  <span>Room</span>
                  <strong data-testid="live-room-state">{status.state}</strong>
                </div>
                <div className="state-card">
                  <span>Your admission</span>
                  <strong data-testid="admission-state">{status.approval}</strong>
                </div>
                <div className="state-card">
                  <span>Signaling</span>
                  <strong data-testid="connection-state">{view.connection}</strong>
                </div>
              </div>
              <p className="muted">
                Your role: <strong data-testid="peer-role">{status.role}</strong> · Room expires{' '}
                {new Date(status.expiresAt).toLocaleTimeString()}.
              </p>
              {isOwner && view.invitation && (
                <div className="invitation-box">
                  <label htmlFor="private-invitation">Private invitation link</label>
                  <input
                    id="private-invitation"
                    type="password"
                    value={view.invitation}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(event) => event.target.select()}
                  />
                  <button
                    className="secondary"
                    onClick={() => {
                      void copyInvitation();
                    }}
                  >
                    {copied ? 'Copied' : 'Copy invitation'}
                  </button>
                  <p className="muted">
                    Share privately. One receiver may request admission before the invitation
                    expires.
                  </p>
                  {copyError && (
                    <p role="status" className="muted">
                      {copyError}
                    </p>
                  )}
                </div>
              )}
              {isOwner && status.state === 'pending' && (
                <div className="approval-box">
                  <h3>A receiver is asking to join.</h3>
                  <p className="muted">
                    Approve only the person you intended to invite. Admission alone does not verify
                    their real-world identity.
                  </p>
                  <div className="actions">
                    <button
                      disabled={view.busy}
                      onClick={() => {
                        void client.decide('approve');
                      }}
                    >
                      Approve receiver
                    </button>
                    <button
                      className="secondary"
                      disabled={view.busy}
                      onClick={() => {
                        void client.decide('reject');
                      }}
                    >
                      Reject receiver
                    </button>
                  </div>
                </div>
              )}
              {!isOwner && status.approval === 'pending' && (
                <p className="status-note">Waiting for the room owner to approve your request.</p>
              )}
              {status.approval === 'rejected' && (
                <p className="status-note">
                  The owner rejected this request. Ask for a new room invitation.
                </p>
              )}
              {status.state === 'closed' && (
                <p className="status-note">
                  This room is closed. Its invitations and signaling access are revoked.
                </p>
              )}
              <div className="actions">
                {status.state !== 'closed' && status.approval === 'approved' && (
                  <button
                    className="secondary"
                    disabled={view.busy || view.connection === 'connecting'}
                    onClick={() => {
                      void client.reconnect();
                    }}
                  >
                    Reconnect signaling
                  </button>
                )}
                {isOwner && status.state !== 'closed' && (
                  <button
                    disabled={view.busy}
                    onClick={() => {
                      void client.closeRoom();
                    }}
                  >
                    Revoke room
                  </button>
                )}
                {(status.state === 'closed' || status.approval === 'rejected') && (
                  <button
                    className="secondary"
                    onClick={() => {
                      client.reset();
                      setInvite('');
                    }}
                  >
                    Start again
                  </button>
                )}
              </div>
            </>
          )}
          {view.busy && (
            <p className="muted" role="status">
              Updating room…
            </p>
          )}
          {view.error && (
            <p className="error" role="alert">
              {view.error}
            </p>
          )}
        </section>
        {status && (
          <section className="demo-panel signaling-panel" aria-labelledby="signal-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">PHASE 1 VERIFICATION</p>
                <h2 id="signal-title">Try the signaling path.</h2>
              </div>
              <span className="pill">No file data</span>
            </div>
            <p className="demo-note">
              After approval, send a harmless signaling probe. Its receipt appears on the other
              device. This checks room isolation; it does not open a WebRTC connection.
            </p>
            <button
              disabled={view.connection !== 'connected' || status.state !== 'approved'}
              onClick={() => client.sendProbe()}
            >
              Send signaling probe
            </button>
            <p className="muted">
              Probes received:{' '}
              <strong data-testid="received-signals">{view.receivedSignals}</strong>
            </p>
            <div className="event-log" aria-live="polite">
              <span className="log-label">ROOM EVENTS</span>
              {view.events.length ? (
                <ol>
                  {view.events.map((event, index) => (
                    <li key={index}>{event}</li>
                  ))}
                </ol>
              ) : (
                <p>No room events yet.</p>
              )}
            </div>
          </section>
        )}
        <section className="details-grid">
          <div>
            <p className="eyebrow">ON THIS BROWSER</p>
            <h2>Capabilities, observed.</h2>
            <p className="muted">
              API presence does not guarantee storage permission, quota, or persistent recovery.
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
            <p className="eyebrow">THE TRUST BOUNDARY</p>
            <h2>
              Approval first.
              <br />
              Files stay with you.
            </h2>
            <p>
              Invitations are single use. An unapproved guest cannot open a signaling socket. Server
              storage contains credential verifiers and temporary room state.
            </p>
            <div className="next-phase">
              <span>UP NEXT · PHASE 2</span>
              <strong>Peer connectivity and independent verification</strong>
              <p>Real WebRTC negotiation, ICE paths, and a code comparison flow.</p>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <span>MeshDrop / short-lived rooms, explicit consent</span>
        <a href="/foundation">Phase 0 protocol workbench</a>
      </footer>
    </div>
  );
}
