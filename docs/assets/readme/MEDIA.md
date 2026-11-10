# README media and verification

The original captures below were recorded on **4 November 2026** from MeshDrop
application revision `1f5af25`.
The README combines a visual product walkthrough with setup, architecture,
failure handling, and independently checked results.

## Demo Video — 10 November 2026

[demo-video.mp4](demo-video.mp4) is the **4 minute 32 second**, 1920×1080
walkthrough recorded from application revision
`9aa40ba5580d064cb2de6eb99fc359fb2087cb18`. Both views remain visible with
sender/receiver labels and step captions. Its four chapters show laptop → physical
OPPO, physical OPPO → laptop, two isolated profiles on the same laptop, and physical
OPPO → an explicitly labeled emulated mobile browser.

All four transfers use the real local application, Worker, SQLite actors,
WebSockets, WebRTC, and browser file storage. Each chapter demonstrates pause/resume;
every exported archive was independently SHA-256 checked against its source.
The first archive was saved in the physical phone's Android Downloads. Phone-source
fixtures were preloaded through the local development server before recording and
selected in the real file input; transfer, storage, and verification were not mocked.

Timestamped live Playwright screenshots were composed at their original timing,
with external title cards, role labels, and captions. The poster is an extracted
frame at 66 seconds. Personal tabs and notifications were not recorded; invitation
fields remained password-masked and no private invitation QR was opened. Owned
demo tabs, screen wake locks, servers, and ADB tunnels were cleaned up, and phone
settings were unchanged. No production deployment or configuration change occurred.
This local demonstration does not certify public-network or TURN connectivity.

Exact file hashes, transfer sizes, source revision, and capture scope are in
[demo-video.json](demo-video.json). This evidence is separate from the original
4 November recordings documented below.

## What was captured

| Asset                           | Actual source                                                                                             | Verified result                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android-transfer.gif` / `.mp4` | Fresh desktop Chromium profile and a new Chrome tab on a physical OPPO F19 Pro / CPH2285, Android 13.     | 8 MiB delivery, actual native Android download retrieved with ADB, matching source/export SHA-256, matching transfer receipt, zero JavaScript page errors.            |
| `browser-transfer.gif` / `.mp4` | Two fresh Chromium profiles using the real local frontend, Worker, SQLite actors, WebSockets, and WebRTC. | 16 MiB delivery, independently checked exported bytes, matching receipt and diagnostics, zero JavaScript page errors.                                                 |
| `browser-recovery.gif` / `.mp4` | The same local application stack, with a 32 MiB fixture and an explicit ICE restart after a pause.        | 12 MiB of verified blocks reused, epoch 1 → 2, fresh code comparison, exactly 20 MiB sent on the new attempt, independently matching export, receipt and diagnostics. |
| Android WebP stills             | Native `adb exec-out screencap -p` on the actual handset, while the owned MeshDrop tab was visible.       | Real home, pairing, completed transfer, and diagnostics screens; no viewport emulation.                                                                               |
| Desktop WebP stills             | Playwright screenshots of the actual running application.                                                 | Home, pairing, completed transfer, recovery, and diagnostics views.                                                                                                   |
| `hero.svg` / `architecture.svg` | Original code-drawn vector illustrations in MeshDrop's green/cream palette.                               | Explanatory diagrams, separate from the real application captures.                                                                                                    |

Exact fixture digests, browser versions, capture timestamps, and media-file
hashes are recorded in [capture-manifest.json](capture-manifest.json).

Additional desktop stills: [Home](desktop-home.webp) · [Pairing](pairing.webp) ·
[Verified file](verified.webp) · [Recovery](recovery.webp) ·
[Browser insights](browser-insights.webp).

## How the recordings were made

The desktop clips use Playwright's browser video capture. The handset firmware
does not provide Android's `screenrecord` binary, so the phone video uses timed
CDP screenshots of the **live tab on the real handset**, assembled using their
observed timestamps. Capture attempts approximately every 170 ms; actual frame
spacing includes device and transport latency. This is a sampled live screen
recording, rather than native high-frame-rate video or a sequence of recreated
screens. The separate phone stills come directly from Android's screenshot API.

FFmpeg combines the real sender and receiver views and adds an external title
bar. The Android composite trims desktop setup before the phone frame recording
begins. MP4 playback preserves the captured timing; GIFs run at **1.35×** and
**7 fps** for a smaller README preview. WebP stills are re-encoded from captured
PNGs. No application state, transfer result, progress counter, or measurement
was painted into the UI. All fixtures are synthetic. Pairing-code comparison is
automated for demonstration; this does not establish a real person's identity.

## Isolation and privacy

- Capture servers used a dedicated loopback frontend and local Worker, with
  separate temporary configuration, Vite cache, SQLite persistence, and no
  provider/operator secrets. Existing application services were left running.
- Desktop contexts were fresh. The Android connector attached only to new demo
  tabs; personal Chrome tabs were not inspected or recorded.
- The local phone app used an ADB reverse tunnel for HTTP/WebSocket access.
  This run does **not** certify a public network, mobile-data path, TURN relay,
  or USB-independent transport.
- Invitation fields remained password-masked. No invitation QR was opened, no
  raw browser trace was published, and every completed demo room was revoked.
- Only the exact synthetic Android download created by the capture was pulled
  and removed. The phone's network, display, and Developer options settings were
  not changed by the capture script.
- Temporary ADB mappings and demo tabs are cleaned up after capture. Raw
  recordings, downloads, receipts, and local runtime state stay outside Git.

The application files were not modified for the recordings. These are focused
README demonstrations; the **642-test** full application gate cited by the
README is the separately dated **25–26 October 2026** result, not a fresh full
suite run. Broader platform, native export/install, and public-network limits
remain in the [support matrix](../../support-matrix.md).
