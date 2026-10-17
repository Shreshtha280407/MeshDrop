# Phase 8 abuse verification

Use a regular local browser and the supported Node/pnpm versions in the README. Run only against your own local test environment. No provider account or physical phone is needed for the P8 gate.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm audit:release
pnpm bench:p8
pnpm check
```

`bench:p8` runs deterministic fuzz/property/input/queue checks, actual local Worker/SQLite/WebSocket admission and abuse tests, six Chromium demonstrations, and five production CSP/privacy/PWA cases. Playwright starts or reuses loopback development services; production tests build a separate preview on 4173 with Worker 8788. The security project writes `.meshdrop-artifacts/phase-8/security.json`; the normal browser reporter writes ignored local results. Use `PLAYWRIGHT_BROWSERS_PATH`/`LD_LIBRARY_PATH` only when your local browser installation requires them. A missing browser executable or unavailable audit registry is an environment failure, not a passed gate.

The seeds are fixed in `packages/protocol/tests/fuzz/messages.spec.ts` (`0xc0ffee`) and `packages/recovery/tests/property/ranges.spec.ts` (`0x8badf00d`). Arbitrary bounded byte/JSON cases may either reject or round-trip; invalid-header/geometry, SDP/ICE byte limits, strict metadata and range rejection cases make explicit assertions. Assertion failures are not swallowed as parser rejection.

## Observe the exit demonstration

For an interactive run with a desktop display:

```sh
pnpm exec playwright test tests/e2e/security-abuse.spec.ts --project chromium --headed --workers 1 --retries 0
```

1. Two independent browser profiles create, approve and independently compare a room. A third profile requests admission using the consumed invitation, receives HTTP 409 and cannot disturb the approved pair. The screenshot clears the pasted invitation first.
2. Real WebRTC DATA frames are changed in transit to an unsupported version, excessive fragment count and out-of-order fragment. Each case fails with zero committed bytes and no save control; malformed content cannot earn a storage ACK.
3. Two different directory labels with the same basename export as separate names. The harness checks independently read download bytes against their different source content.
4. A simulated compromised signaling source floods a real client's receive handler. The bounded queue closes signaling instead of retaining unbounded tasks.

Production checks block inline script and a foreign-origin canary request while local lazy QR still loads. Another real HTTP canary receives navigation without a Referer header. CDP verifies clean navigation-entry URLs; Chromium's residual `userTypedURL` is documented rather than misrepresented as erased.

Do not record private invitations, QR codes, provider environment contents, live Authorization/subprotocol headers or personal files. Automatic traces/video/screenshots are off. Review raw failures/reports before sharing; only the selected sanitized report evidence should be copied into Git. The P7 physical iPhone gate and P9 public deployment/relay/operational gates remain separate.
