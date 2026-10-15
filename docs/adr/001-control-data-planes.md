# ADR-001: Separate control and data planes

Status: accepted for P0, 2026-10-16.

The remote service authorizes rooms and relays bounded SDP/ICE messages. Browsers stream encrypted file frames over WebRTC; TURN is a separately operated encrypted relay fallback. Neither the Worker nor room actor receives ordinary file data, block ACKs, detailed filenames, manifests, or local diagnostic reports.

This avoids cloud file storage and ties progress to receiver commits. Transfers require both devices and depend on browser lifetime, network reachability, and local storage. A PWA does not promise background delivery. TURN needs an explicit bandwidth budget in later phases.

P0 evidence: strict signaling payloads reject file fields; Worker unknown/upload routes return 404; protocol imports have a lint boundary. These checks do not replace P1 authorization or P8 hardening.
