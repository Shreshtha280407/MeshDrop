import { useEffect, useState } from 'react';
import { estimateCapacity } from '@meshdrop/storage';
import type { CapacityResult, RetentionPolicy } from '@meshdrop/storage';
import type { RoomClient, RoomView } from '../pairing/RoomClient';
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MiB`
        : `${(value / 1024 ** 3).toFixed(2)} GiB`;
export function TransferPanel({ client, view }: { client: RoomClient; view: RoomView }) {
  const [files, setFiles] = useState<File[]>([]);
  const transfer = view.transfer;
  const isOwner = view.status?.role === 'owner';
  const paired =
    view.peer.ready && view.peer.verification === 'verified' && view.peer.remoteVerified;
  const supported = view.peer.capabilities?.storageModes.includes('opfs');
  const done =
    transfer.state === 'complete' || transfer.state === 'cancelled' || transfer.state === 'failed';
  const total = transfer.manifest?.totalBytes ?? 0;
  const [capacity, setCapacity] = useState<CapacityResult | null>(null);
  useEffect(() => {
    let current = true;
    setCapacity(null);
    if (!isOwner && transfer.state === 'negotiating')
      void estimateCapacity(total)
        .then((result) => {
          if (current) setCapacity(result);
        })
        .catch(() => {
          if (current)
            setCapacity({
              available: false,
              estimatedFreeBytes: null,
              persistent: false,
              warnings: [
                'Browser storage could not be checked. Use a regular browser and free local disk space.',
              ],
            });
        });
    return () => {
      current = false;
    };
  }, [isOwner, transfer.state, total]);
  return (
    <section
      className="demo-panel transfer-panel"
      data-buffer-peak={transfer.peakBufferedBytes}
      data-block-peak={transfer.peakBlockBytes}
      aria-labelledby="transfer-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">FILES STAY BETWEEN DEVICES</p>
          <h2 id="transfer-title">Send. Verify. Save.</h2>
        </div>
        <span className="pill" data-testid="transfer-state">
          {transfer.state ?? 'idle'}
        </span>
      </div>
      <p className="demo-note">
        Received files stay in this browser with a verified local checkpoint. Save a copy after
        verification. Reopening checks surviving bytes; network resume is not available yet.
      </p>
      {!paired && (
        <p className="status-note">
          Confirm the pairing code on both devices before sharing files.
        </p>
      )}
      {paired && !supported && (
        <p className="error">
          This browser pair cannot provide the required temporary file storage.
        </p>
      )}
      {isOwner && !transfer.state && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void client.offerFiles(files);
          }}
        >
          <label htmlFor="files-to-send">Choose files to send</label>
          <input
            id="files-to-send"
            type="file"
            multiple
            disabled={!paired || !supported || view.busy}
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <button type="submit" disabled={!paired || !supported || view.busy || !files.length}>
            Offer files
          </button>
        </form>
      )}
      {transfer.state === 'preparing' && (
        <p role="status">
          Reading and hashing selected files. You can cancel while preparation runs.
        </p>
      )}
      {transfer.manifest && (
        <>
          <ul className="file-list">
            {transfer.manifest.files.map((file) => (
              <li key={file.fileId}>
                <div>
                  <strong>{file.path}</strong>
                  <span className="muted">{bytes(file.size)}</span>
                </div>
                {transfer.state === 'complete' && (
                  <code className="fingerprint" data-testid="file-sha256">
                    {file.sha256}
                  </code>
                )}
                {!isOwner && transfer.state === 'complete' && (
                  <button className="secondary" onClick={() => client.saveFile(file.fileId)}>
                    Save {file.path}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <label htmlFor="confirmed-progress">Confirmed in receiver storage</label>
          <progress
            id="confirmed-progress"
            max={total || 1}
            value={total === 0 && transfer.state === 'complete' ? 1 : transfer.committedBytes}
          />
          <p className="muted">
            <strong data-testid="committed-bytes">{transfer.committedBytes}</strong> /{' '}
            <span data-testid="total-bytes">{total}</span> bytes confirmed ·{' '}
            {bytes(transfer.committedBytes)} of {bytes(total)}
          </p>
        </>
      )}
      {!isOwner && transfer.state === 'negotiating' && (
        <div className="approval-box">
          <h3>Accept these files?</h3>
          <p>
            Destination: browser storage with local checkpoints. Files are isolated from existing
            downloads and verified before completion. Clearing site data removes these files.
          </p>
          <label htmlFor="partial-retention">Retain interrupted files</label>
          <select
            id="partial-retention"
            value={view.retention}
            onChange={(event) => client.setRetention(event.target.value as RetentionPolicy)}
          >
            <option value="24-hours">24 hours after the last committed block</option>
            <option value="7-days">7 days after the last committed block</option>
            <option value="discard">Delete after interruption or reopening</option>
          </select>
          <p className="muted">
            Cancel and Clear transfer delete partial files. Expired data is cleaned when MeshDrop
            opens.
          </p>
          {capacity && (
            <p className="status-note" data-testid="quota-preflight">
              {capacity.estimatedFreeBytes === null
                ? 'Free space unknown.'
                : `${bytes(capacity.estimatedFreeBytes)} estimated free.`}{' '}
              {capacity.warnings.join(' ')}
            </p>
          )}
          <div className="actions">
            <button
              disabled={!capacity?.available}
              onClick={() => {
                void client.acceptFiles();
              }}
            >
              Accept files
            </button>
            <button
              className="secondary"
              onClick={() => {
                void client.rejectFiles();
              }}
            >
              Decline files
            </button>
          </div>
        </div>
      )}
      {isOwner && transfer.state === 'negotiating' && (
        <p role="status">Waiting for the receiver to accept the offer.</p>
      )}
      {(transfer.state === 'active' || transfer.state === 'paused') && !transfer.storageFull && (
        <div className="actions">
          <button
            className="secondary"
            onClick={() => {
              void client.pauseFiles(!transfer.localPaused);
            }}
          >
            {transfer.localPaused ? 'Resume transfer' : 'Pause transfer'}
          </button>
        </div>
      )}
      {transfer.storageFull && (
        <button
          className="secondary"
          onClick={() => {
            void client.retryStorage();
          }}
        >
          Retry storage
        </button>
      )}
      {transfer.remotePaused && (
        <p className="status-note">
          The other device paused this transfer. Bytes already in flight may still be committed.
        </p>
      )}
      {transfer.state === 'verifying' && (
        <p role="status">
          Checking complete file hashes from stored bytes and confirming the final receipt…
        </p>
      )}
      {transfer.state && !done && (
        <button
          className="secondary"
          onClick={() => {
            void client.cancelFiles();
          }}
        >
          Cancel transfer
        </button>
      )}
      {transfer.state === 'complete' && (
        <div className="success-note" role="status">
          <h3>Verified and stored.</h3>
          <p>
            Both devices confirmed the receipt.{' '}
            {isOwner
              ? 'The receiver can now save its copies.'
              : 'Save your copies before clearing this transfer or leaving the page.'}
          </p>
          <button className="secondary" onClick={() => client.saveReceipt()}>
            Save transfer receipt
          </button>
        </div>
      )}
      {transfer.error && (
        <p className="error" role="alert">
          {transfer.error}
        </p>
      )}
      {done && (
        <button
          className="secondary"
          onClick={() => {
            setFiles([]);
            void client.clearTransfer();
          }}
        >
          Clear transfer
        </button>
      )}
    </section>
  );
}
