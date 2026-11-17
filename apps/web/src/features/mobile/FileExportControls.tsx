import { useEffect, useRef, useState } from 'react';
import {
  canShareFile,
  shareVerifiedFile,
  saveVerifiedFileWithPicker,
  startFileDownload,
} from '@meshdrop/storage';
import type { ExportOutcome } from '@meshdrop/storage';
export function FileExportControls({
  file,
  path,
  outputName = path,
}: {
  file: File;
  path: string;
  outputName?: string;
}) {
  const releases = useRef<(() => void)[]>([]);
  const [result, setResult] = useState<ExportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useEffect(
    () => () => {
      for (const release of releases.current) release();
      releases.current = [];
    },
    [file],
  );
  const hasPicker =
    typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
  function action(route: ExportOutcome['route'], operation: () => Promise<ExportOutcome>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setResult(null);
    // Invoke before yielding: Safari requires share/picker to start during this user gesture.
    void operation()
      .then(setResult)
      .catch(() =>
        setResult({
          status: 'failed',
          route,
          nativeExportVerified: false,
          message:
            'Export could not finish. The verified browser copy remains available; try saving again.',
        }),
      )
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  }
  return (
    <div className="file-export-controls">
      {outputName !== path.split('/').at(-1) && <p className="muted">Export name: {outputName}</p>}
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            try {
              releases.current.push(startFileDownload(file, outputName));
              setResult({
                status: 'started',
                route: 'download',
                nativeExportVerified: false,
                message:
                  'Download requested. On iPhone, use the download or share menu to Save to Files. Check your saved copy before clearing browser data.',
              });
            } catch {
              setResult({
                status: 'failed',
                route: 'download',
                nativeExportVerified: false,
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
            onClick={() =>
              action('save-picker', () => saveVerifiedFileWithPicker(file, outputName))
            }
          >
            Choose save location for {path}
          </button>
        )}
        {canShareFile(file, outputName) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => action('system-share', () => shareVerifiedFile(file, outputName))}
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
          data-export-status={result.status}
          data-export-route={result.route}
          data-native-export-verified={String(result.nativeExportVerified)}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
