# MeshDrop Phase 2 report — peer connectivity and secure pairing

Date: 2026-10-16. Source of truth: P2.1–P2.6 and P2 acceptance in the supplied phase-wise plan, together with the architecture's control/data-plane boundary. P0/P1 remain available and tested. Work is local; no GitHub push, cloud deployment or submission action was performed. Changes are left for the user's local commit.

**Delivery:** P2 implementation and the desktop/physical-Android ship condition are complete. The user's Oppo F19 Pro (CPH2285), Android 13, Chrome 154.0.8037.126 connected to Linux Chromium 156.0.8078.4 over a selected direct ICE path. The broader plan's Windows/Mac and Safari-on-iPhone physical demonstration has not been performed: only the supplied Linux laptop and Oppo were available. Linux WebKit engine coverage is not a substitute for an actual iPhone test. Do not claim universal browser/network compatibility or full physical-matrix completion.

## What was implemented

| Plan ticket | Delivered behavior                                                                                                                                          | Main implementation                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P2.1        | Peer session manager; one reliable ordered, protocol-labelled RTCDataChannel; explicit cleanup and timeout                                                  | `packages/peer-connection/src/PeerSession.ts`                   |
| P2.2        | Deterministic owner offer/receiver answer, trickled ICE, bounded candidates queued before remote SDP, reducer-backed states                                 | `PeerSession.ts`, `IceManager.ts`                               |
| P2.3        | Configurable STUN, approved per-session temporary coturn credentials, bounded TTL, timeout and privacy-filtered selected ICE path                           | `apps/signaling/src/routes/ice-credentials.ts`, `IceManager.ts` |
| P2.4        | Ephemeral non-extractable P-256 identity keys, signed DTLS-bound hello, full fingerprint/short code, explicit independent comparison and mismatch closure   | `PairingVerification.ts`, `PairingPanel.tsx`                    |
| P2.5        | Strict negotiated version/frame/message/hash/storage/resume capabilities, respecting SCTP and the 16 KiB protocol limit                                     | `packages/protocol/src/peer.ts`, `IceManager.ts`                |
| P2.6        | Owner-authorized atomic epoch advance, both-peer admission checks, stale ticket/message rejection, ICE restart and fresh connection with reset verification | `SessionRoom.ts`, `RoomClient.ts`, `PeerSession.ts`             |

The root application now demonstrates real peer connectivity. The old synthetic SDP probes were replaced by signed typed data-channel ping/pong. P0's isolated protocol workbench remains at `/foundation`. File selection, file frames, content hashing, committed storage progress and actual file transfer belong to P3 onward and are not advertised as working here.

## Resulting workflow

1. Owner creates an expiring invitation; receiver requests admission; owner explicitly approves or rejects.
2. Two admitted sockets cause a readiness event. Only the owner can atomically advance the connection epoch. Existing P1 authorization still protects every message.
3. Owner creates the offer and reliable ordered channel. Receiver answers, with ICE queued until the relevant remote description is installed.
4. Devices exchange signed hello messages binding public identity, random nonce, room/member/role/epoch, DTLS fingerprint and honest capabilities.
5. Both display the same transcript fingerprint/code. Users must compare independently and enter the other device's code before local verified status appears. A mismatch closes the transport.
6. Signed ping/pong proves actual data-channel transport in both directions. ICE restart/new connection increments the epoch, changes the pairing code and clears prior verification. Revoking the room closes cooperative clients' signaling and WebRTC transports.

## Security and secret handling

Static provider secrets remain confined to ignored `.env` files. `.env`/variants and `.dev.vars`/variants remain ignored at every depth; only empty-secret `.env.example` templates are tracked. `TURN_SHARED_SECRET` is never included in browser configuration, Wrangler public vars, reports or fixtures. Optional coturn usernames/HMAC passwords are temporary runtime credentials and expire within the room/TTL bound. Temporary browser signing keys are non-extractable and memory-only. No file, raw SDP, ICE address or bearer is added to room storage or ordinary logs.

The secret guard also received a correction: checking an empty secret assignment must not consume the following public configuration line as its value. Ignore/embedded-key checks remain part of local gates and CI. Live browser traces remain off, invitation evidence is masked, and path reports contain categories rather than addresses. The local relay test generated its secret in a private `/tmp/.../.env` and stopped its coturn process afterward.

A matching code is meaningful only after a separate trusted comparison. The test automation exercises the confirmation workflow; it does not attest to a real person's identity. Verification is local, and neither server approval nor WebRTC encryption alone establishes human identity. This is not a formally audited authentication protocol. Details are in the [P2 contract](../protocol/peer-p2.md).

## Validation and evidence

The final gate ran from a fresh source copy with no private environment files or existing dependencies. Frozen offline install passed; all 83 application/package/test/script source files matched the delivered workspace. The complete `pnpm check` passed with no test retries: **299 automated tests** (230 unit + 39 integration + 8 faults + 22 browser), plus the physical Android and real forced-relay scenarios.

| Gate                                            | Result                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Frozen offline install from a fresh source copy | Passed                                                                                                               |
| All package/root strict TypeScript checks       | Passed                                                                                                               |
| ESLint, Prettier, environment/secret guard      | Passed                                                                                                               |
| Unit tests                                      | 230 passed                                                                                                           |
| Worker/SQLite integration tests                 | 39 passed                                                                                                            |
| Lifecycle fault tests                           | 8 passed                                                                                                             |
| Browser acceptance tests                        | 22 passed, no retries                                                                                                |
| Web build and Worker deployment dry run         | Passed                                                                                                               |
| Actual Oppo ↔ Linux browser                     | Passed: direct path, signed ping/pong both ways, code comparison workflow, ICE restart/new connection and revocation |
| Forced actual coturn relay                      | Passed: temporary Worker credentials, both candidates relay, signed ping/pong both ways                              |

The automated coverage includes signature/key/capability tampering, wrong room/member/role/epoch/DTLS binding, code mismatch, unconfirmed comparison, unsupported capabilities, frame bounds, ICE queue overflow/order, private path categories, pending/unauthenticated ICE denial, closed-room denial, owner-only epoch CAS races, initial-mode checks, stale tickets/messages, invalid/partial TURN settings, independently verified HMAC credentials, real unanswered RTC timeout, signed ping replay closure, reconnection and browser layouts. Existing P0/P1 authorization, hibernation, expiry, cleanup and binary/protocol regressions remain in the gates.

Physical test evidence records browser versions and direct path without phone serials, IPs or secrets. Signaling was forwarded over USB, while the WebRTC data path was independently selected over Wi-Fi. Initial phone testing on a different network without a configured reachable relay timed out correctly; connecting the phone to the laptop's Wi-Fi resolved the direct-path test. No cellular/hostile-NAT deployment claim follows from this result.

The additional WebKit test uses Playwright's Ubuntu WebKit build on Arch Linux with compatibility libraries isolated under `/tmp`. Its Chromium peer uses a test-only flag disabling multicast-DNS host obfuscation because this local Linux engine pairing could not establish the default mDNS path. Firefox and the physical Oppo test use browser defaults. This harness adjustment changes neither the application nor production browser policy. Supported Ubuntu CI installs its browser dependencies normally; hosted CI has not run because nothing was pushed.

Evidence: [clean install](evidence/phase-2-install.txt), [complete gate log](evidence/phase-2-checks.txt), [physical Android result](evidence/phase-2-android.json), [forced relay result](evidence/phase-2-relay.json), [masked desktop screenshot](evidence/phase-2-desktop.png), [actual Oppo viewport](evidence/phase-2-oppo.png), [Firefox](evidence/phase-2-firefox.png), [WebKit](evidence/phase-2-webkit.png), and [mobile shell](evidence/phase-2-mobile-shell.png).

## Running and demonstrating

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173> in two independent profiles. Create/join/approve, compare codes over a separate trusted channel, then exchange signed pings. Use Restart ICE, New peer connection, Codes do not match and Revoke room to observe the state/error paths. For a physical phone or local coturn test, use the exact steps in the [connectivity runbook](../runbooks/peer-connectivity.md).

Configuration: default STUN is `stun:stun.cloudflare.com:3478`. TURN is optional and explicitly unavailable until a compatible `TURN_URLS` plus server-only `TURN_SHARED_SECRET` are configured. TURN REST lifetime defaults to 300 seconds, maximum 600 and room expiry. Partial/unsafe configuration fails closed. No provider purchase or public relay was configured.

## Limits and handoff to P3

- The requested Linux/Oppo demonstration passed. Physical Windows/Mac and Safari-on-iPhone still need hardware validation before claiming the plan's complete device matrix.
- The relay test proves real encrypted transport through isolated coturn with forced relay. A restrictive external NAT, public TURNS/TCP, cellular network or network switch was not simulated or certified.
- Shared-secret TURN credentials remain usable until their short TTL; room revocation closes cooperative clients but does not instantly revoke individual coturn credentials.
- Storage capability is memory only and resume unavailable. OPFS, persistent checkpoints, save/export, file SHA-256 and committed progress are later work. PWA background execution is not promised.
- Room and peer credentials stay memory-only. Reloading requires a new invitation. There is no account/key recovery or long-term identity persistence.
- Before adding file transfer, enforce explicit user consent and local independent verification policy; do not infer remote human verification. Keep manifest/file frames on the WebRTC plane, negotiate frame bounds including headers, apply backpressure, and retain authenticated epoch checks.

Protocol, architecture boundary, threat model, README, secret documentation, CI browser installation and reproduction runbooks were updated. Future phases must provide the same report and commit-command handoff.

## Commit command

Run locally from the repository root after reviewing the changes:

```sh
git add .
git commit -m "feat: implement phase 2 peer connectivity and secure pairing"
```

No `git push` is included or performed.
