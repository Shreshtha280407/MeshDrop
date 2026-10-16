import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fileControlSchema, VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import type { FileControlInput, TransferManifest, TransferFile } from '@meshdrop/protocol';
import { TransferMachine } from '../../packages/transfer-core/src/TransferMachine';
import { encodeTransferFrame } from '../../packages/transfer-core/src/FrameCodec';
import type { HashStorage, SourceEntry } from '../../packages/transfer-core/src/HashWorker';
import { manifestDigest } from '../../packages/transfer-core/src/Manifest';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const context = {
  version: 1,
  roomId: randomUUID(),
  peerId: randomUUID(),
  epoch: 1,
  transcript: 'f'.repeat(64),
};
let seq = 0;
function message(input: FileControlInput) {
  return fileControlSchema.parse({ ...context, ...input, messageId: randomUUID(), seq: seq++ });
}
function fakeStorage(): HashStorage & {
  commitBlock: ReturnType<typeof vi.fn>;
  finalizeFile: ReturnType<typeof vi.fn>;
} {
  const files = new Map<string, File>();
  const chunks = new Map<string, Uint8Array[]>();
  const meta = new Map<string, TransferFile>();
  return {
    prepareSources: async (entries: SourceEntry[]) =>
      Promise.all(
        entries.map(async (entry) => {
          files.set(entry.fileId, entry.file);
          return {
            fileId: entry.fileId,
            path: entry.path,
            size: entry.file.size,
            sha256: sha(new Uint8Array(await entry.file.arrayBuffer())),
          };
        }),
      ),
    sourceBlock: async (fileId, index) => {
      const file = files.get(fileId)!;
      const bytes = new Uint8Array(
        await file
          .slice(index * VERIFICATION_BLOCK_BYTES, (index + 1) * VERIFICATION_BLOCK_BYTES)
          .arrayBuffer(),
      );
      return { bytes, digest: sha(bytes) };
    },
    prepareReceiver: async (_key, entries) => {
      for (const entry of entries) {
        meta.set(entry.fileId, entry);
        chunks.set(entry.fileId, []);
      }
    },
    commitBlock: vi.fn(
      async (fileId: string, _index: number, bytes: Uint8Array, digest: string) => {
        if (sha(bytes) !== digest) throw new Error('Corrupt block');
        chunks.get(fileId)!.push(bytes.slice());
      },
    ),
    finalizeFile: vi.fn(async (fileId: string) => {
      const file = new File(
        chunks.get(fileId)!.map((chunk) => new Uint8Array(chunk)),
        meta.get(fileId)!.path,
      );
      return { file, sha256: sha(new Uint8Array(await file.arrayBuffer())) };
    }),
    dispose: () => {},
  };
}
function harness(role: 'owner' | 'receiver', storage = fakeStorage()) {
  const controls: FileControlInput[] = [];
  const frames: Uint8Array[] = [];
  const purged = vi.fn(async () => {});
  const machine = new TransferMachine({
    role,
    epoch: 1,
    frameBytes: 16384,
    onChange: () => {},
    createStorage: () => storage,
    purgeStorage: purged,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: (bytes) => {
        frames.push(bytes);
      },
      sendControl: async (control) => {
        controls.push(control);
      },
    },
  });
  return { machine, storage, controls, frames, purged };
}
async function receiverWith(bytes: Uint8Array) {
  const h = harness('receiver');
  const fileId = randomUUID();
  const transferId = randomUUID();
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    blockBytes: VERIFICATION_BLOCK_BYTES,
    transferId,
    files: [{ fileId, path: 'test.bin', size: bytes.length, sha256: sha(bytes) }],
    totalBytes: bytes.length,
  };
  const digest = await manifestDigest(manifest);
  await h.machine.receiveControl(
    message({ type: 'TRANSFER_OFFER', transferId, payload: { manifest, manifestDigest: digest } }),
  );
  await h.machine.accept();
  return { ...h, manifest, digest, fileId, transferId };
}
it('reports no progress from queued sends and rejects a false block ACK', async () => {
  const h = harness('owner');
  try {
    await h.machine.offer([new File([new Uint8Array([1, 2, 3])], 'a.bin')]);
    const manifest = h.machine.snapshot.manifest!;
    const digest = await manifestDigest(manifest);
    await h.machine.receiveControl(
      message({
        type: 'TRANSFER_ACCEPT',
        transferId: manifest.transferId,
        payload: { manifestDigest: digest, destination: 'browser-temporary' },
      }),
    );
    await vi.waitFor(() => expect(h.frames.length).toBe(1));
    expect(h.machine.snapshot.committedBytes).toBe(0);
    await h.machine.receiveControl(
      message({
        type: 'BLOCK_ACK',
        transferId: manifest.transferId,
        payload: {
          fileId: manifest.files[0]!.fileId,
          blockIndex: 0,
          digest: '0'.repeat(64),
          committedBytes: 3,
        },
      }),
    );
    expect(h.machine.snapshot.state).toBe('failed');
    expect(h.machine.snapshot.committedBytes).toBe(0);
    expect(h.machine.snapshot.receipt).toBeNull();
  } finally {
    await h.machine.dispose();
  }
});
it('ACK waits for verified storage commit and finalization failure cannot produce a receipt', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const h = await receiverWith(bytes);
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.storage.commitBlock.mockImplementationOnce(async () => barrier);
  try {
    await h.machine.receiveControl(
      message({
        type: 'BLOCK_START',
        transferId: h.transferId,
        payload: { fileId: h.fileId, blockIndex: 0, bytes: 3, digest: sha(bytes) },
      }),
    );
    const commit = h.machine.receiveFrame(
      encodeTransferFrame({
        transferId: h.transferId,
        fileId: h.fileId,
        epoch: 1,
        blockIndex: 0,
        blockOffset: 0,
        sequence: 0,
        fragmentIndex: 0,
        fragmentCount: 1,
        payload: bytes,
      }),
    );
    await vi.waitFor(() => expect(h.storage.commitBlock).toHaveBeenCalled());
    expect(h.machine.snapshot.committedBytes).toBe(0);
    expect(h.controls.some((control) => control.type === 'BLOCK_ACK')).toBe(false);
    release();
    await commit;
    expect(h.machine.snapshot.committedBytes).toBe(3);
    expect(h.controls.some((control) => control.type === 'BLOCK_ACK')).toBe(true);
    h.storage.finalizeFile.mockRejectedValueOnce(new Error('Stored bytes changed'));
    await h.machine.receiveControl(
      message({ type: 'FILE_END', transferId: h.transferId, payload: { fileId: h.fileId } }),
    );
    expect(h.machine.snapshot.state).toBe('failed');
    expect(h.controls.some((control) => control.type === 'TRANSFER_RECEIPT')).toBe(false);
    expect(h.purged).toHaveBeenCalled();
  } finally {
    release();
    await h.machine.dispose();
  }
});
it('corrupt blocks never advance receiver progress or acknowledge storage', async () => {
  const h = await receiverWith(new Uint8Array([9]));
  try {
    await h.machine.receiveControl(
      message({
        type: 'BLOCK_START',
        transferId: h.transferId,
        payload: { fileId: h.fileId, blockIndex: 0, bytes: 1, digest: sha(new Uint8Array([9])) },
      }),
    );
    await h.machine.receiveFrame(
      encodeTransferFrame({
        transferId: h.transferId,
        fileId: h.fileId,
        epoch: 1,
        blockIndex: 0,
        blockOffset: 0,
        sequence: 0,
        fragmentIndex: 0,
        fragmentCount: 1,
        payload: new Uint8Array([8]),
      }),
    );
    expect(h.machine.snapshot.state).toBe('failed');
    expect(h.machine.snapshot.committedBytes).toBe(0);
    expect(h.controls.some((control) => control.type === 'BLOCK_ACK')).toBe(false);
  } finally {
    await h.machine.dispose();
  }
});
it('early finalize cannot skip stored-file verification, including empty files', async () => {
  const h = await receiverWith(new Uint8Array(0));
  try {
    await h.machine.receiveControl(
      message({
        type: 'TRANSFER_FINALIZE',
        transferId: h.transferId,
        payload: { manifestDigest: h.digest },
      }),
    );
    expect(h.machine.snapshot.state).toBe('failed');
    expect(h.machine.snapshot.receipt).toBeNull();
  } finally {
    await h.machine.dispose();
  }
});
it('pause is independent per peer, cancel is idempotent and stale controls cannot resurrect work', async () => {
  const h = await receiverWith(new Uint8Array([1]));
  try {
    await h.machine.setPaused(true);
    await h.machine.receiveControl(
      message({ type: 'FLOW_STATE', transferId: h.transferId, payload: { paused: true } }),
    );
    await h.machine.setPaused(false);
    expect(h.machine.snapshot.state).toBe('paused');
    await h.machine.receiveControl(
      message({ type: 'FLOW_STATE', transferId: h.transferId, payload: { paused: false } }),
    );
    expect(h.machine.snapshot.state).toBe('active');
    await h.machine.cancel();
    await h.machine.cancel();
    const snapshot = h.machine.snapshot;
    await h.machine.receiveControl(
      message({ type: 'FLOW_STATE', transferId: h.transferId, payload: { paused: false } }),
    );
    expect(h.machine.snapshot).toBe(snapshot);
    expect(h.machine.snapshot.state).toBe('cancelled');
  } finally {
    await h.machine.dispose();
  }
});
it('zero-byte files complete only through verification and the receipt acknowledgment', async () => {
  const senderStorage = fakeStorage();
  const receiverStorage = fakeStorage();
  let sourceQueue = Promise.resolve();
  let targetQueue = Promise.resolve();
  const opts = { epoch: 1, frameBytes: 16384, onChange: () => {}, purgeStorage: async () => {} };
  const sender: TransferMachine = new TransferMachine({
    ...opts,
    role: 'owner',
    createStorage: () => senderStorage,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendControl: async (input) => {
        targetQueue = targetQueue.then(() => receiver.receiveControl(message(input)));
      },
      sendFrame: (wire) => {
        targetQueue = targetQueue.then(() => receiver.receiveFrame(wire));
      },
    },
  });
  const receiver: TransferMachine = new TransferMachine({
    ...opts,
    role: 'receiver',
    createStorage: () => receiverStorage,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async (input) => {
        sourceQueue = sourceQueue.then(() => sender.receiveControl(message(input)));
      },
    },
  });
  try {
    await sender.offer([new File([], 'empty.bin')]);
    await vi.waitFor(() => expect(receiver.snapshot.state).toBe('negotiating'));
    await receiver.accept();
    await vi.waitFor(() => expect(sender.snapshot.state).toBe('complete'));
    await vi.waitFor(() => expect(receiver.snapshot.state).toBe('complete'));
    expect(receiverStorage.commitBlock).not.toHaveBeenCalled();
    expect(receiverStorage.finalizeFile).toHaveBeenCalledTimes(1);
    expect(receiver.snapshot.receipt).toEqual(sender.snapshot.receipt);
    expect(receiver.snapshot.receipt?.files[0]?.sha256).toBe(sha(new Uint8Array(0)));
  } finally {
    await sender.dispose();
    await receiver.dispose();
  }
});

it('an unanswered offer times out without a receipt or confirmed bytes', async () => {
  vi.useFakeTimers();
  const machine = new TransferMachine({
    role: 'owner',
    epoch: 1,
    frameBytes: 16384,
    timeoutMs: 500,
    onChange: () => {},
    createStorage: fakeStorage,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async () => {},
    },
  });
  try {
    await machine.offer([new File([new Uint8Array([1])], 'timeout.bin')]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(machine.snapshot.state).toBe('failed');
    expect(machine.snapshot.receipt).toBeNull();
    expect(machine.snapshot.committedBytes).toBe(0);
  } finally {
    await machine.dispose();
    vi.useRealTimers();
  }
});

it('repeated file/finalize controls reuse the original receipt and never finalize storage twice', async () => {
  const h = await receiverWith(new Uint8Array(0));
  try {
    const end = {
      type: 'FILE_END' as const,
      transferId: h.transferId,
      payload: { fileId: h.fileId },
    };
    await h.machine.receiveControl(message(end));
    await h.machine.receiveControl(message(end));
    const finalize = {
      type: 'TRANSFER_FINALIZE' as const,
      transferId: h.transferId,
      payload: { manifestDigest: h.digest },
    };
    await h.machine.receiveControl(message(finalize));
    const original = h.machine.snapshot.receipt!;
    await h.machine.receiveControl(message(finalize));
    expect(h.machine.snapshot.receipt).toBe(original);
    await h.machine.receiveControl(
      message({
        type: 'RECEIPT_ACK',
        transferId: h.transferId,
        payload: { receiptId: original.receiptId, manifestDigest: h.digest },
      }),
    );
    expect(h.machine.snapshot.state).toBe('complete');
    await h.machine.receiveControl(message(finalize));
    await h.machine.receiveControl(
      message({ type: 'TRANSFER_CANCEL', transferId: h.transferId, payload: { reason: 'user' } }),
    );
    expect(h.machine.snapshot.state).toBe('complete');
    expect(
      h.controls
        .filter((control) => control.type === 'TRANSFER_RECEIPT')
        .map((control) => control.payload),
    ).toEqual([original, original, original]);
    expect(h.storage.finalizeFile).toHaveBeenCalledTimes(1);
  } finally {
    await h.machine.dispose();
  }
});

it('a repeated valid block ACK is idempotent and does not count bytes twice', async () => {
  const h = harness('owner');
  try {
    await h.machine.offer([new File([new Uint8Array([37])], 'once.bin')]);
    const manifest = h.machine.snapshot.manifest!;
    await h.machine.receiveControl(
      message({
        type: 'TRANSFER_ACCEPT',
        transferId: manifest.transferId,
        payload: {
          manifestDigest: await manifestDigest(manifest),
          destination: 'browser-temporary',
        },
      }),
    );
    await vi.waitFor(() => expect(h.frames.length).toBe(1));
    const block = h.controls.find((control) => control.type === 'BLOCK_START')!;
    const ack = {
      type: 'BLOCK_ACK' as const,
      transferId: manifest.transferId,
      payload: {
        fileId: manifest.files[0]!.fileId,
        blockIndex: 0,
        digest: block.payload.digest,
        committedBytes: 1,
      },
    };
    await h.machine.receiveControl(message(ack));
    await h.machine.receiveControl(message(ack));
    expect(h.machine.snapshot.committedBytes).toBe(1);
    expect(h.machine.snapshot.state).toBe('verifying');
  } finally {
    await h.machine.dispose();
  }
});
