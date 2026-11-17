// Production UI with controlled display props only. This fixture grants no room,
// pairing, storage or release authority and proves no successful file transfer.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { INITIAL_PEER } from '../../packages/peer-connection/src';
import { INITIAL_TRANSFER } from '../../packages/transfer-core/src';
import type { TransferView } from '../../packages/transfer-core/src';
import type { CapabilityResult } from '../../packages/platform/src';
import { RoomClient } from '../../apps/web/src/features/pairing/RoomClient';
import type { RoomView } from '../../apps/web/src/features/pairing/RoomClient';
import { PairingPanel } from '../../apps/web/src/features/pairing/PairingPanel';
import { TransferPanel } from '../../apps/web/src/features/transfer/TransferPanel';
import { PwaPanel } from '../../apps/web/src/features/mobile/PwaPanel';
import { NetworkPanel } from '../../apps/web/src/features/network-intelligence/NetworkPanel';
import { DiagnosticsSession } from '../../packages/network-intelligence/src';
import '../../apps/web/src/style.css';

import type { A11yState } from './accessibility-contract';
const id = '10000000-0000-4000-8000-000000000001';
const capabilities: CapabilityResult = {
  worker: 'available',
  opfs: 'available',
  checkpointDb: 'available',
  exclusiveAccess: true,
  secureContext: true,
  crypto: 'available',
  webRtc: true,
  savePicker: false,
  filePicker: true,
  persistentStorage: false,
  estimatedFreeBytes: 1024 ** 3,
  camera: { supported: false, permission: 'unknown' },
  shareFiles: false,
  pwaMode: 'browser',
  serviceWorker: true,
  backgroundRisk: 'foreground-required',
};
declare global {
  interface Window {
    a11yFixture: {
      state(name: A11yState): void;
      update(value: Partial<TransferView>): void;
      hold(value: boolean): void;
      actions: string[];
    };
  }
}
function Fixture() {
  const initial = new RoomClient().getSnapshot();
  const [view, setView] = useState<RoomView>({
    ...initial,
    connection: 'connected',
    status: {
      roomId: id,
      peerId: id,
      role: 'receiver',
      approval: 'approved',
      state: 'approved',
      epoch: 1,
      revision: 1,
      expiresAt: 2000000000000,
      nextSeq: 0,
    },
    peer: {
      ...INITIAL_PEER,
      state: 'connected',
      epoch: 1,
      ready: true,
      remoteVerified: true,
      verification: 'verified',
      code: 'ABCD-EFGH-JKLM-NPQR',
      capabilities: {
        protocolVersion: 1,
        preferredFrameBytes: 16384,
        maxMessageBytes: 65536,
        supportedHashes: ['SHA-256'],
        storageModes: ['opfs'],
        resumeMode: 'persistent',
      },
    },
  });
  const [roomOpen, setRoomOpen] = useState(false);
  const actions = window.a11yFixture?.actions ?? [];
  let held = false;
  let release: (() => void) | undefined;
  const invoke = async (name: string) => {
    actions.push(name);
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  const client = {
    confirmComparison: () => {
      actions.push('comparison');
    },
    rejectComparison: () => {
      actions.push('mismatch');
    },
    sendPing: () => invoke('ping'),
    requestConnection: () => invoke('connection'),
    retryConnection: () => invoke('retry'),
    pauseFiles: () => invoke('pause'),
    retryStorage: () => invoke('storage'),
    cancelFiles: () => invoke('cancel'),
    clearTransfer: async () => {
      await invoke('clear');
      setView((v) => ({ ...v, transfer: INITIAL_TRANSFER }));
    },
    rejectFiles: () => invoke('decline'),
    acceptFiles: () => invoke('accept'),
    offerFiles: () => invoke('offer'),
    resumeCurrent: () => invoke('resume'),
    setRetention: () => {
      actions.push('retention');
    },
    verifiedFile: () => undefined,
    saveReceipt: () => {
      actions.push('receipt');
    },
    deleteDiagnostics: () => invoke('delete-report'),
  } as unknown as RoomClient;
  window.a11yFixture = {
    actions,
    hold(value) {
      held = value;
      if (!value) release?.();
    },
    update(value) {
      setView((v) => ({ ...v, transfer: { ...v.transfer, ...value } }));
    },
    state(name) {
      setRoomOpen(name === 'pairing');
      const state: TransferView['state'] =
        name === 'offer'
          ? 'negotiating'
          : name === 'verification'
            ? 'verifying'
            : name === 'completed'
              ? 'complete'
              : name === 'error'
                ? 'failed'
                : name === 'recovery'
                  ? 'reconnecting'
                  : name === 'storage-full'
                    ? 'paused'
                    : name === 'pairing'
                      ? null
                      : name;
      setView((v) => ({
        ...v,
        peer: {
          ...v.peer,
          verification: name === 'pairing' ? 'unverified' : 'verified',
          remoteVerified: name !== 'pairing',
        },
        transfer: {
          ...INITIAL_TRANSFER,
          state,
          direction: 'receive',
          manifest:
            name === 'pairing'
              ? null
              : {
                  version: 1,
                  revision: 1,
                  transferId: id,
                  blockBytes: 1048576,
                  totalBytes: 2097152,
                  files: [
                    {
                      fileId: id,
                      path: 'fixture-' + 'long-name-'.repeat(16) + '.bin',
                      size: 2097152,
                      sha256: '0'.repeat(64),
                    },
                  ],
                },
          committedBytes: name === 'completed' ? 2097152 : 1048576,
          localPaused: name === 'paused',
          storageFull: name === 'storage-full',
          error:
            name === 'error'
              ? 'Stored data could not be verified. Recheck the saved checkpoint before resuming.'
              : '',
          recovery:
            name === 'recovery'
              ? 'Recheck saved blocks and prepare the exact original source.'
              : '',
        },
      }));
    },
  };
  return (
    <main id="fixture-main">
      <h1>Accessibility component fixture</h1>
      <PairingPanel client={client} view={view} />
      <TransferPanel client={client} view={view} capabilities={capabilities} />
      <NetworkPanel
        client={client}
        view={{ diagnostics: diagnostics.getSnapshot(), diagnosticsError: '' }}
      />
      <PwaPanel roomOpen={roomOpen} />
      <a href="#fixture-main">End of fixture</a>
    </main>
  );
}
const diagnostics = new DiagnosticsSession({
  transferId: id,
  role: 'receiver',
  epoch: 1,
  autoStart: false,
  probe: async () => ({
    iceRttMs: 10,
    applicationRttMs: 20,
    bufferedBytes: 0,
    path: 'direct',
    candidateState: 'succeeded',
    reason: 'unsupported',
  }),
});
diagnostics.observe({
  transferId: id,
  epoch: 1,
  state: 'active',
  committedBytes: 1048576,
  reusedBytes: 0,
  attemptPayloadBytes: 1048576,
  paused: false,
  storageFull: false,
  recoveryAccepted: false,
});
diagnostics.capture({
  iceRttMs: 10,
  applicationRttMs: 20,
  bufferedBytes: 0,
  path: 'direct',
  candidateState: 'succeeded',
  reason: 'unsupported',
});
createRoot(document.getElementById('root')!).render(<Fixture />);
