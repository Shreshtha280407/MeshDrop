import { useEffect, useRef, useState } from 'react';
import {
  canShareFile,
  shareVerifiedFile,
  saveVerifiedFileWithPicker,
  startFileDownload,
} from '@meshdrop/storage';
import type { ExportOutcome } from '@meshdrop/storage';
export function FileExportControls({ file, path }: { file: File; path: string }) {
  const releases = useRef<(() => void)[]>([]);
  const [result, setResult] = useState<ExportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      for (const release of releases.current) release();
      releases.current = [];
    },
    [file],
  );
  const hasPicker =
    typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
  function action(operation: () => Promise<ExportOutcome>) {
    setBusy(true);
    setResult(null);
    // Invoke before yielding: Safari requires share/picker to start during this user gesture.
    void operation()
      .then(setResult)
      .finally(() => setBusy(false));
  }
  return (
    <div className="file-export-controls">
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            try {
              releases.current.push(startFileDownload(file, path));
              setResult({
                status: 'started',
                message:
                  'Download requested. On iPhone, use the download or share menu to Save to Files. Check your saved copy before clearing browser data.',
              });
            } catch {
              setResult({
                status: 'failed',
                message:
                  'The download could not start. The verified browser copy remains available.',
              });
            }
          }}
        >
          Save {path}
        </button>
        {hasPicker && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => action(() => saveVerifiedFileWithPicker(file, path))}
          >
            Choose save location for {path}
          </button>
        )}
        {canShareFile(file, path) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => action(() => shareVerifiedFile(file, path))}
          >
            Share or save to Files: {path}
          </button>
        )}
      </div>
      {result && (
        <p
          role="status"
          className={result.status === 'failed' ? 'error' : 'muted'}
          data-testid="file-export-result"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
