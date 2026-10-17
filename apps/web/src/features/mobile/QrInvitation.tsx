import type { BinaryBitmap, Result } from '@zxing/library';
import { useEffect, useRef, useState } from 'react';
import { parseInvitation } from '../pairing/RoomClient';
interface ScanControls {
  stop(): void;
}
interface QrLibrary {
  BrowserQRCodeSvgWriter: new () => {
    write(content: string, width: number, height: number): SVGSVGElement;
  };
  BrowserQRCodeReader: new () => {
    decodeFromStream(
      stream: MediaStream,
      video: HTMLVideoElement,
      callback: (
        result: { getText(): string } | undefined,
        error: unknown,
        controls: ScanControls,
      ) => void,
    ): Promise<ScanControls>;
  };
}
let loading: Promise<QrLibrary> | null = null;
export function loadQrLibrary(): Promise<QrLibrary> {
  // A pinned, lockfile-audited lazy chunk, served only by this origin.
  loading ??= Promise.all([import('@zxing/browser'), import('@zxing/library')])
    .then(([browser, { DecodeHintType }]) => ({
      BrowserQRCodeSvgWriter: browser.BrowserQRCodeSvgWriter,
      BrowserQRCodeReader: class extends browser.BrowserQRCodeReader {
        constructor() {
          super(new Map([[DecodeHintType.TRY_HARDER, true]]));
        }
        override decodeBitmap(bitmap: BinaryBitmap): Result {
          try {
            return super.decodeBitmap(bitmap);
          } catch {
            // One bounded fallback for front-facing codes with a quiet border.
            // Perspective detection remains the first attempt for camera images.
            return this.reader.decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]]));
          }
        }
      },
    }))
    .catch(() => {
      loading = null;
      throw new Error('Local QR tools could not load. Paste the invitation link instead.');
    });
  return loading;
}
export function PrivateQr({ invitation }: { invitation: string }) {
  const [shown, setShown] = useState(false),
    [error, setError] = useState('');
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    target.current?.replaceChildren();
    if (shown)
      void loadQrLibrary()
        .then((library) => {
          if (current && target.current) {
            const svg = new library.BrowserQRCodeSvgWriter().write(invitation, 280, 280);
            svg.setAttribute('viewBox', '0 0 280 280');
            svg.setAttribute('role', 'img');
            svg.setAttribute('aria-label', 'Private room invitation QR code');
            target.current.replaceChildren(svg);
          }
        })
        .catch(() => {
          if (current) setError('QR display is unavailable. Copy the private invitation instead.');
        });
    return () => {
      current = false;
      target.current?.replaceChildren();
    };
  }, [invitation, shown]);
  return (
    <div className="private-qr">
      <button
        className="secondary"
        onClick={() => {
          setShown(!shown);
          setError('');
        }}
      >
        {shown ? 'Hide private QR' : 'Show private QR'}
      </button>
      {shown && (
        <>
          <p className="muted">
            This QR grants invitation access. Show it only to your intended receiver. Owner approval
            and independent code comparison are still required.
          </p>
          <div ref={target} data-testid="invitation-qr" className="qr-image" />
        </>
      )}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
export function CameraInvitation({ onInvitation }: { onInvitation(value: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const controls = useRef<ScanControls | null>(null);
  const generation = useRef(0);
  const [active, setActive] = useState(false),
    [message, setMessage] = useState('');
  function stop() {
    generation.current++;
    controls.current?.stop();
    controls.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setActive(false);
  }
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    const leaving = () => stop();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leaving);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leaving);
    };
  }, []);
  async function scan() {
    stop();
    setMessage('');
    setActive(true);
    const request = generation.current;
    try {
      const library = await loadQrLibrary();
      if (request !== generation.current) return;
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 } },
        audio: false,
      });
      if (request !== generation.current) {
        for (const track of camera.getTracks()) track.stop();
        return;
      }
      stream.current = camera;
      const scanner = await new library.BrowserQRCodeReader().decodeFromStream(
        camera,
        video.current!,
        (result, _error, session) => {
          if (request !== generation.current || !result) return;
          try {
            const value = result.getText();
            parseInvitation(value);
            session.stop();
            stop();
            onInvitation(value);
            setMessage(
              'Invitation scanned. Request to join when you are ready; scanning does not approve a peer.',
            );
          } catch {
            setMessage(
              'That QR is not a MeshDrop invitation from this site. Scan the owner’s invitation or paste its link.',
            );
          }
        },
      );
      if (request !== generation.current) scanner.stop();
      else controls.current = scanner;
    } catch {
      if (request === generation.current) {
        stop();
        setMessage(
          'Camera scanning could not start. Check camera permission, use HTTPS or loopback, or paste the invitation link.',
        );
      }
    }
  }
  const supported =
    globalThis.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
  return (
    <div className="camera-invitation">
      <button
        type="button"
        className="secondary"
        disabled={!supported || active}
        onClick={() => {
          void scan();
        }}
      >
        Scan invitation with camera
      </button>
      {active && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            stop();
            setMessage('Camera stopped. You can paste the invitation instead.');
          }}
        >
          Stop camera
        </button>
      )}
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        hidden={!active}
        aria-label="Invitation camera preview"
      />
      {!supported && (
        <p className="muted">
          Camera scanning is unavailable in this browser mode. Paste the invitation link.
        </p>
      )}
      {message && (
        <p role="status" data-testid="camera-status">
          {message}
        </p>
      )}
    </div>
  );
}
