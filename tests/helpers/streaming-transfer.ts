import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fileControlSchema,
  manifestSchema,
  receiptSchema,
  VERIFICATION_BLOCK_BYTES as B,
} from '@meshdrop/protocol';
import type {
  BlockProof,
  FileControl,
  FileControlInput,
  TransferManifest,
  TransferReceipt,
} from '@meshdrop/protocol';
import { validateResumeEpoch } from '../../packages/recovery/src/EpochManager';
import { hashLocalFile } from '../../packages/storage/src/integrity';
import { StorageFailure } from '../../packages/storage/src/ReceiverStore';
import type { TransferRecord } from '../../packages/storage/src/ReceiverStore';
import { TransferMachine } from '../../packages/transfer-core/src/TransferMachine';
import type { TransferView } from '../../packages/transfer-core/src/TransferMachine';
import type { HashStorage } from '../../packages/transfer-core/src/HashWorker';
import { blockLength, manifestDigest } from '../../packages/transfer-core/src/Manifest';
import { decodeTransferFrame } from '../../packages/transfer-core/src/FrameCodec';

export { B };
export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Offset-defined bytes: independent of read boundaries, with a different pattern in each block. */
export function generatedRange(start: number, length: number, seed = 19): Uint8Array<ArrayBuffer> {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > B
  )
    throw new Error('Generated reads must fit one verification block.');
  const bytes = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    const absolute = start + written;
    const count = Math.min(length - written, B - (absolute % B));
    const pattern = Uint8Array.from(
      { length: 251 },
      (_, i) => ((absolute + i) * 31 + Math.floor(absolute / B) * 17 + seed) % 251,
    );
    for (let at = 0; at < count; at += pattern.length)
      bytes.set(pattern.subarray(0, Math.min(pattern.length, count - at)), written + at);
    written += count;
  }
  return bytes;
}
export class GeneratedFile extends File {
  peakReadBytes = 0;
  constructor(
    readonly logicalSize: number,
    readonly seed = 19,
  ) {
    super([], 'generated.bin');
  }
  override get size() {
    return this.logicalSize;
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('Whole-file allocation forbidden.');
  }
  override slice(start = 0, end = this.size): Blob {
    const bytes = generatedRange(start, Math.min(end, this.size) - start, this.seed);
    this.peakReadBytes = Math.max(this.peakReadBytes, bytes.length);
    return new Blob([bytes]);
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    return new ReadableStream({
      pull: (controller) => {
        if (offset === this.size) {
          controller.close();
          return;
        }
        const bytes = generatedRange(offset, Math.min(B, this.size - offset), this.seed);
        this.peakReadBytes = Math.max(this.peakReadBytes, bytes.length);
        offset += bytes.length;
        controller.enqueue(bytes);
      },
    });
  }
}
class DiskFile extends File {
  constructor(
    readonly path: string,
    readonly logicalSize: number,
  ) {
    super([], 'generated.bin');
  }
  override get size() {
    return this.logicalSize;
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('Whole-file allocation forbidden.');
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let handle: FileHandle | undefined;
    let offset = 0;
    const close = async () => {
      await handle?.close();
      handle = undefined;
    };
    return new ReadableStream({
      pull: async (controller) => {
        try {
          handle ??= await open(this.path, 'r');
          if (offset === this.size) {
            await close();
            controller.close();
            return;
          }
          const bytes = new Uint8Array(Math.min(B, this.size - offset));
          let read = 0;
          while (read < bytes.length) {
            const result = await handle.read(bytes, read, bytes.length - read, offset + read);
            if (!result.bytesRead) throw new Error('Truncated fixture storage.');
            read += result.bytesRead;
          }
          offset += bytes.length;
          controller.enqueue(bytes);
        } catch (error) {
          await close();
          controller.error(error);
        }
      },
      cancel: close,
    });
  }
}
export async function nodeFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: B })) hash.update(chunk);
  return hash.digest('hex');
}
export function sourceHash(size: number, seed = 19): string {
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += B)
    hash.update(generatedRange(offset, Math.min(B, size - offset), seed));
  return hash.digest('hex');
}
export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
export async function until(check: () => boolean, milliseconds = 15000): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Local transfer condition did not settle.');
    await delay(1);
  }
}

type Hooks = {
  beforeCommit?: (index: number) => Promise<void>;
  prepareReceiver?: () => Promise<void>;
  beforeFinalize?: () => Promise<void>;
  beforeReceipt?: () => Promise<void>;
  control?: (
    role: 'owner' | 'receiver',
    control: FileControl,
  ) => boolean | void | Promise<boolean | void>;
  frame?: (wire: Uint8Array<ArrayBuffer>, epoch: number) => Uint8Array<ArrayBuffer>;
  duplicateFrame?: (wire: Uint8Array<ArrayBuffer>) => boolean;
  view?: (role: 'owner' | 'receiver', view: TransferView) => void;
};
/** Real file-backed bytes + test ledger, injected at the engine's storage/transport boundary.
 * This is NOT OPFS, a hosted service, signature authentication, or a real WebRTC link. */
export class StreamingPair {
  owner!: TransferMachine;
  receiver!: TransferMachine;
  readonly source: GeneratedFile;
  readonly hooks: Hooks = {};
  readonly violations: string[] = [];
  readonly controls: { role: 'owner' | 'receiver'; control: FileControl }[] = [];
  readonly sentBlocks: { epoch: number; index: number }[] = [];
  readonly proofs = new Map<number, BlockProof>();
  manifest!: TransferManifest;
  record!: TransferRecord;
  receipt: TransferReceipt | null = null;
  root!: string;
  epoch = 1;
  reconnectCount = 0;
  finalHash = '';
  finalized = false;
  receiptWrites = 0;
  peakQueueBytes = 0;
  peakQueueMessages = 0;
  peakUnacknowledgedBytes = 0;
  peakOutstandingBlocks = 0;
  peakWriteQueue = 0;
  peakWriteBytes = 0;
  payloadBytes = 0;
  retransmittedBytes = 0;
  missingRangeBytes = 0;
  live = true;
  private writes = 0;
  private generation = 0;
  private sequences = { owner: 0, receiver: 0 };
  private readonly roomId = randomUUID();
  private readonly handles = new Set<FileHandle>();
  private readonly closing: Promise<unknown>[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly sentOffsets = new Map<number, number>();
  private readonly began = performance.now();
  private expected = '';
  private queues: {
    bytes: number;
    messages: number;
    tail: Promise<void>;
    drain: Set<() => void>;
  }[] = [];
  constructor(size: number) {
    this.source = new GeneratedFile(size);
  }
  get path() {
    return join(this.root, 'payload');
  }
  get committedBytes() {
    return [...this.proofs.keys()].reduce(
      (sum, index) => sum + blockLength(this.source.size, index),
      0,
    );
  }
  async initialize(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), 'meshdrop-task12-'));
    this.expected = sourceHash(this.source.size);
    this.createMachines();
    return this;
  }
  private async persist() {
    await writeFile(
      join(this.root, 'checkpoint.json'),
      JSON.stringify({
        manifest: this.manifest,
        record: this.record,
        blocks: [...this.proofs.values()],
      }),
    );
  }
  private createStorage(): HashStorage {
    let closed = false;
    let handle: FileHandle | undefined;
    let source: File | undefined;
    let pending:
      | { fileId: string; index: number; bytes: Uint8Array<ArrayBuffer>; digest: string }
      | undefined;
    const opened = async () => {
      if (closed) throw new Error('Storage worker stopped.');
      if (!handle) {
        handle = await open(this.path, 'r+');
        this.handles.add(handle);
      }
      return handle;
    };
    const commit = async (
      fileId: string,
      index: number,
      bytes: Uint8Array<ArrayBuffer>,
      digest: string,
    ) => {
      this.writes++;
      this.peakWriteQueue = Math.max(this.peakWriteQueue, this.writes);
      this.peakWriteBytes = Math.max(this.peakWriteBytes, bytes.length);
      try {
        if (
          closed ||
          this.proofs.has(index) ||
          bytes.length !== blockLength(this.source.size, index)
        )
          throw new Error('Invalid storage range.');
        pending = { fileId, index, bytes, digest };
        await this.hooks.beforeCommit?.(index);
        if (closed) throw new Error('Storage worker stopped.');
        if (sha(bytes) !== digest) throw new Error('Corrupted wire block.');
        const expected = generatedRange(index * B, bytes.length);
        if (bytes.some((value, at) => value !== expected[at]))
          throw new Error('Unexpected source bytes.');
        const file = await opened();
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.write(bytes, offset, bytes.length - offset, index * B + offset);
          if (!result.bytesWritten) throw new Error('Write made no progress.');
          offset += result.bytesWritten;
        }
        await file.sync();
        if (closed) throw new Error('Storage worker stopped.');
        this.proofs.set(index, { fileId, index, digest });
        await this.persist();
        pending = undefined;
      } finally {
        this.writes--;
      }
    };
    return {
      prepareSources: async (entries) => {
        source = entries[0]!.file;
        return [
          {
            fileId: entries[0]!.fileId,
            path: entries[0]!.path,
            size: source.size,
            sha256: await hashLocalFile(source),
          },
        ];
      },
      sourceBlock: async (_id, index) => {
        if (closed || !source) throw new Error('Source worker stopped.');
        const bytes = new Uint8Array(await source.slice(index * B, (index + 1) * B).arrayBuffer());
        return { bytes, digest: sha(bytes) };
      },
      sourceDigest: async (_id, index) => {
        if (closed || !source) throw new Error('Source worker stopped.');
        return sha(new Uint8Array(await source.slice(index * B, (index + 1) * B).arrayBuffer()));
      },
      prepareReceiver: async (storageKey, _files, input) => {
        await this.hooks.prepareReceiver?.();
        this.manifest = manifestSchema.parse(input);
        this.record = {
          schemaVersion: 1,
          transferId: this.manifest.transferId,
          manifestDigest: await manifestDigest(this.manifest),
          storageKey,
          blockSize: B,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          retention: '24-hours',
          state: 'receiving',
          finalizedFiles: [],
          receipt: null,
        };
        await writeFile(this.path, new Uint8Array());
        await this.persist();
      },
      commitBlock: commit,
      retryCommit: async () => {
        if (!pending) throw new Error('No pending storage retry.');
        await commit(pending.fileId, pending.index, pending.bytes, pending.digest);
      },
      openCheckpoint: async (_transferId, digest) => {
        await Promise.all(this.closing);
        const saved = JSON.parse(await readFile(join(this.root, 'checkpoint.json'), 'utf8')) as {
          manifest: TransferManifest;
          record: TransferRecord;
          blocks: BlockProof[];
        };
        if (
          saved.record.manifestDigest !== digest ||
          (await manifestDigest(saved.manifest)) !== digest
        )
          throw new Error('Checkpoint identity mismatch.');
        this.record = saved.record;
        this.manifest = manifestSchema.parse(saved.manifest);
        this.proofs.clear();
        let discardedBlocks = 0;
        const file = await opened();
        for (const block of saved.blocks) {
          const bytes = new Uint8Array(blockLength(this.source.size, block.index));
          const result = await file.read(bytes, 0, bytes.length, block.index * B);
          if (result.bytesRead !== bytes.length || sha(bytes) !== block.digest) {
            discardedBlocks++;
            continue;
          }
          if (this.proofs.has(block.index)) throw new Error('Duplicate checkpoint range.');
          this.proofs.set(block.index, block);
        }
        return {
          blocks: [...this.proofs.values()],
          checkpoint: {
            manifest: this.manifest,
            record: this.record,
            committedBytes: this.committedBytes,
            files: [],
            discardedBlocks,
            verifiedAt: Date.now(),
          },
        };
      },
      invalidateCheckpoint: async (blocks) => {
        for (const block of blocks) this.proofs.delete(block.index);
        await this.persist();
      },
      bindResume: async (resume) => {
        validateResumeEpoch(this.record.lastResume, resume);
        this.record = { ...this.record, lastResume: resume };
        await this.persist();
      },
      finalizeFile: async () => {
        await this.hooks.beforeFinalize?.();
        if (
          closed ||
          this.proofs.size !== Math.ceil(this.source.size / B) ||
          this.committedBytes !== this.source.size
        )
          throw new Error('Uncommitted file ranges.');
        await (await opened()).sync();
        const file = new DiskFile(this.path, this.source.size);
        this.finalHash = await hashLocalFile(file);
        this.finalized = this.finalHash === this.manifest.files[0]!.sha256;
        if (!this.finalized) throw new StorageFailure('integrity', 'Final stored file mismatch.');
        return { file, sha256: this.finalHash };
      },
      rememberReceipt: async (input) => {
        await this.hooks.beforeReceipt?.();
        const receipt = receiptSchema.parse(input);
        if (
          closed ||
          !this.finalized ||
          receipt.totalBytes !== this.committedBytes ||
          receipt.manifestDigest !== this.record.manifestDigest
        )
          throw new Error('Unverified receipt.');
        this.receipt = receipt;
        this.receiptWrites++;
        this.record = { ...this.record, state: 'complete', receipt };
        await this.persist();
      },
      dispose: () => {
        closed = true;
        if (handle) {
          this.handles.delete(handle);
          this.closing.push(handle.close());
          handle = undefined;
        }
      },
    };
  }
  private createMachines() {
    this.live = true;
    const generation = ++this.generation;
    this.queues = [0, 1].map(() => ({
      bytes: 0,
      messages: 0,
      tail: Promise.resolve(),
      drain: new Set<() => void>(),
    }));
    for (const [i, role] of (['owner', 'receiver'] as const).entries()) {
      const queue = this.queues[i]!;
      const enqueue = (work: () => Promise<void>, bytes: number) => {
        if (!this.live || generation !== this.generation) return;
        queue.bytes += bytes;
        queue.messages++;
        this.peakQueueBytes = Math.max(this.peakQueueBytes, queue.bytes);
        this.peakQueueMessages = Math.max(this.peakQueueMessages, queue.messages);
        const next = queue.tail
          .then(async () => {
            if (this.live && generation === this.generation) await work();
          })
          .catch(() => {
            this.violations.push('unexpected-transport-error');
          })
          .finally(() => {
            queue.bytes -= bytes;
            queue.messages--;
            if (queue.bytes <= 128 * 1024) for (const done of [...queue.drain]) done();
          });
        queue.tail = next;
        this.inFlight.add(next);
        void next.finally(() => this.inFlight.delete(next));
      };
      const other = () => (role === 'owner' ? this.receiver : this.owner);
      const machine = new TransferMachine({
        role,
        roomId: this.roomId,
        epoch: this.epoch,
        frameBytes: 16384,
        retention: '24-hours',
        createStorage: () => this.createStorage(),
        purgeStorage: async () => {
          await Promise.all(this.closing);
          this.proofs.clear();
          this.receipt = null;
          await writeFile(this.path, new Uint8Array());
        },
        onChange: (view) => {
          if (view.committedBytes > this.source.size || view.committedBytes < 0)
            this.violations.push('committed-domain');
          if (role === 'owner') {
            if (view.committedBytes > this.committedBytes)
              this.violations.push('progress-before-storage');
            const unacknowledged = Math.max(
              0,
              view.attemptBytes - (view.committedBytes - view.reusedBytes),
            );
            this.peakUnacknowledgedBytes = Math.max(this.peakUnacknowledgedBytes, unacknowledged);
            this.peakOutstandingBlocks = Math.max(
              this.peakOutstandingBlocks,
              Math.ceil(unacknowledged / B),
            );
          }
          if (
            view.state === 'complete' &&
            (!this.finalized ||
              this.finalHash !== this.expected ||
              view.committedBytes !== this.source.size ||
              !view.receipt)
          )
            this.violations.push('false-completion');
          this.hooks.view?.(role, view);
        },
        transport: {
          get bufferedAmount() {
            return queue.bytes;
          },
          waitForDrain: async (signal) => {
            signal.throwIfAborted();
            if (queue.bytes <= 128 * 1024) return;
            await new Promise<void>((resolve, reject) => {
              const finish = () => {
                queue.drain.delete(finish);
                signal.removeEventListener('abort', abort);
                resolve();
              };
              const abort = () => {
                queue.drain.delete(finish);
                reject(new Error('Stopped transport.'));
              };
              queue.drain.add(finish);
              signal.addEventListener('abort', abort, { once: true });
            });
          },
          sendControl: async (input, signal) => {
            const control = this.wrap(role, input);
            this.controls.push({ role, control });
            if ((await this.hooks.control?.(role, control)) === false) return;
            signal?.throwIfAborted();
            enqueue(
              () => other().receiveControl(control),
              new TextEncoder().encode(JSON.stringify(control)).length,
            );
          },
          sendFrame: (original) => {
            const wire = this.hooks.frame?.(original, this.epoch) ?? original;
            const frame = decodeTransferFrame(wire);
            if (frame.fragmentIndex === 0)
              this.sentBlocks.push({ epoch: this.epoch, index: frame.blockIndex });
            this.payloadBytes += frame.payload.length;
            const previous = this.sentOffsets.get(frame.blockIndex) ?? 0;
            this.retransmittedBytes += Math.max(
              0,
              Math.min(previous, frame.blockOffset + frame.payload.length) - frame.blockOffset,
            );
            this.sentOffsets.set(
              frame.blockIndex,
              Math.max(previous, frame.blockOffset + frame.payload.length),
            );
            if (queue.bytes + wire.length > 512 * 1024) this.violations.push('send-buffer-bound');
            enqueue(async () => {
              await other().receiveFrame(wire);
              if (this.hooks.duplicateFrame?.(wire)) await other().receiveFrame(wire);
            }, wire.length);
          },
        },
      });
      if (role === 'owner') this.owner = machine;
      else this.receiver = machine;
    }
  }
  wrap(role: 'owner' | 'receiver', input: FileControlInput, epoch = this.epoch): FileControl {
    return fileControlSchema.parse({
      ...input,
      version: 1,
      roomId: this.roomId,
      peerId:
        role === 'owner'
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      epoch,
      transcript: 'a'.repeat(64),
      messageId: randomUUID(),
      seq: this.sequences[role]++,
    });
  }
  async start() {
    await this.owner.offer([this.source]);
    await until(() => this.receiver.snapshot.state === 'negotiating');
    await this.receiver.accept();
  }
  cut() {
    this.live = false;
    this.owner.disconnect();
    this.receiver.disconnect();
  }
  async flush() {
    while (this.inFlight.size) await Promise.all([...this.inFlight]);
  }
  async reconnect(source: File = this.source) {
    this.cut();
    await this.flush();
    const manifest = this.owner.snapshot.manifest!;
    await this.owner.dispose(false);
    await this.receiver.dispose(false);
    await Promise.all(this.closing);
    this.reconnectCount++;
    this.epoch++;
    this.missingRangeBytes = this.source.size - this.committedBytes;
    this.createMachines();
    await this.owner.restoreSource(manifest, [source]);
    if (this.owner.snapshot.state === 'failed') return;
    await this.receiver.restoreReceiver(manifest);
  }
  async completed() {
    await until(
      () => ['complete', 'failed', 'cancelled'].includes(this.receiver.snapshot.state ?? ''),
      120000,
    );
    await until(
      () => ['complete', 'failed', 'cancelled'].includes(this.owner.snapshot.state ?? ''),
      120000,
    );
    await this.flush();
  }
  metrics() {
    const durationMs = Math.max(1, performance.now() - this.began);
    return {
      bytes: this.source.size,
      durationMs: Math.round(durationMs),
      throughputBytesPerSecond: Math.round((this.source.size * 1000) / durationMs),
      peakQueuedBytes: this.peakQueueBytes,
      peakQueuedMessages: this.peakQueueMessages,
      peakUnacknowledgedBytes: this.peakUnacknowledgedBytes,
      peakOutstandingBlocks: this.peakOutstandingBlocks,
      peakReceiverWrites: this.peakWriteQueue,
      peakReceiverWriteBytes: this.peakWriteBytes,
      peakSourceReadBytes: this.source.peakReadBytes,
      reconnectCount: this.reconnectCount,
      retransmittedBytes: this.retransmittedBytes,
      missingRangeBytes: this.missingRangeBytes,
      payloadBytes: this.payloadBytes,
      finalCommittedBytes: this.committedBytes,
    };
  }
  async close() {
    this.cut();
    await this.flush();
    await this.owner.dispose(false);
    await this.receiver.dispose(false);
    await Promise.all(this.closing);
    for (const handle of this.handles) await handle.close();
    await rm(this.root, { recursive: true, force: true });
  }
}
