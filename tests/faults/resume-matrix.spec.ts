import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  fileControlSchema,
  manifestSchema,
  VERIFICATION_BLOCK_BYTES as B,
} from '@meshdrop/protocol';
import type { BlockProof, FileControlInput, TransferManifest } from '@meshdrop/protocol';
import { TransferMachine } from '../../packages/transfer-core/src/TransferMachine';
import { decodeTransferFrame } from '../../packages/transfer-core/src/FrameCodec';
import type { HashStorage, SourceEntry } from '../../packages/transfer-core/src/HashWorker';
import type { TransferRecord } from '../../packages/storage/src/ReceiverStore';
import { checkpointDigest } from '../../packages/recovery/src/Reconciliation';
import { manifestDigest } from '../../packages/transfer-core/src/Manifest';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytes = new Uint8Array(20 * B);
for (let index = 0; index < bytes.length; index++)
  bytes[index] = (index * 31 + Math.floor(index / B) * 17) % 251;
const source = new File([bytes], 'resume.bin');
function durableFake() {
  const data = new Map<string, Uint8Array>(),
    proofs = new Map<string, BlockProof>();
  let manifest: TransferManifest, record: TransferRecord;
  const key = (id: string, index: number) => `${id}:${index}`;
  function storage(): HashStorage {
    const files = new Map<string, File>();
    const block = async (fileId: string, index: number) => {
      const file = files.get(fileId)!;
      const bytes = new Uint8Array(await file.slice(index * B, (index + 1) * B).arrayBuffer());
      return { bytes, digest: sha(bytes) };
    };
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
      sourceBlock: block,
      sourceDigest: async (id, index) => (await block(id, index)).digest,
      prepareReceiver: async (storageKey, _files, input) => {
        manifest = manifestSchema.parse(input);
        record = {
          schemaVersion: 1,
          transferId: manifest.transferId,
          manifestDigest: await manifestDigest(manifest),
          blockSize: B,
          storageKey,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          retention: '24-hours',
          state: 'receiving',
          finalizedFiles: [],
          receipt: null,
        };
      },
      commitBlock: async (id, index, bytes, digest) => {
        if (proofs.has(key(id, index))) throw new Error('Retransmitted valid block');
        if (sha(bytes) !== digest) throw new Error('Digest mismatch');
        data.set(key(id, index), bytes.slice());
        proofs.set(key(id, index), { fileId: id, index, digest });
      },
      openCheckpoint: async () => {
        let discarded = 0;
        for (const [id, proof] of proofs)
          if (!data.has(id) || sha(data.get(id)!) !== proof.digest) {
            proofs.delete(id);
            discarded++;
          }
        const blocks = [...proofs.values()];
        return {
          blocks,
          checkpoint: {
            record,
            manifest,
            committedBytes: [...data]
              .filter(([id]) => proofs.has(id))
              .reduce((sum, [, b]) => sum + b.length, 0),
            files: [],
            discardedBlocks: discarded,
            verifiedAt: Date.now(),
          },
        };
      },
      invalidateCheckpoint: async (invalid) => {
        for (const proof of invalid) proofs.delete(key(proof.fileId, proof.index));
      },
      bindResume: async (resume) => {
        record = { ...record, lastResume: resume };
      },
      finalizeFile: async (id) => {
        const meta = manifest.files.find((file) => file.fileId === id)!;
        const output = new File(
          Array.from(
            { length: Math.ceil(meta.size / B) },
            (_, index) => new Uint8Array(data.get(key(id, index))!),
          ),
          meta.path,
        );
        const hash = sha(new Uint8Array(await output.arrayBuffer()));
        if (hash !== meta.sha256) throw new Error('Final SHA mismatch');
        return { file: output, sha256: hash };
      },
      rememberReceipt: async (receipt) => {
        record = { ...record, receipt };
      },
      dispose: () => {},
    };
  }
  return { storage, data, proofs, key };
}
it.each([0, 10, 50, 70, 95, 100])(
  'resumes an interrupted %i percent transfer on epoch 2 without sending valid committed blocks',
  async (percent) => {
    const durable = durableFake();
    const roomId = randomUUID(),
      ownerId = randomUUID(),
      receiverId = randomUUID();
    let seq = 0,
      epoch = 1,
      cut = false;
    let owner: TransferMachine, receiver: TransferMachine;
    let toOwner = Promise.resolve(),
      toReceiver = Promise.resolve();
    const sent: { epoch: number; index: number }[] = [];
    const wrap = (input: FileControlInput, peerId: string) =>
      fileControlSchema.parse({
        ...input,
        version: 1,
        roomId,
        peerId,
        epoch,
        seq: seq++,
        messageId: randomUUID(),
        transcript: 'a'.repeat(64),
      });
    function create(role: 'owner' | 'receiver') {
      return new TransferMachine({
        role,
        roomId,
        epoch,
        frameBytes: 16384,
        retention: '24-hours',
        createStorage: durable.storage,
        purgeStorage: async () => {},
        onChange: (view) => {
          if (
            role === 'receiver' &&
            epoch === 1 &&
            !cut &&
            view.state === 'active' &&
            view.committedBytes >= (source.size * percent) / 100
          ) {
            cut = true;
            owner.disconnect();
            receiver.disconnect();
          }
        },
        transport: {
          bufferedAmount: 0,
          waitForDrain: async () => {},
          sendControl: async (input) => {
            if (cut && epoch === 1) return;
            const message = wrap(input, role === 'owner' ? ownerId : receiverId);
            if (role === 'owner')
              toReceiver = toReceiver.then(() => receiver.receiveControl(message));
            else toOwner = toOwner.then(() => owner.receiveControl(message));
          },
          sendFrame: (wire) => {
            if (cut && epoch === 1) return;
            const frame = decodeTransferFrame(wire);
            if (frame.fragmentIndex === 0) sent.push({ epoch, index: frame.blockIndex });
            toReceiver = toReceiver.then(() => receiver.receiveFrame(wire));
          },
        },
      });
    }
    owner = create('owner');
    receiver = create('receiver');
    try {
      await owner.offer([source]);
      await vi.waitFor(() => expect(receiver.snapshot.state).toBe('negotiating'));
      await receiver.accept();
      await vi.waitFor(() => expect(receiver.snapshot.state).toBe('reconnecting'), {
        timeout: 10000,
      });
      await Promise.all([toOwner, toReceiver]);
      const manifest = owner.snapshot.manifest!;
      expect(durable.proofs.size).toBe((20 * percent) / 100);
      const reused = [...durable.proofs.values()];
      const oldAck = wrap(
        {
          type: 'BLOCK_ACK',
          transferId: manifest.transferId,
          payload: {
            fileId: manifest.files[0]!.fileId,
            blockIndex: 0,
            digest: '0'.repeat(64),
            committedBytes: B,
          },
        },
        receiverId,
      );
      await owner.dispose(false);
      await receiver.dispose(false);
      epoch = 2;
      owner = create('owner');
      receiver = create('receiver');
      await owner.restoreSource(manifest, [source]);
      await receiver.restoreReceiver(manifest);
      await owner.receiveControl(oldAck); // Delayed ACK from epoch 1 cannot alter current progress.
      await vi.waitFor(() => expect(receiver.snapshot.state).toBe('complete'), { timeout: 10000 });
      await vi.waitFor(() => expect(owner.snapshot.state).toBe('complete'), { timeout: 10000 });
      expect(owner.snapshot.reusedBytes).toBe((source.size * percent) / 100);
      expect(owner.snapshot.attemptBytes).toBe((source.size * (100 - percent)) / 100);
      expect(sent.filter((frame) => frame.epoch === 2).map((frame) => frame.index)).toEqual(
        Array.from({ length: 20 - reused.length }, (_, index) => index + reused.length),
      );
      expect(
        sha(new Uint8Array(await receiver.download(manifest.files[0]!.fileId)!.arrayBuffer())),
      ).toBe(sha(bytes));
      expect(receiver.snapshot.receipt?.epoch).toBe(2);
      expect(checkpointDigest(await manifestDigest(manifest), reused)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await owner.dispose(false);
      await receiver.dispose(false);
    }
  },
);
it('changed source content with the same basename and size is rejected before any resume announcement', async () => {
  const durable = durableFake();
  const controls: FileControlInput[] = [];
  const machine = new TransferMachine({
    role: 'owner',
    epoch: 2,
    frameBytes: 16384,
    onChange: () => {},
    retention: '24-hours',
    createStorage: durable.storage,
    transport: {
      bufferedAmount: 0,
      sendFrame: () => {},
      waitForDrain: async () => {},
      sendControl: async (input) => {
        controls.push(input);
      },
    },
  });
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: B,
    totalBytes: 3,
    files: [
      {
        fileId: randomUUID(),
        path: 'resume.bin',
        size: 3,
        sha256: sha(new TextEncoder().encode('abc')),
      },
    ],
  };
  try {
    await machine.restoreSource(manifest, [new File(['abd'], 'resume.bin')]);
    expect(machine.snapshot.state).toBe('failed');
    expect(machine.snapshot.error).toContain('SHA-256');
    expect(controls.some((c) => c.type === 'MANIFEST_CONFIRM')).toBe(false);
  } finally {
    await machine.dispose(false);
  }
});

it('replayed NEED_RANGES fails closed without modifying retained blocks or manufacturing completion', async () => {
  const durable = durableFake(),
    fileId = randomUUID(),
    transferId = randomUUID(),
    roomId = randomUUID();
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId,
    blockBytes: B,
    totalBytes: 2 * B,
    files: [{ fileId, path: 'resume.bin', size: 2 * B, sha256: sha(bytes.subarray(0, 2 * B)) }],
  };
  const setup = durable.storage();
  await setup.prepareReceiver(randomUUID(), manifest.files, manifest, '24-hours');
  await setup.commitBlock(fileId, 0, bytes.slice(0, B), sha(bytes.subarray(0, B)));
  const controls: FileControlInput[] = [];
  const machine = new TransferMachine({
    role: 'receiver',
    roomId,
    epoch: 2,
    frameBytes: 16384,
    retention: '24-hours',
    onChange: () => {},
    createStorage: durable.storage,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async (input) => {
        controls.push(input);
      },
    },
  });
  let seq = 0;
  const message = (input: FileControlInput) =>
    fileControlSchema.parse({
      ...input,
      version: 1,
      roomId,
      peerId: randomUUID(),
      epoch: 2,
      seq: seq++,
      transcript: 'a'.repeat(64),
      messageId: randomUUID(),
    });
  try {
    await machine.restoreReceiver(manifest);
    const hello = controls.find((c) => c.type === 'RESUME_HELLO')!;
    const scope = {
      attemptId: hello.payload.attemptId,
      manifestDigest: hello.payload.manifestDigest,
    };
    await machine.receiveControl(
      message({ type: 'MANIFEST_CONFIRM', transferId, payload: { ...scope, manifest } }),
    );
    const need = message({
      type: 'NEED_RANGES',
      transferId,
      payload: { ...scope, page: 0, rejected: [] },
    });
    await machine.receiveControl(need);
    expect(machine.snapshot.state).toBe('active');
    await machine.receiveControl(need);
    expect(machine.snapshot.state).toBe('active'); // Identical messageId is idempotent.
    await machine.receiveControl(
      message({ type: 'NEED_RANGES', transferId, payload: { ...scope, page: 0, rejected: [0] } }),
    );
    expect(machine.snapshot.state).toBe('failed');
    expect(durable.proofs.size).toBe(1);
    expect(machine.snapshot.committedBytes).toBe(B);
    expect(machine.snapshot.receipt).toBeNull();
  } finally {
    await machine.dispose(false);
  }
});
it('explicit cancellation purges a disconnected attempt and remains terminal', async () => {
  const purged = vi.fn(async () => {}),
    durable = durableFake();
  const machine = new TransferMachine({
    role: 'receiver',
    epoch: 2,
    frameBytes: 16384,
    retention: '24-hours',
    onChange: () => {},
    createStorage: durable.storage,
    purgeStorage: purged,
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async () => {},
    },
  });
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: B,
    totalBytes: B,
    files: [
      { fileId: randomUUID(), path: 'resume.bin', size: B, sha256: sha(bytes.subarray(0, B)) },
    ],
  };
  const storage = durable.storage();
  await storage.prepareReceiver(randomUUID(), manifest.files, manifest, '24-hours');
  try {
    await machine.restoreReceiver(manifest);
    machine.disconnect();
    await machine.cancel();
    await machine.cancel();
    expect(machine.snapshot.state).toBe('cancelled');
    expect(purged).toHaveBeenCalledTimes(1);
    expect(machine.snapshot.receipt).toBeNull();
  } finally {
    await machine.dispose(false);
  }
});

it('resumes sparse ranges across a fully reused file, empty file and partial tail without skipping final verification', async () => {
  const durable = durableFake(),
    roomId = randomUUID();
  let seq = 0;
  const files = [
    new File(['abc'], 'done.bin'),
    new File([], 'empty.bin'),
    new File([bytes.slice(0, 2 * B + 17)], 'tail.bin'),
  ];
  const manifest: TransferManifest = {
    version: 1,
    revision: 1,
    transferId: randomUUID(),
    blockBytes: B,
    totalBytes: 2 * B + 20,
    files: await Promise.all(
      files.map(async (file) => ({
        fileId: randomUUID(),
        path: file.name,
        size: file.size,
        sha256: sha(new Uint8Array(await file.arrayBuffer())),
      })),
    ),
  };
  const setup = durable.storage();
  await setup.prepareReceiver(randomUUID(), manifest.files, manifest, '24-hours');
  await setup.commitBlock(
    manifest.files[0]!.fileId,
    0,
    new TextEncoder().encode('abc'),
    sha(new TextEncoder().encode('abc')),
  );
  await setup.commitBlock(
    manifest.files[2]!.fileId,
    1,
    bytes.slice(B, 2 * B),
    sha(bytes.subarray(B, 2 * B)),
  );
  let toOwner = Promise.resolve(),
    toReceiver = Promise.resolve();
  const wrap = (input: FileControlInput) =>
    fileControlSchema.parse({
      ...input,
      version: 1,
      roomId,
      peerId: randomUUID(),
      epoch: 2,
      seq: seq++,
      messageId: randomUUID(),
      transcript: 'a'.repeat(64),
    });
  const opts = {
    roomId,
    epoch: 2,
    frameBytes: 16384,
    retention: '24-hours' as const,
    onChange: () => {},
    createStorage: durable.storage,
  };
  const owner: TransferMachine = new TransferMachine({
    ...opts,
    role: 'owner',
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendControl: async (input) => {
        toReceiver = toReceiver.then(() => receiver.receiveControl(wrap(input)));
      },
      sendFrame: (wire) => {
        toReceiver = toReceiver.then(() => receiver.receiveFrame(wire));
      },
    },
  });
  const receiver: TransferMachine = new TransferMachine({
    ...opts,
    role: 'receiver',
    transport: {
      bufferedAmount: 0,
      waitForDrain: async () => {},
      sendFrame: () => {},
      sendControl: async (input) => {
        toOwner = toOwner.then(() => owner.receiveControl(wrap(input)));
      },
    },
  });
  try {
    await owner.restoreSource(manifest, files);
    await receiver.restoreReceiver(manifest);
    await vi.waitFor(() => expect(receiver.snapshot.state).toBe('complete'), { timeout: 10000 });
    await vi.waitFor(() => expect(owner.snapshot.state).toBe('complete'), { timeout: 10000 });
    expect(owner.snapshot.reusedBytes).toBe(B + 3);
    expect(owner.snapshot.attemptBytes).toBe(B + 17);
    for (const [index, meta] of manifest.files.entries())
      expect(sha(new Uint8Array(await receiver.download(meta.fileId)!.arrayBuffer()))).toBe(
        sha(new Uint8Array(await files[index]!.arrayBuffer())),
      );
    expect(receiver.snapshot.receipt?.files).toEqual(manifest.files);
  } finally {
    await owner.dispose(false);
    await receiver.dispose(false);
  }
});
