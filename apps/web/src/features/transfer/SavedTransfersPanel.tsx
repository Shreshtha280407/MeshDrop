import { useEffect, useRef, useState } from 'react';
import { requestPersistence, startFileDownload, StorageClient } from '@meshdrop/storage';
import type { RecoveryListing } from '@meshdrop/storage';

export function SavedTransfersPanel() {
  const client = useRef<StorageClient | null>(null);
  const releases = useRef<(() => void)[]>([]);
  const [listing, setListing] = useState<RecoveryListing | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const storage = new StorageClient();
    client.current = storage;
    let current = true;
    void storage
      .list()
      .then((value) => {
        if (current) setListing(value);
      })
      .catch(() => {
        if (current)
          setError(
            'Local checkpoints are unavailable in this browser mode. Use a regular supported browser.',
          );
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
      storage.dispose();
      client.current = null;
      for (const release of releases.current) release();
      releases.current = [];
    };
  }, []);
  async function action(work: (storage: StorageClient) => Promise<void>) {
    const storage = client.current;
    if (!storage || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work(storage);
    } catch {
      setError(
        'The local operation could not finish. Check the source file, available space and whether another tab is using this transfer.',
      );
    } finally {
      if (client.current === storage) setBusy(false);
    }
  }
  return (
    <section
      className="demo-panel saved-panel"
      aria-labelledby="saved-title"
      data-testid="saved-transfers"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL TO THIS BROWSER</p>
          <h2 id="saved-title">Saved transfers</h2>
        </div>
        <span className="pill">Verified on reopen</span>
      </div>
      <p className="demo-note">
        Surviving blocks are reread and rehashed before appearing here. Partial checkpoints are
        local evidence; they do not reconnect a room or resume a transfer yet. Browser eviction or
        clearing site data can remove them.
      </p>
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void action(async (storage) => {
              setListing(await storage.list());
            });
          }}
        >
          Check saved transfers
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void action(async () => {
              const granted = await requestPersistence();
              setMessage(
                granted
                  ? 'Persistent storage was granted. Clearing site data still removes files.'
                  : 'Persistent storage was not granted. Keep a separate saved copy.',
              );
            });
          }}
        >
          Request persistent storage
        </button>
      </div>
      {busy && <p role="status">Checking local storage and rehashing saved blocks…</p>}
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
      {message && (
        <p className="status-note" role="status">
          {message}
        </p>
      )}
      {listing &&
        !busy &&
        !listing.checkpoints.length &&
        !listing.sources.length &&
        !listing.unavailable.length && (
          <p className="muted">No retained transfers in this browser.</p>
        )}
      {listing?.checkpoints.map((checkpoint) => (
        <article
          className="saved-transfer"
          key={checkpoint.record.transferId}
          data-testid="saved-checkpoint"
          data-transfer-id={checkpoint.record.transferId}
          data-verified-bytes={checkpoint.committedBytes}
        >
          <h3>
            {checkpoint.manifest.files[0]?.path}
            {checkpoint.manifest.files.length > 1
              ? ` + ${checkpoint.manifest.files.length - 1} files`
              : ''}
          </h3>
          <p>
            <strong data-testid="recovered-bytes">{checkpoint.committedBytes}</strong> /{' '}
            {checkpoint.manifest.totalBytes} bytes verified locally.
          </p>
          <p className="muted">
            {checkpoint.record.receipt
              ? 'Completed receipt restored.'
              : 'Interrupted checkpoint; completion has not been confirmed.'}{' '}
            Retained until {new Date(checkpoint.record.expiresAt).toLocaleString()}.
          </p>
          {checkpoint.discardedBlocks > 0 && (
            <p className="status-note">
              {checkpoint.discardedBlocks} missing or changed ledger entries were discarded.
            </p>
          )}
          <ul className="file-list">
            {checkpoint.manifest.files.map((meta) => {
              const file = checkpoint.files.find((file) => file.fileId === meta.fileId)!;
              return (
                <li key={meta.fileId}>
                  <strong>{meta.path}</strong>
                  <p className="muted" data-testid="saved-ranges">
                    Verified block ranges: {JSON.stringify(file.ranges)}
                  </p>
                  {file.finalized && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        void action(async (storage) => {
                          const output = await storage.exportFile(
                            checkpoint.record.transferId,
                            meta.fileId,
                          );
                          releases.current.push(startFileDownload(output, meta.path));
                        });
                      }}
                    >
                      Export saved {meta.path}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void action(async (storage) => {
                await storage.purge(checkpoint.record.transferId);
                setListing(await storage.list());
              });
            }}
          >
            Delete saved {checkpoint.manifest.files[0]?.path}
          </button>
        </article>
      ))}
      {listing?.sources.map((source) => (
        <article
          className="saved-transfer"
          key={`source-${source.transferId}`}
          data-testid="saved-source"
        >
          <h3>Source: {source.manifest.files[0]?.path}</h3>
          <p className="muted">
            Only the manifest was retained. Reselect the original file to verify its full name, size
            and SHA-256. File access lasts for this page session.
          </p>
          {source.manifest.files.map((file) => (
            <label key={file.fileId}>
              Reselect source {file.path}
              <input
                type="file"
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.files?.[0];
                  event.target.value = '';
                  if (selected)
                    void action(async (storage) => {
                      await storage.verifySource(source.transferId, file.fileId, selected);
                      setMessage(
                        `Source verified: ${file.path}. Network resume is planned for Phase 5.`,
                      );
                    });
                }}
              />
            </label>
          ))}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void action(async (storage) => {
                await storage.removeSource(source.transferId);
                setListing(await storage.list());
              });
            }}
          >
            Forget source {source.manifest.files[0]?.path}
          </button>
        </article>
      ))}
      {listing?.unavailable.map((item) => (
        <p className="muted" key={item.transferId}>
          {item.reason}
        </p>
      ))}
      {Boolean(listing?.cleaned) && (
        <p className="muted">
          Removed {listing?.cleaned} expired or orphaned local storage entries.
        </p>
      )}
    </section>
  );
}
