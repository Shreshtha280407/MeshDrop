import { useState } from 'react';
import type { RoomClient, RoomView } from './RoomClient';

export function PairingPanel({ client, view }: { client: RoomClient; view: RoomView }) {
  const [comparison, setComparison] = useState('');
  const [independent, setIndependent] = useState(false);
  const peer = view.peer;
  return (
    <section
      className="demo-panel signaling-panel"
      data-receive-queue-peak={peer.peakReceiveQueueBytes}
      aria-labelledby="peer-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">DEVICE CONNECTION</p>
          <h2 id="peer-title">Meet your peer.</h2>
        </div>
        <span className="pill" data-testid="peer-state">
          {peer.state}
        </span>
      </div>
      <p className="demo-note">
        Both devices must stay open. After approval, the encrypted connection starts automatically.
        Confirm the code on both devices to enable file offers.
      </p>
      <div className="state-grid">
        <div className="state-card">
          <span>Connection epoch</span>
          <strong data-testid="peer-epoch">{peer.epoch}</strong>
        </div>
        <div className="state-card">
          <span>Selected path</span>
          <strong data-testid="ice-path">{peer.path?.kind ?? 'unknown'}</strong>
        </div>
        <div className="state-card">
          <span>Identity comparison</span>
          <strong data-testid="verification-state">{peer.verification}</strong>
        </div>
      </div>
      {peer.ready && (
        <div className="pairing-box">
          <h3>Compare on a separate trusted channel.</h3>
          <p>
            Read this code aloud to the other person, or compare both screens in person. A matching
            invitation or a message relayed through this room does not verify who they are.
          </p>
          <output className="pairing-code" data-testid="pairing-code">
            {peer.code}
          </output>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              client.confirmComparison(comparison, independent);
            }}
          >
            <label htmlFor="peer-code">Code shown on the other device</label>
            <input
              id="peer-code"
              value={comparison}
              onChange={(event) => setComparison(event.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              maxLength={24}
              required
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={independent}
                onChange={(event) => setIndependent(event.target.checked)}
              />
              I compared using a separate trusted channel
            </label>
            <div className="actions">
              <button
                type="submit"
                disabled={!comparison || !independent || peer.verification === 'verified'}
              >
                Confirm comparison
              </button>
              <button type="button" className="secondary" onClick={() => client.rejectComparison()}>
                Codes do not match
              </button>
            </div>
          </form>
          <details>
            <summary>Full pairing fingerprint</summary>
            <code className="fingerprint">{peer.fingerprint}</code>
          </details>
        </div>
      )}
      <p className="muted" data-testid="remote-verification">
        Other device comparison: {peer.remoteVerified ? 'confirmed' : 'waiting'}
      </p>
      <div className="actions">
        <button
          disabled={!peer.ready}
          onClick={() => {
            void client.sendPing();
          }}
        >
          Send signed ping
        </button>
        <button
          className="secondary"
          disabled={view.connection !== 'connected' || !peer.ready}
          onClick={() => {
            void client.requestConnection('ice-restart');
          }}
        >
          Restart ICE
        </button>
        <button
          className="secondary"
          disabled={view.connection !== 'connected' || view.status?.state !== 'approved'}
          onClick={() => {
            void client.requestConnection('new-connection');
          }}
        >
          New peer connection
        </button>
      </div>
      <p className="muted">
        Pings received: <strong data-testid="received-pings">{peer.pingsReceived}</strong> · Replies
        received: <strong data-testid="received-pongs">{peer.pongsReceived}</strong>
      </p>
      {peer.capabilities && (
        <p className="muted" data-testid="negotiated-capabilities">
          Protocol {peer.capabilities.protocolVersion} · Frame limit{' '}
          {peer.capabilities.preferredFrameBytes} bytes · SHA-256 · Storage:{' '}
          {peer.capabilities.storageModes.join(', ')} · Resume: {peer.capabilities.resumeMode}
        </p>
      )}
      {peer.epoch > 0 && (
        <p className="muted">
          {peer.relayAvailable
            ? 'A temporary TURN relay is available if a direct path fails.'
            : 'TURN relay is not configured. Networks that require a relay may not connect.'}
        </p>
      )}
      {peer.error && (
        <p className="error" role="alert">
          {peer.error}
        </p>
      )}
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
  );
}
