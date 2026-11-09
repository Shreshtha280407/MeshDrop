import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fileControlSchema, VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { FileControlInput, TransferManifest } from '@meshdrop/protocol';
import { TransferMachine } from '../../packages/transfer-core/src/TransferMachine';
import { manifestDigest } from '../../packages/transfer-core/src/Manifest';
import type { HashStorage } from '../../packages/transfer-core/src/HashWorker';
import { HashWorker } from '../../packages/transfer-core/src/HashWorker';

const emptyHash = createHash('sha256').digest('hex');
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
function scope(input: FileControlInput) {
  return fileControlSchema.parse({
    ...input,
    version: 1,
    roomId: randomUUID(),
    peerId: randomUUID(),
    epoch: 1,
    transcript: 'f'.repeat(64),
    messageId: randomUUID(),
    seq: 0,
  });
}
function create(
  role: 'owner' | 'receiver',
  send: (input: FileControlInput) => Promise<void> = async () => {},
  epoch = 1,
) {
  const controls: FileControlInput[] = [];
  const changes = vi.fn();
  const store: HashStorage = {
    prepareSources: async (entries) =>
      entries.map((entry) => ({
        fileId: entry.fileId,
        path: entry.path,
        size: 0,
        sha256: emptyHash,
      })),
    sourceBlock: async () => {
      throw new Error('An empty file has no blocks.');
    },
    prepareReceiver: async () => {},
    commitBlock: async () => {},
    finalizeFile: async () => ({ file: new File([], 'empty.bin'), sha256: emptyHash }),
    dispose: () => {},
  };
  const machine = new TransferMachine({
    role,
    epoch,
    frameBytes: 16384,
    createStorage: () => store,
    purgeStorage: async () => {},
    onChange: changes,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async (input) => {
        controls.push(input);
        await send(input);
      },
    },
  });
  return { machine, store, controls, changes };
}

it('a disposed receiver cannot publish a late offer after asynchronous manifest hashing', async () => {
  const h = create('receiver');
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: VERIFICATION_BLOCK_BYTES,
    totalBytes: 0,
    files: [{ fileId: randomUUID(), path: 'empty.bin', size: 0, sha256: emptyHash }],
  };
  const digest = await manifestDigest(manifest);
  const gate = barrier();
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const hashing = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    await gate.promise;
    return original(...args);
  });
  try {
    const receiving = h.machine.receiveControl(
      scope({
        type: 'TRANSFER_OFFER',
        transferId: manifest.transferId,
        payload: { manifest, manifestDigest: digest },
      }),
    );
    await h.machine.dispose(false);
    const changes = h.changes.mock.calls.length;
    gate.release();
    await receiving;
    expect(h.machine.snapshot.state).toBeNull();
    expect(h.changes).toHaveBeenCalledTimes(changes);
  } finally {
    gate.release();
    hashing.mockRestore();
    await h.machine.dispose();
  }
});

it.each(['BLOCK_ACK', 'FLOW_STATE', 'TRANSFER_FINALIZE', 'RESUME_HELLO'] as const)(
  'epoch 1 %s cannot mutate an epoch 2 transfer',
  async (type) => {
    const h = create('owner', undefined, 2);
    try {
      await h.machine.offer([new File([], 'empty.bin')]);
      const manifest = h.machine.snapshot.manifest!;
      const digest = await manifestDigest(manifest);
      const input: FileControlInput =
        type === 'BLOCK_ACK'
          ? {
              type,
              transferId: manifest.transferId,
              payload: {
                fileId: manifest.files[0]!.fileId,
                blockIndex: 0,
                digest: emptyHash,
                committedBytes: 1,
              },
            }
          : type === 'FLOW_STATE'
            ? { type, transferId: manifest.transferId, payload: { paused: true } }
            : type === 'TRANSFER_FINALIZE'
              ? { type, transferId: manifest.transferId, payload: { manifestDigest: digest } }
              : {
                  type,
                  transferId: manifest.transferId,
                  payload: {
                    attemptId: randomUUID(),
                    manifestDigest: digest,
                    checkpointDigest: 'a'.repeat(64),
                  },
                };
      const before = h.machine.snapshot;
      const changes = h.changes.mock.calls.length;
      await h.machine.receiveControl(scope(input));
      expect(h.machine.snapshot).toBe(before);
      expect(h.changes).toHaveBeenCalledTimes(changes);
      expect(h.machine.snapshot.receipt).toBeNull();
    } finally {
      await h.machine.dispose();
    }
  },
);

it('cancellation during receipt ACK signing cannot publish a late successful receipt', async () => {
  const gate = barrier();
  const h = create('owner', async (input) => {
    if (input.type === 'RECEIPT_ACK') await gate.promise;
  });
  try {
    await h.machine.offer([new File([], 'empty.bin')]);
    const manifest = h.machine.snapshot.manifest!;
    const digest = await manifestDigest(manifest);
    await h.machine.receiveControl(
      scope({
        type: 'TRANSFER_ACCEPT',
        transferId: manifest.transferId,
        payload: { manifestDigest: digest, destination: 'browser-temporary' },
      }),
    );
    await vi.waitFor(() => expect(h.controls.some((c) => c.type === 'FILE_END')).toBe(true));
    await h.machine.receiveControl(
      scope({
        type: 'FILE_VERIFIED',
        transferId: manifest.transferId,
        payload: { fileId: manifest.files[0]!.fileId, sha256: emptyHash, storageFinalized: true },
      }),
    );
    await vi.waitFor(() =>
      expect(h.controls.some((c) => c.type === 'TRANSFER_FINALIZE')).toBe(true),
    );
    const receiving = h.machine.receiveControl(
      scope({
        type: 'TRANSFER_RECEIPT',
        transferId: manifest.transferId,
        payload: {
          receiptId: randomUUID(),
          transferId: manifest.transferId,
          manifestDigest: digest,
          epoch: 1,
          totalBytes: 0,
          files: manifest.files,
          destination: 'browser-temporary',
          completedAt: new Date().toISOString(),
        },
      }),
    );
    await vi.waitFor(() => expect(h.controls.some((c) => c.type === 'RECEIPT_ACK')).toBe(true));
    await h.machine.cancel(false);
    const changes = h.changes.mock.calls.length;
    gate.release();
    await receiving;
    expect(h.machine.snapshot.state).toBe('cancelled');
    expect(h.machine.snapshot.receipt).toBeNull();
    expect(h.changes).toHaveBeenCalledTimes(changes);
  } finally {
    gate.release();
    await h.machine.dispose();
  }
});

it('cancel during receiver receipt persistence cannot publish completion afterward', async () => {
  const h = create('receiver');
  const gate = barrier();
  let persisting = false;
  h.store.rememberReceipt = async () => {
    persisting = true;
    await gate.promise;
  };
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: VERIFICATION_BLOCK_BYTES,
    totalBytes: 0,
    files: [{ fileId: randomUUID(), path: 'empty.bin', size: 0, sha256: emptyHash }],
  };
  try {
    const digest = await manifestDigest(manifest);
    await h.machine.receiveControl(
      scope({
        type: 'TRANSFER_OFFER',
        transferId: manifest.transferId,
        payload: { manifest, manifestDigest: digest },
      }),
    );
    await h.machine.accept();
    await h.machine.receiveControl(
      scope({
        type: 'FILE_END',
        transferId: manifest.transferId,
        payload: { fileId: manifest.files[0]!.fileId },
      }),
    );
    await h.machine.receiveControl(
      scope({
        type: 'TRANSFER_FINALIZE',
        transferId: manifest.transferId,
        payload: { manifestDigest: digest },
      }),
    );
    const receipt = h.machine.snapshot.receipt!;
    const receiving = h.machine.receiveControl(
      scope({
        type: 'RECEIPT_ACK',
        transferId: manifest.transferId,
        payload: { receiptId: receipt.receiptId, manifestDigest: digest },
      }),
    );
    await vi.waitFor(() => expect(persisting).toBe(true));
    await h.machine.cancel(false);
    const changes = h.changes.mock.calls.length;
    gate.release();
    await receiving;
    expect(h.machine.snapshot.state).toBe('cancelled');
    expect(h.machine.snapshot.receipt).toBeNull();
    expect(h.changes).toHaveBeenCalledTimes(changes);
  } finally {
    gate.release();
    await h.machine.dispose();
  }
});

it('a hash/storage worker error rejects its one pending request and cannot accept later work', async () => {
  const workers: LocalWorker[] = [];
  class LocalWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage() {}
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', LocalWorker);
  const storage = new HashWorker();
  const created = workers[0]!;
  try {
    const pending = storage.sourceBlock(randomUUID(), 0);
    const rejected = expect(pending).rejects.toThrow('stopped');
    created.onerror?.();
    await rejected;
    expect(created.terminate).toHaveBeenCalledTimes(1);
    await expect(storage.sourceBlock(randomUUID(), 0)).rejects.toThrow('closed');
  } finally {
    storage.dispose();
    vi.unstubAllGlobals();
  }
});
