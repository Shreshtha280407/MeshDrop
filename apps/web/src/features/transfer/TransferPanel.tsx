import { exportNames } from '../../security/safeFilePath';
import { MAX_TRANSFER_FILES } from '@meshdrop/protocol';
import { useEffect, useRef, useState } from 'react';
import { readableBytes as bytes, transferAnnouncement } from '../../accessibility';
import { estimateCapacity } from '@meshdrop/storage';
import type { CapacityResult, RetentionPolicy } from '@meshdrop/storage';
import { receivePolicy } from '@meshdrop/platform';
import type { CapabilityResult } from '@meshdrop/platform';
import { FileExportControls } from '../mobile/FileExportControls';
import type { RoomClient, RoomView } from '../pairing/RoomClient';
export function TransferPanel({
  client,
  view,
  capabilities,
}: {
  client: RoomClient;
  view: RoomView;
  capabilities: CapabilityResult | null;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const inFlight = useRef(new Set<string>());
  const [working, setWorking] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState('');
  const [receiptStatus, setReceiptStatus] = useState('');
  function action(key: string, operation: () => Promise<void>) {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setWorking([...inFlight.current]);
    setActionError('');
    void operation()
      .catch(() => {
        setActionError(
          'The action could not finish. Check the connection, available storage and any saved checkpoint before retrying.',
        );
      })
      .finally(() => {
        inFlight.current.delete(key);
        setWorking([...inFlight.current]);
      });
  }
  const transfer = view.transfer;
  const isOwner = view.status?.role === 'owner';
  const paired =
    view.peer.ready && view.peer.verification === 'verified' && view.peer.remoteVerified;
  const supported = view.peer.capabilities?.storageModes.includes('opfs');
  const done =
    transfer.state === 'complete' || transfer.state === 'cancelled' || transfer.state === 'failed';
  const names = exportNames(transfer.manifest?.files ?? []);
  const total = transfer.manifest?.totalBytes ?? 0;
  const [capacity, setCapacity] = useState<CapacityResult | null>(null);
  const [acknowledgedLimits, setAcknowledgedLimits] = useState(false);
  const policy =
    capabilities && capacity
      ? receivePolicy(
          {
            ...capabilities,
            estimatedFreeBytes: capacity.estimatedFreeBytes,
            persistentStorage: capacity.persistent,
          },
          total,
        )
      : null;
  useEffect(() => {
    let current = true;
    setCapacity(null);
    setAcknowledgedLimits(false);
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
          <h2 id="transfer-title" tabIndex={-1} data-focus-target>
            Send. Verify. Save.
          </h2>
        </div>
        <span className="pill" data-testid="transfer-state">
          {transfer.state ?? 'idle'}
        </span>
      </div>
      <p role="status" aria-atomic="true" className="sr-only" data-testid="transfer-announcement">
        {transferAnnouncement(
          transfer.state,
          transfer.storageFull,
          transfer.localPaused,
          transfer.remotePaused,
        )}
      </p>
      <p className="demo-note">
        Received files stay in this browser with a verified local checkpoint. Save a copy after
        verification. Resume rechecks saved blocks and sends only missing bytes after both devices
        confirm a fresh connection.
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
            aria-describedby="file-selection-help"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <p className="muted" id="file-selection-help">
            Select up to {MAX_TRANSFER_FILES} files. The receiver reviews the offer before any file
            data is sent.
          </p>
          {files.length > 0 && (
            <ul aria-label="Selected files">
              {files.slice(0, MAX_TRANSFER_FILES).map((file, index) => (
                <li key={index}>
                  {file.name} · {bytes(file.size)}
                </li>
              ))}
            </ul>
          )}
          {files.length > MAX_TRANSFER_FILES && (
            <p className="error" role="status">
              {files.length} files selected. Choose at most {MAX_TRANSFER_FILES} before offering
              files; the list shows only the first {MAX_TRANSFER_FILES}.
            </p>
          )}
          <button
            type="submit"
            disabled={
              !paired ||
              !supported ||
              view.busy ||
              !files.length ||
              files.length > MAX_TRANSFER_FILES
            }
          >
            Offer files
          </button>
        </form>
      )}
      {transfer.recovery && (
        <div className="status-note" data-testid="resume-state">
          <p role="status" aria-atomic="true">
            {transfer.recovery}
          </p>
          <p>
            Reused verified bytes:{' '}
            <strong data-testid="reused-bytes">{transfer.reusedBytes}</strong> ·{' '}
            {isOwner ? 'Payload sent this attempt' : 'Payload committed this attempt'}:{' '}
            <strong data-testid="attempt-bytes">{transfer.attemptBytes}</strong> · Invalid or
            missing saved blocks: {transfer.discardedBlocks}
          </p>
        </div>
      )}
      {transfer.state === 'reconnecting' && (
        <button
          disabled={!paired || view.busy}
          onClick={() => {
            void client.resumeCurrent();
          }}
        >
          {isOwner ? 'Prepare original source' : 'Resume saved transfer'}
        </button>
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
                {!isOwner && transfer.state === 'complete' && client.verifiedFile(file.fileId) && (
                  <FileExportControls
                    file={client.verifiedFile(file.fileId)!}
                    path={file.path}
                    outputName={names.get(file.fileId)!}
                  />
                )}
              </li>
            ))}
          </ul>
          <label htmlFor="confirmed-progress">Confirmed in receiver storage</label>
          <progress
            id="confirmed-progress"
            max={total || 1}
            value={total === 0 && transfer.state === 'complete' ? 1 : transfer.committedBytes}
            aria-valuetext={`${bytes(transfer.committedBytes)} of ${bytes(total)} confirmed in receiver storage. ${transfer.state ?? 'Waiting'}.`}
            aria-describedby="progress-help"
          />
          <p className="muted" id="progress-help">
            <strong data-testid="committed-bytes">{transfer.committedBytes}</strong> /{' '}
            <span data-testid="total-bytes">{total}</span> bytes confirmed ·{' '}
            {bytes(transfer.committedBytes)} of {bytes(total)}
          </p>
        </>
      )}
      {!isOwner && transfer.state === 'negotiating' && !transfer.recovery && (
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
            aria-describedby="retention-help receive-strategy"
            onChange={(event) => client.setRetention(event.target.value as RetentionPolicy)}
          >
            <option value="24-hours">24 hours after the last committed block</option>
            <option value="7-days">7 days after the last committed block</option>
            <option value="discard">Delete after interruption or reopening</option>
          </select>
          <p className="muted" id="retention-help">
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
          <p className="status-note" data-testid="receive-strategy" id="receive-strategy">
            {!policy
              ? 'Checking usable storage…'
              : `Receive strategy: ${policy.strategy === 'opfs-checkpoint' ? 'verified browser files with local checkpoints' : 'unavailable'}. Export: ${policy.exportStrategy === 'picker-or-download' ? 'choose a save location or download' : 'browser download or system share / Save to Files'}.`}
          </p>
          {policy && (
            <ul className="muted" data-testid="platform-limits">
              {policy.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {policy?.requiresAcknowledgement && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={acknowledgedLimits}
                onChange={(event) => setAcknowledgedLimits(event.target.checked)}
              />
              I understand the storage and export limits and will keep both devices open
            </label>
          )}
          <div className="actions">
            <button
              disabled={
                !capacity?.available ||
                !policy?.allowed ||
                view.busy ||
                (policy.requiresAcknowledgement && !acknowledgedLimits)
              }
              onClick={() => {
                void client.acceptFiles(acknowledgedLimits);
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
      {isOwner && transfer.state === 'negotiating' && !transfer.recovery && (
        <p role="status">Waiting for the receiver to accept the offer.</p>
      )}
      {(transfer.state === 'active' || transfer.state === 'paused') && !transfer.storageFull && (
        <div className="actions">
          <button
            className="secondary"
            disabled={working.includes('pause')}
            onClick={() => {
              action('pause', () => client.pauseFiles(!transfer.localPaused));
            }}
          >
            {transfer.localPaused ? 'Resume transfer' : 'Pause transfer'}
          </button>
        </div>
      )}
      {transfer.storageFull && (
        <button
          className="secondary"
          disabled={working.includes('storage')}
          aria-describedby="storage-retry-help"
          onClick={() => {
            action('storage', () => client.retryStorage());
          }}
        >
          Retry storage
        </button>
      )}
      {transfer.storageFull && (
        <p id="storage-retry-help" className="status-note">
          Previously committed blocks remain available. Free space or close other storage-heavy
          tabs, then retry. Cancelling stops this attempt.
        </p>
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
          disabled={working.includes('cancel')}
          aria-describedby="transfer-delete-help"
          onClick={() => {
            action('cancel', () => client.cancelFiles());
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
          <p className="muted" id="receipt-help">
            The receipt records transfer verification. It does not identify a person or grant room
            access.
          </p>
          <button
            className="secondary"
            aria-describedby="receipt-help"
            onClick={() => {
              try {
                client.saveReceipt();
                setReceiptStatus(
                  'Receipt download requested. Check your downloads for the JSON record.',
                );
              } catch {
                setReceiptStatus(
                  'The receipt download could not start. Keep this page open and try again.',
                );
              }
            }}
          >
            Save transfer receipt
          </button>
        </div>
      )}
      <p className="muted" role="status" aria-atomic="true">
        {receiptStatus}
      </p>
      {working.length > 0 && (
        <p role="status">
          Updating transfer controls. You can still cancel preparation or recovery.
        </p>
      )}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}
      {transfer.error && (
        <p className="error" role="alert">
          {transfer.error}
        </p>
      )}
      {done && (
        <button
          className="secondary"
          disabled={working.includes('clear')}
          aria-describedby="transfer-delete-help"
          onClick={() => {
            setFiles([]);
            setReceiptStatus('');
            action('clear', () => client.clearTransfer());
          }}
        >
          Clear transfer
        </button>
      )}
      {transfer.state && (
        <p className="muted" id="transfer-delete-help">
          Cancel stops this transfer attempt and removes its partial browser data where possible.
          Clear transfer removes its local checkpoint. Neither deletes copies already saved to
          Downloads or Files.
        </p>
      )}
    </section>
  );
}
