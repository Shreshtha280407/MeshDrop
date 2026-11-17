import { exportNames } from '../../security/safeFilePath';
import { useEffect, useRef, useState } from 'react';
import { requestPersistence, StorageClient } from '@meshdrop/storage';
import { uuidSchema } from '@meshdrop/protocol';
import { readableBytes, useFocusRecovery } from '../../accessibility';
import { FileExportControls } from '../mobile/FileExportControls';
import type { RoomClient, RoomView } from '../pairing/RoomClient';
import type { RecoveryListing } from '@meshdrop/storage';

export function SavedTransfersPanel({ room, view }: { room: RoomClient; view: RoomView }) {
  const panel = useRef<HTMLElement>(null);
  useFocusRecovery(panel);
  const selected = useRef(new Map<string, Map<string, File>>());
  const [selectedCount, setSelectedCount] = useState(0);
  const paired =
    view.peer.ready && view.peer.verification === 'verified' && view.peer.remoteVerified;

  const client = useRef<StorageClient | null>(null);
  const [prepared, setPrepared] = useState<Record<string, File>>({});
  const [listing, setListing] = useState<RecoveryListing | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  function applyListing(value: RecoveryListing) {
    const verifiedFiles = new Set(
      value.checkpoints.flatMap((checkpoint) =>
        checkpoint.files
          .filter((file) => file.finalized)
          .map((file) => `${checkpoint.record.transferId}:${file.fileId}`),
      ),
    );
    setPrepared((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => verifiedFiles.has(key))),
    );
    const sourceIds = new Set(value.sources.map((source) => source.transferId));
    for (const id of selected.current.keys()) if (!sourceIds.has(id)) selected.current.delete(id);
    setListing(value);
  }
  useEffect(() => {
    const storage = new StorageClient();
    client.current = storage;
    let current = true;
    void storage
      .list()
      .then((value) => {
        if (current) applyListing(value);
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
    };
  }, []);
  function selectedFiles(id: string): Map<string, File> {
    let files = selected.current.get(id);
    if (!files) {
      files = new Map();
      selected.current.set(id, files);
    }
    return files;
  }
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
      ref={panel}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LOCAL TO THIS BROWSER</p>
          <h2 id="saved-title" tabIndex={-1} data-focus-target>
            Saved transfers
          </h2>
        </div>
        <span className="pill">Verified on reopen</span>
      </div>
      <p className="demo-note">
        Surviving blocks are reread and rehashed before appearing here. Partial checkpoints are
        local evidence. To resume, renew room admission, compare the new pairing code, prepare the
        original source on the owner, then choose Resume saved on the receiver. Browser eviction or
        clearing site data can remove them.
      </p>
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void action(async (storage) => {
              applyListing(await storage.list());
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
          <p className="muted">
            No retained transfers in this browser. Received checkpoints appear here after
            interruption or completion; start a room to send a new file.
          </p>
        )}
      {listing?.checkpoints.map((checkpoint) => (
        <article
          className="saved-transfer"
          key={checkpoint.record.transferId}
          data-testid="saved-checkpoint"
          data-transfer-id={checkpoint.record.transferId}
          data-verified-bytes={checkpoint.committedBytes}
          aria-labelledby={`saved-${checkpoint.record.transferId}`}
        >
          <h3 id={`saved-${checkpoint.record.transferId}`}>
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
            {readableBytes(checkpoint.committedBytes)} verified ·{' '}
            {readableBytes(checkpoint.manifest.totalBytes - checkpoint.committedBytes)} missing.
            Recovery always requires fresh pairing and the exact original source.
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
          {!checkpoint.record.receipt && (
            <button
              disabled={busy || !paired || view.status?.role !== 'receiver' || view.busy}
              onClick={() => {
                void room.resumeReceiver(checkpoint.manifest);
              }}
            >
              Resume saved {checkpoint.manifest.files[0]?.path}
            </button>
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
                          setPrepared((previous) => ({
                            ...previous,
                            [`${checkpoint.record.transferId}:${meta.fileId}`]: output,
                          }));
                          setMessage(
                            'Verified file prepared. Tap Save, Share or Choose save location below to open the system flow.',
                          );
                        });
                      }}
                    >
                      Export saved {meta.path}
                    </button>
                  )}
                  {file.finalized && prepared[`${checkpoint.record.transferId}:${meta.fileId}`] && (
                    <FileExportControls
                      file={prepared[`${checkpoint.record.transferId}:${meta.fileId}`]!}
                      path={meta.path}
                      outputName={exportNames(checkpoint.manifest.files).get(meta.fileId)!}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <button
            className="secondary"
            disabled={busy}
            aria-describedby="saved-delete-help"
            onClick={() => {
              void action(async (storage) => {
                setPrepared((previous) =>
                  Object.fromEntries(
                    Object.entries(previous).filter(
                      ([key]) => !key.startsWith(`${checkpoint.record.transferId}:`),
                    ),
                  ),
                );
                await storage.purge(checkpoint.record.transferId);
                applyListing(await storage.list());
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
          <p className="muted">
            Source metadata retained until {new Date(source.expiresAt).toLocaleString()}. Forgetting
            it does not delete a received checkpoint or the original file.
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
                      const map = selectedFiles(source.transferId);
                      map.set(file.fileId, selected);
                      setSelectedCount((count) => count + 1);
                      setMessage(
                        `Source verified: ${file.path}. Prepare the source when both devices are paired.`,
                      );
                    });
                }}
              />
            </label>
          ))}
          <button
            data-selected-count={selectedCount}
            disabled={
              busy ||
              !paired ||
              view.status?.role !== 'owner' ||
              view.busy ||
              selectedFiles(source.transferId).size !== source.manifest.files.length
            }
            onClick={() => {
              void room.resumeSource(source.manifest, [
                ...selectedFiles(source.transferId).values(),
              ]);
            }}
          >
            Prepare source {source.manifest.files[0]?.path}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void action(async (storage) => {
                selected.current.delete(source.transferId);
                await storage.removeSource(source.transferId);
                applyListing(await storage.list());
              });
            }}
          >
            Forget source {source.manifest.files[0]?.path}
          </button>
        </article>
      ))}
      {listing?.unavailable.map((item) => (
        <div className="muted" key={`${item.kind ?? 'storage'}:${item.transferId}`}>
          <p>{item.reason}</p>
          {item.kind && uuidSchema.safeParse(item.transferId).success && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                void action(async (storage) => {
                  if (item.kind === 'source') {
                    selected.current.delete(item.transferId);
                    await storage.removeSource(item.transferId);
                  } else {
                    await storage.purge(item.transferId);
                  }
                  applyListing(await storage.list());
                });
              }}
            >
              {item.kind === 'source'
                ? 'Forget unavailable source'
                : 'Delete unavailable checkpoint'}
            </button>
          )}
        </div>
      ))}
      {Boolean(listing?.cleaned) && (
        <p className="muted" role="status" aria-atomic="true">
          Removed {listing?.cleaned} expired or orphaned local storage entries.
        </p>
      )}
      <p className="muted" id="saved-delete-help">
        Delete saved removes only that browser checkpoint. Forget source removes only its source
        metadata. Exported Downloads/Files copies are outside MeshDrop cleanup.
      </p>
    </section>
  );
}
