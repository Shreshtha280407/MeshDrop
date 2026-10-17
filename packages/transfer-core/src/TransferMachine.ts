import {
  manifestSchema,
  receiptSchema,
  transitionTransfer,
  VERIFICATION_BLOCK_BYTES,
  MIN_TRANSFER_FRAME_BYTES,
  MAX_TRANSFER_BYTES,
  RESUME_PROOF_PAGE_SIZE,
} from '@meshdrop/protocol';
import type {
  FileControl,
  BlockProof,
  FileControlInput,
  TransferManifest,
  TransferReceipt,
  TransferState,
} from '@meshdrop/protocol';
import { HashWorker, purgeTemporaryStore } from './HashWorker';
import type { HashStorage } from './HashWorker';
import { blockLength, manifestDigest, sourceEntries } from './Manifest';
import { decodeTransferFrame } from './FrameCodec';
import { ReceiverAssembler } from './ReceiverAssembler';
import { SenderScheduler } from './SenderScheduler';
import type { TransferTransport } from './SenderScheduler';
import {
  ResumeMachine,
  checkpointDigest,
  proofKey,
  proofBytes,
  sourceReselectEntries,
} from '@meshdrop/recovery';
import { CheckpointDB, isQuotaError } from '@meshdrop/storage';
import type { CapacityResult, RetentionPolicy } from '@meshdrop/storage';

export interface TransferView {
  state: TransferState | null;
  direction: 'send' | 'receive' | null;
  manifest: TransferManifest | null;
  committedBytes: number;
  receipt: TransferReceipt | null;
  error: string;
  localPaused: boolean;
  remotePaused: boolean;
  destinationReady: boolean;
  peakBufferedBytes: number;
  peakBlockBytes: number;
  capacity: CapacityResult | null;
  storageFull: boolean;
  recovery: string;
  reusedBytes: number;
  attemptBytes: number;
  discardedBlocks: number;
}
export const INITIAL_TRANSFER: TransferView = {
  state: null,
  direction: null,
  manifest: null,
  committedBytes: 0,
  receipt: null,
  error: '',
  localPaused: false,
  remotePaused: false,
  destinationReady: false,
  peakBufferedBytes: 0,
  peakBlockBytes: 0,
  capacity: null,
  storageFull: false,
  recovery: '',
  reusedBytes: 0,
  attemptBytes: 0,
  discardedBlocks: 0,
};
const terminal = (state: TransferState | null) =>
  state === 'complete' || state === 'failed' || state === 'cancelled';
export interface TransferOptions {
  role: 'owner' | 'receiver';
  roomId?: string;
  epoch: number;
  frameBytes: number;
  transport: TransferTransport;
  onChange(view: TransferView): void;
  createStorage?: () => HashStorage;
  purgeStorage?: (key: string) => Promise<void>;
  timeoutMs?: number;
  retention?: RetentionPolicy;
}
export class TransferMachine {
  private view: TransferView = { ...INITIAL_TRANSFER };
  private storage: HashStorage | null = null;
  private storageKey: string | null = null;
  private digest = '';
  private readonly abort = new AbortController();
  private assembler: ReceiverAssembler | null = null;
  private scheduler: SenderScheduler;
  private resumeSource: ResumeMachine | null = null;
  private resumeOriginalDigest = '';
  private resumeTarget: {
    confirmed: boolean;
    attemptId: string;
    blocks: BlockProof[];
    page: number;
    accepted: BlockProof[];
    rejected: BlockProof[];
  } | null = null;
  private readonly reused = new Set<string>();
  private fileIndex = 0;
  private nextBlock = 0;
  private pendingStorage: {
    fileId: string;
    blockIndex: number;
    digest: string;
    length: number;
  } | null = null;
  private lastAcknowledgment: Extract<FileControl, { type: 'BLOCK_ACK' }>['payload'] | null = null;
  private lastActivity = Date.now();
  private verifying = false;
  private waiting: {
    kind: 'BLOCK_ACK' | 'FILE_VERIFIED';
    fileId: string;
    blockIndex: number;
    digest: string;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  private wake: (() => void) | null = null;
  private readonly outputs = new Map<string, File>();
  private readonly verified = new Set<string>();
  private readonly processedIds = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: TransferOptions) {
    if (options.frameBytes < MIN_TRANSFER_FRAME_BYTES)
      throw new Error('Negotiated frames are too small for file transfer.');
    this.scheduler = new SenderScheduler(options.transport, options.frameBytes);
    this.timer = setInterval(() => {
      if (
        !this.view.state ||
        terminal(this.view.state) ||
        this.view.state === 'preparing' ||
        this.view.state === 'reconnecting' ||
        this.paused
      )
        return;
      const timeout = this.verifying ? 300000 : (this.options.timeoutMs ?? 60000);
      if (Date.now() - this.lastActivity > timeout)
        void this.fail('Transfer timed out before confirmed completion.', 'timeout');
    }, 1000);
  }
  get snapshot(): TransferView {
    return this.view;
  }
  get canResumeSource(): boolean {
    return (
      this.options.role === 'owner' &&
      this.view.state === 'negotiating' &&
      this.view.recovery.startsWith('Source ready') &&
      !this.resumeSource
    );
  }
  get epoch(): number {
    return this.options.epoch;
  }
  setRetention(retention: RetentionPolicy): void {
    if (!this.view.state || (this.view.state === 'negotiating' && !this.storage))
      this.options.retention = retention;
  }
  private get paused(): boolean {
    return this.view.localPaused || this.view.remotePaused;
  }
  private update(patch: Partial<TransferView>): void {
    this.view = { ...this.view, ...patch };
    this.options.onChange(this.view);
  }
  private transition(event: Parameters<typeof transitionTransfer>[1]): void {
    if (!this.view.state) throw new Error('Transfer has not started.');
    this.update({ state: transitionTransfer(this.view.state, event) });
  }
  private touch(): void {
    this.lastActivity = Date.now();
  }
  private get active(): boolean {
    return this.view.state !== null && !terminal(this.view.state) && !this.abort.signal.aborted;
  }
  private makeStorage(): HashStorage {
    return (this.options.createStorage ?? (() => new HashWorker()))();
  }
  private async send<T extends FileControlInput['type']>(
    type: T,
    payload: Extract<FileControlInput, { type: T }>['payload'],
  ): Promise<void> {
    const transferId = this.view.manifest?.transferId;
    if (!transferId) throw new Error('Transfer identity unavailable.');
    await this.options.transport.sendControl({ type, transferId, payload } as FileControlInput);
  }
  async offer(files: readonly File[]): Promise<void> {
    if (this.options.role !== 'owner' || this.view.state)
      throw new Error('Clear the current transfer before offering more files.');
    const entries = sourceEntries(files);
    if (entries.reduce((sum, entry) => sum + entry.file.size, 0) > MAX_TRANSFER_BYTES)
      throw new Error('Transfer exceeds the supported size bound.');
    this.update({ ...INITIAL_TRANSFER, state: 'preparing', direction: 'send' });
    this.storage = this.makeStorage();
    try {
      const prepared = await this.storage.prepareSources(entries);
      if (!this.active) return;
      const manifest = manifestSchema.parse({
        version: 1,
        transferId: crypto.randomUUID(),
        revision: 1,
        blockBytes: VERIFICATION_BLOCK_BYTES,
        files: prepared,
        totalBytes: prepared.reduce((sum, file) => sum + file.size, 0),
      });
      this.digest = await manifestDigest(manifest);
      if (!this.active) return;
      this.update({ manifest });
      await this.storage.rememberSources?.(manifest, this.options.retention ?? 'discard');
      if (!this.active) return;
      this.transition({ type: 'PREPARED' });
      this.touch();
      await this.send('TRANSFER_OFFER', { manifest, manifestDigest: this.digest });
    } catch {
      await this.fail(
        'Could not prepare the selected files. Check file access, size and names.',
        'invalid-data',
      );
    }
  }
  async restoreSource(input: TransferManifest, files: readonly File[]): Promise<void> {
    if (this.options.role !== 'owner' || this.view.state)
      throw new Error('Clear the current attempt before preparing resume.');
    const manifest = manifestSchema.parse(input);
    this.update({
      ...INITIAL_TRANSFER,
      state: 'preparing',
      direction: 'send',
      manifest,
      recovery: 'Verifying original source…',
    });
    this.storage = this.makeStorage();
    try {
      this.digest = await manifestDigest(manifest);
      const entries = sourceReselectEntries(manifest, files);
      const prepared = await this.storage.prepareSources(entries);
      if (!this.active) return;
      if (JSON.stringify(prepared) !== JSON.stringify(manifest.files))
        throw new Error('Source content changed.');
      this.transition({ type: 'PREPARED' });
      this.touch();
      this.update({ recovery: 'Source ready. The receiver can now resume its saved transfer.' });
    } catch {
      await this.fail(
        'The selected source does not match the original name, size and SHA-256. Reselect the exact original files.',
        'integrity',
      );
    }
  }
  async restoreReceiver(input: TransferManifest): Promise<void> {
    if (this.options.role !== 'receiver' || this.view.state)
      throw new Error('Clear the current attempt before resuming.');
    const manifest = manifestSchema.parse(input);
    this.update({
      ...INITIAL_TRANSFER,
      state: 'preparing',
      direction: 'receive',
      manifest,
      recovery: 'Rehashing saved blocks…',
    });
    this.storage = this.makeStorage();
    try {
      this.digest = await manifestDigest(manifest);
      if (!this.storage.openCheckpoint) throw new Error('Checkpoint storage unavailable.');
      const { checkpoint, blocks } = await this.storage.openCheckpoint(
        manifest.transferId,
        this.digest,
      );
      if (!this.active) return;
      if (JSON.stringify(checkpoint.manifest) !== JSON.stringify(manifest))
        throw new Error('Manifest changed.');
      this.storageKey = checkpoint.record.storageKey;
      this.options.retention = checkpoint.record.retention;
      this.resumeTarget = {
        confirmed: false,
        attemptId: crypto.randomUUID(),
        blocks,
        page: 0,
        accepted: [],
        rejected: [],
      };
      this.resumeOriginalDigest = checkpointDigest(this.digest, blocks);
      this.transition({ type: 'PREPARED' });
      this.touch();
      this.update({
        committedBytes: checkpoint.committedBytes,
        discardedBlocks: checkpoint.discardedBlocks,
        recovery: 'Waiting for the sender to confirm the original manifest…',
      });
      await this.send('RESUME_HELLO', {
        attemptId: this.resumeTarget.attemptId,
        manifestDigest: this.digest,
        checkpointDigest: this.resumeOriginalDigest,
      });
    } catch {
      await this.fail(
        'Saved data could not be reopened for resume. Check retention, file storage and other open tabs.',
        'storage',
      );
    }
  }
  private async resumePage(): Promise<void> {
    const target = this.resumeTarget!;
    const start = target.page * RESUME_PROOF_PAGE_SIZE;
    await this.send('HAVE_RANGES', {
      attemptId: target.attemptId,
      manifestDigest: this.digest,
      page: target.page,
      last: start + RESUME_PROOF_PAGE_SIZE >= target.blocks.length,
      blocks: target.blocks.slice(start, start + RESUME_PROOF_PAGE_SIZE),
    });
  }
  private firstMissing(fileId: string, start = 0): number {
    while (this.reused.has(`${fileId}:${start}`)) start++;
    return start;
  }
  private activateResume(blocks: readonly BlockProof[]): void {
    for (const block of blocks) this.reused.add(proofKey(block));
    const reusedBytes = blocks.reduce((sum, b) => sum + proofBytes(this.view.manifest!, b), 0);
    this.nextBlock = this.firstMissing(this.view.manifest!.files[0]!.fileId);
    this.assembler = new ReceiverAssembler(
      this.view.manifest!.transferId,
      this.options.epoch,
      this.options.frameBytes,
    );
    this.update({
      committedBytes: reusedBytes,
      reusedBytes,
      destinationReady: true,
      recovery:
        this.options.role === 'owner'
          ? 'Resume accepted. Sending only missing or invalid blocks.'
          : 'Resume accepted. Receiving only missing or invalid blocks.',
    });
    this.transition({ type: 'ACCEPT' });
    this.maybeVerifying();
    this.touch();
  }
  private async receiveResume(message: FileControl): Promise<boolean> {
    if (message.type === 'RESUME_UNAVAILABLE') {
      const target = this.resumeTarget;
      if (
        !target ||
        message.payload.attemptId !== target.attemptId ||
        message.payload.manifestDigest !== this.digest
      )
        return true;
      this.disconnect();
      this.update({
        error:
          'The sender must prepare the exact original source before you retry Resume saved transfer.',
      });
      return true;
    }

    if (
      !['RESUME_HELLO', 'MANIFEST_CONFIRM', 'HAVE_RANGES', 'NEED_RANGES', 'RESUME_ACCEPT'].includes(
        message.type,
      )
    )
      return false;
    if (this.view.state !== 'negotiating') throw new Error('Resume handshake is already closed.');
    if (message.type === 'RESUME_HELLO') {
      if (this.options.role !== 'owner' || this.resumeSource || !this.storage)
        throw new Error('Original source unavailable.');
      if (message.payload.manifestDigest !== this.digest) throw new Error('Manifest mismatch.');
      this.resumeSource = new ResumeMachine(
        this.view.manifest!,
        this.digest,
        message.payload.attemptId,
      );
      this.resumeOriginalDigest = message.payload.checkpointDigest;
      this.update({ recovery: 'Checking receiver proofs against the original source…' });
      await this.send('MANIFEST_CONFIRM', {
        attemptId: message.payload.attemptId,
        manifestDigest: this.digest,
        manifest: this.view.manifest!,
      });
      return true;
    }
    if (message.type === 'MANIFEST_CONFIRM') {
      const target = this.resumeTarget;
      if (
        this.options.role !== 'receiver' ||
        !target ||
        target.confirmed ||
        target.page !== 0 ||
        message.payload.attemptId !== target.attemptId ||
        message.payload.manifestDigest !== this.digest ||
        JSON.stringify(message.payload.manifest) !== JSON.stringify(this.view.manifest)
      )
        throw new Error('Unbound resume manifest.');
      target.confirmed = true;
      this.update({ recovery: 'Comparing rehashed blocks with the authenticated sender…' });
      await this.resumePage();
      return true;
    }
    if (message.type === 'HAVE_RANGES') {
      const source = this.resumeSource;
      if (this.options.role !== 'owner' || !source) throw new Error('Unexpected receiver proofs.');
      source.assertScope(message.payload.attemptId, message.payload.manifestDigest);
      const rejected = await source.have(
        message.payload.page,
        message.payload.last,
        message.payload.blocks,
        async (block) => {
          const digest = this.storage!.sourceDigest
            ? await this.storage!.sourceDigest(block.fileId, block.index)
            : (await this.storage!.sourceBlock(block.fileId, block.index)).digest;
          return digest === block.digest;
        },
      );
      if (!this.active) return true;
      this.touch();
      await this.send('NEED_RANGES', {
        attemptId: source.attemptId,
        manifestDigest: this.digest,
        page: message.payload.page,
        rejected,
      });
      return true;
    }
    if (message.type === 'NEED_RANGES') {
      const target = this.resumeTarget;
      if (
        this.options.role !== 'receiver' ||
        !target ||
        message.payload.attemptId !== target.attemptId ||
        message.payload.manifestDigest !== this.digest ||
        message.payload.page !== target.page
      )
        throw new Error('Stale missing-range response.');
      const page = target.blocks.slice(
        target.page * RESUME_PROOF_PAGE_SIZE,
        (target.page + 1) * RESUME_PROOF_PAGE_SIZE,
      );
      if (
        new Set(message.payload.rejected).size !== message.payload.rejected.length ||
        message.payload.rejected.some((index) => !page[index])
      )
        throw new Error('Invalid rejected proof index.');
      for (const [index, block] of page.entries())
        (message.payload.rejected.includes(index) ? target.rejected : target.accepted).push(block);
      target.page++;
      if (target.page * RESUME_PROOF_PAGE_SIZE < target.blocks.length) {
        await this.resumePage();
        return true;
      }
      await this.storage!.invalidateCheckpoint!(target.rejected);
      const digest = checkpointDigest(this.digest, target.accepted);
      const reusedBytes = target.accepted.reduce(
        (sum, b) => sum + proofBytes(this.view.manifest!, b),
        0,
      );
      await this.storage!.bindResume!({
        roomId: this.options.roomId ?? message.roomId,
        epoch: this.epoch,
        attemptId: target.attemptId,
        checkpointDigest: digest,
        reusedBytes,
      });
      if (!this.active) return true;
      this.update({ discardedBlocks: this.view.discardedBlocks + target.rejected.length });
      this.activateResume(target.accepted);
      await this.send('RESUME_ACCEPT', {
        attemptId: target.attemptId,
        manifestDigest: this.digest,
        checkpointDigest: digest,
        reusedBytes,
      });
      return true;
    }
    if (message.type === 'RESUME_ACCEPT') {
      const source = this.resumeSource;
      if (this.options.role !== 'owner' || !source)
        throw new Error('Unexpected resume acceptance.');
      source.assertScope(message.payload.attemptId, message.payload.manifestDigest);
      source.confirm(
        this.resumeOriginalDigest,
        message.payload.checkpointDigest,
        message.payload.reusedBytes,
      );
      this.activateResume([...source.accepted.values()]);
      this.beginSending();
      return true;
    }
    return false;
  }
  private beginSending(): void {
    void this.sendFiles().catch(() => {
      if (this.active) this.disconnect();
    });
  }
  async accept(): Promise<void> {
    if (
      this.options.role !== 'receiver' ||
      this.view.state !== 'negotiating' ||
      this.view.destinationReady ||
      this.storage
    )
      return;
    const manifest = this.view.manifest!;
    this.storageKey = crypto.randomUUID();
    this.storage = this.makeStorage();
    try {
      const capacity = await this.storage.prepareReceiver(
        this.storageKey,
        manifest.files,
        manifest,
        this.options.retention ?? 'discard',
      );
      if (!this.active) return;
      this.assembler = new ReceiverAssembler(
        manifest.transferId,
        this.options.epoch,
        this.options.frameBytes,
      );
      this.update({ destinationReady: true, capacity: capacity ?? null });
      this.transition({ type: 'ACCEPT' });
      this.maybeVerifying();
      this.touch();
      await this.send('TRANSFER_ACCEPT', {
        manifestDigest: this.digest,
        destination: 'browser-temporary',
      });
    } catch {
      await this.fail(
        'The browser could not prepare temporary storage. Check available space and storage support.',
        'storage',
      );
    }
  }
  async reject(): Promise<void> {
    if (this.options.role !== 'receiver' || this.view.state !== 'negotiating') return;
    await this.send('TRANSFER_REJECT', { reason: 'declined' });
    await this.cancel(false);
  }
  private maybeVerifying(): void {
    if (
      this.view.manifest &&
      this.view.committedBytes === this.view.manifest.totalBytes &&
      this.view.state === 'active'
    )
      this.transition({
        type: 'ALL_BLOCKS_COMMITTED',
        committedBytes: this.view.committedBytes,
        totalBytes: this.view.manifest.totalBytes,
      });
  }
  async receiveControl(message: FileControl): Promise<void> {
    if (message.epoch !== this.options.epoch || this.abort.signal.aborted) return;
    if (this.processedIds.has(message.messageId)) return;
    this.processedIds.add(message.messageId);
    if (this.processedIds.size > 128)
      this.processedIds.delete(this.processedIds.values().next().value!);
    try {
      if (message.type === 'TRANSFER_OFFER') {
        if (this.options.role !== 'receiver') throw new Error('Unexpected file offer.');
        const manifest = manifestSchema.parse(message.payload.manifest);
        if (
          manifest.transferId !== message.transferId ||
          (await manifestDigest(manifest)) !== message.payload.manifestDigest
        )
          throw new Error('Invalid manifest binding.');
        if (this.view.state) {
          if (
            this.view.manifest?.transferId === manifest.transferId &&
            this.digest === message.payload.manifestDigest
          )
            return;
          throw new Error('A different transfer is already active.');
        }
        this.digest = message.payload.manifestDigest;
        this.update({ ...INITIAL_TRANSFER, state: 'preparing', direction: 'receive', manifest });
        this.transition({ type: 'PREPARED' });
        this.touch();
        return;
      }
      const manifest = this.view.manifest;
      if (!manifest || message.transferId !== manifest.transferId) return;
      this.touch();
      if (!terminal(this.view.state) && (await this.receiveResume(message))) return;
      if (terminal(this.view.state)) {
        // Retry terminal confirmation without changing the original receipt or storage.
        if (this.view.state === 'complete' && this.view.receipt) {
          if (
            message.type === 'TRANSFER_FINALIZE' &&
            message.payload.manifestDigest === this.digest &&
            this.options.role === 'receiver'
          )
            await this.send('TRANSFER_RECEIPT', this.view.receipt);
          if (
            message.type === 'TRANSFER_RECEIPT' &&
            this.options.role === 'owner' &&
            JSON.stringify(message.payload) === JSON.stringify(this.view.receipt)
          )
            await this.send('RECEIPT_ACK', {
              receiptId: this.view.receipt.receiptId,
              manifestDigest: this.digest,
            });
        }
        return;
      }
      if (message.type === 'TRANSFER_CANCEL' || message.type === 'TRANSFER_REJECT') {
        await this.cancel(
          false,
          message.type === 'TRANSFER_CANCEL' && message.payload.reason !== 'user',
        );
        return;
      }
      if (message.type === 'FLOW_STATE') {
        if (this.view.state === 'active' || this.view.state === 'paused') {
          this.update({ remotePaused: message.payload.paused });
          this.applyPauseState();
        }
        return;
      }
      if (message.type === 'TRANSFER_ACCEPT') {
        if (this.options.role !== 'owner' || message.payload.manifestDigest !== this.digest)
          throw new Error('Invalid acceptance.');
        if (this.view.state !== 'negotiating') return;
        this.transition({ type: 'ACCEPT' });
        this.maybeVerifying();
        this.beginSending();
        return;
      }
      if (message.type === 'BLOCK_ACK') {
        if (
          this.lastAcknowledgment &&
          JSON.stringify(this.lastAcknowledgment) === JSON.stringify(message.payload)
        )
          return;
        const waiting = this.waiting;
        if (
          this.options.role !== 'owner' ||
          !waiting ||
          waiting.kind !== message.type ||
          waiting.fileId !== message.payload.fileId ||
          waiting.blockIndex !== message.payload.blockIndex ||
          waiting.digest !== message.payload.digest
        )
          throw new Error('Invalid storage acknowledgment.');
        const file = manifest.files.find((file) => file.fileId === waiting.fileId)!;
        const expected = this.view.committedBytes + blockLength(file.size, waiting.blockIndex);
        if (message.payload.committedBytes !== expected)
          throw new Error('Unconfirmed byte progress.');
        this.update({
          committedBytes: expected,
          peakBufferedBytes: this.scheduler.peakBufferedBytes,
          peakBlockBytes: this.scheduler.peakBlockBytes,
        });
        this.maybeVerifying();
        this.lastAcknowledgment = message.payload;
        this.waiting = null;
        waiting.resolve();
        return;
      }
      if (message.type === 'FILE_VERIFIED') {
        if (
          this.verified.has(message.payload.fileId) &&
          manifest.files.some(
            (file) =>
              file.fileId === message.payload.fileId && file.sha256 === message.payload.sha256,
          )
        )
          return;
        const waiting = this.waiting;
        const file = manifest.files.find((file) => file.fileId === message.payload.fileId);
        if (
          this.options.role !== 'owner' ||
          !waiting ||
          waiting.kind !== message.type ||
          waiting.fileId !== message.payload.fileId ||
          !file ||
          message.payload.sha256 !== file.sha256
        )
          throw new Error('Invalid final file verification.');
        this.verified.add(file.fileId);
        this.waiting = null;
        this.verifying = false;
        waiting.resolve();
        return;
      }
      if (this.options.role !== 'receiver' && message.type !== 'TRANSFER_RECEIPT')
        throw new Error('Unexpected transfer control role.');
      if (message.type === 'BLOCK_START') {
        const file = manifest.files[this.fileIndex];
        if (
          !this.view.destinationReady ||
          !this.assembler ||
          !file ||
          file.fileId !== message.payload.fileId ||
          this.nextBlock !== message.payload.blockIndex ||
          message.payload.bytes !== blockLength(file.size, this.nextBlock) ||
          (this.view.state !== 'active' && this.view.state !== 'paused')
        )
          throw new Error('Block outside accepted manifest.');
        this.assembler.begin(
          file.fileId,
          this.nextBlock,
          message.payload.bytes,
          message.payload.digest,
        );
        return;
      }
      if (message.type === 'FILE_END') {
        const previous = manifest.files.find((file) => file.fileId === message.payload.fileId);
        if (previous && this.verified.has(previous.fileId)) {
          await this.send('FILE_VERIFIED', {
            fileId: previous.fileId,
            sha256: previous.sha256,
            storageFinalized: true,
          });
          return;
        }
        const file = manifest.files[this.fileIndex];
        if (
          !this.storage ||
          !file ||
          file.fileId !== message.payload.fileId ||
          this.assembler?.assembling ||
          this.nextBlock !== Math.ceil(file.size / VERIFICATION_BLOCK_BYTES)
        )
          throw new Error('File is incomplete.');
        this.verifying = true;
        const finalized = await this.storage.finalizeFile(file.fileId);
        if (!this.active) return;
        if (finalized.sha256 !== file.sha256 || finalized.file.size !== file.size)
          throw new Error('Final file integrity mismatch.');
        this.outputs.set(file.fileId, finalized.file);
        this.verified.add(file.fileId);
        await this.send('FILE_VERIFIED', {
          fileId: file.fileId,
          sha256: finalized.sha256,
          storageFinalized: true,
        });
        this.fileIndex++;
        this.nextBlock = manifest.files[this.fileIndex]
          ? this.firstMissing(manifest.files[this.fileIndex]!.fileId)
          : 0;
        this.verifying = false;
        this.touch();
        return;
      }
      if (message.type === 'TRANSFER_FINALIZE') {
        if (
          message.payload.manifestDigest !== this.digest ||
          this.verified.size !== manifest.files.length ||
          this.view.committedBytes !== manifest.totalBytes ||
          this.view.state !== 'verifying'
        )
          throw new Error('Cannot finalize an unverified transfer.');
        const receipt =
          this.view.receipt ??
          receiptSchema.parse({
            receiptId: crypto.randomUUID(),
            transferId: manifest.transferId,
            manifestDigest: this.digest,
            epoch: this.options.epoch,
            totalBytes: manifest.totalBytes,
            files: manifest.files,
            destination: 'browser-temporary',
            completedAt: new Date().toISOString(),
          });
        this.update({ receipt });
        await this.send('TRANSFER_RECEIPT', receipt);
        return;
      }
      if (message.type === 'TRANSFER_RECEIPT') {
        const receipt = receiptSchema.parse(message.payload);
        if (
          this.options.role !== 'owner' ||
          receipt.transferId !== manifest.transferId ||
          receipt.epoch !== this.options.epoch ||
          receipt.manifestDigest !== this.digest ||
          receipt.totalBytes !== manifest.totalBytes ||
          JSON.stringify(receipt.files) !== JSON.stringify(manifest.files) ||
          this.verified.size !== manifest.files.length ||
          this.view.state !== 'verifying'
        )
          throw new Error('Invalid transfer receipt.');
        await this.send('RECEIPT_ACK', {
          receiptId: receipt.receiptId,
          manifestDigest: this.digest,
        });
        this.update({ receipt });
        await this.complete();
        return;
      }
      if (message.type === 'RECEIPT_ACK') {
        if (
          this.view.receipt?.receiptId !== message.payload.receiptId ||
          message.payload.manifestDigest !== this.digest ||
          this.view.state !== 'verifying'
        )
          throw new Error('Invalid receipt acknowledgment.');
        await this.complete();
        return;
      }
      throw new Error('Unexpected transfer control.');
    } catch {
      await this.fail(
        'Transfer data or storage verification failed. No completion was confirmed.',
        'invalid-data',
      );
    }
  }
  async receiveFrame(bytes: Uint8Array): Promise<void> {
    if (terminal(this.view.state) || this.abort.signal.aborted) return;
    try {
      const frame = decodeTransferFrame(bytes, this.options.frameBytes);
      if (frame.epoch < this.options.epoch) return;
      if (
        this.options.role !== 'receiver' ||
        !this.assembler ||
        !this.storage ||
        (this.view.state !== 'active' && this.view.state !== 'paused')
      )
        throw new Error('Unaccepted file data.');
      const block = this.assembler.append(frame);
      this.touch();
      if (!block) return;
      const length = block.bytes.length;
      this.pendingStorage = {
        fileId: block.fileId,
        blockIndex: block.blockIndex,
        digest: block.digest,
        length,
      };
      await this.storage.commitBlock(block.fileId, block.blockIndex, block.bytes, block.digest);
      if (!this.active) return;
      await this.acknowledgeStoredBlock();
    } catch (error) {
      if (isQuotaError(error) && this.pendingStorage && this.active) {
        this.update({
          storageFull: true,
          error:
            'Browser storage is full. Transfer paused; verified blocks are retained. Free space, then retry storage.',
        });
        await this.setPaused(true).catch(() => this.disconnect());
        return;
      }
      await this.fail(
        'A file fragment failed integrity or storage checks. No block acknowledgment was issued.',
        'invalid-data',
      );
    }
  }
  private async acknowledgeStoredBlock(): Promise<void> {
    const block = this.pendingStorage;
    if (!block) return;
    this.pendingStorage = null;
    this.nextBlock = this.firstMissing(block.fileId, block.blockIndex + 1);
    this.update({
      committedBytes: this.view.committedBytes + block.length,
      attemptBytes: this.view.attemptBytes + block.length,
      peakBlockBytes: this.assembler?.peakBytes ?? 0,
      storageFull: false,
      error: '',
    });
    this.maybeVerifying();
    await this.send('BLOCK_ACK', {
      fileId: block.fileId,
      blockIndex: block.blockIndex,
      digest: block.digest,
      committedBytes: this.view.committedBytes,
    });
  }
  async retryStorage(): Promise<void> {
    if (
      !this.active ||
      !this.view.storageFull ||
      !this.pendingStorage ||
      !this.storage?.retryCommit
    )
      return;
    try {
      await this.storage.retryCommit();
      if (!this.active) return;
      // Clear flow pause before the final ACK can transition this endpoint to verifying.
      this.update({ storageFull: false });
      await this.setPaused(false);
      await this.acknowledgeStoredBlock();
    } catch (error) {
      if (isQuotaError(error))
        this.update({
          error:
            'Browser storage is still full. Valid blocks remain saved. Free more space or cancel.',
        });
      else
        await this.fail(
          'Storage retry failed. Valid blocks can be checked after reopening.',
          'storage',
        );
    }
  }
  private waitFor(
    kind: 'BLOCK_ACK' | 'FILE_VERIFIED',
    fileId: string,
    blockIndex: number,
    digest: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { kind, fileId, blockIndex, digest, resolve, reject };
    });
  }
  private async sendFiles(): Promise<void> {
    const manifest = this.view.manifest!;
    for (const file of manifest.files) {
      for (
        let blockIndex = 0;
        blockIndex < Math.ceil(file.size / VERIFICATION_BLOCK_BYTES);
        blockIndex++
      ) {
        if (this.reused.has(`${file.fileId}:${blockIndex}`)) continue;
        await this.waitUntilResumed();
        this.abort.signal.throwIfAborted();
        const { bytes, digest } = await this.storage!.sourceBlock(file.fileId, blockIndex);
        this.abort.signal.throwIfAborted();
        const confirmed = this.waitFor('BLOCK_ACK', file.fileId, blockIndex, digest);
        // A cancellation may reject before the scheduler finishes; attach immediately.
        void confirmed.catch(() => {});
        await this.send('BLOCK_START', {
          fileId: file.fileId,
          blockIndex,
          bytes: bytes.length,
          digest,
        });
        await this.scheduler.sendBlock(
          {
            transferId: manifest.transferId,
            fileId: file.fileId,
            epoch: this.options.epoch,
            blockIndex,
          },
          bytes,
          this.abort.signal,
          () => this.waitUntilResumed(),
          (bytes) => this.update({ attemptBytes: this.view.attemptBytes + bytes }),
        );
        await confirmed;
      }
      await this.waitUntilResumed();
      this.abort.signal.throwIfAborted();
      this.verifying = true;
      this.touch();
      const verified = this.waitFor('FILE_VERIFIED', file.fileId, -1, file.sha256);
      void verified.catch(() => {});
      await this.send('FILE_END', { fileId: file.fileId });
      await verified;
    }
    this.maybeVerifying();
    await this.send('TRANSFER_FINALIZE', { manifestDigest: this.digest });
    this.touch();
  }
  private async waitUntilResumed(): Promise<void> {
    this.abort.signal.throwIfAborted();
    while (this.paused) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.abort.signal.throwIfAborted();
    }
  }
  async setPaused(paused: boolean): Promise<void> {
    if (this.view.state !== 'active' && this.view.state !== 'paused') return;
    if (!paused && this.view.storageFull) return;
    if (this.view.localPaused === paused) return;
    this.update({ localPaused: paused });
    this.applyPauseState();
    await this.send('FLOW_STATE', { paused });
  }
  private applyPauseState(): void {
    if (this.paused && this.view.state === 'active') this.transition({ type: 'PAUSE' });
    else if (!this.paused && this.view.state === 'paused') {
      this.transition({ type: 'RESUME' });
      this.maybeVerifying();
    }
    this.touch();
    this.wake?.();
    this.wake = null;
  }
  private async complete(): Promise<void> {
    if (this.options.role === 'receiver' && this.view.receipt)
      await this.storage?.rememberReceipt?.(this.view.receipt);
    this.transition({ type: 'VERIFY_SUCCESS', integrityVerified: true, storageFinalized: true });
    this.storage?.dispose();
    this.storage = null;
    clearInterval(this.timer);
  }
  private stop(): void {
    this.abort.abort();
    this.wake?.();
    this.wake = null;
    this.waiting?.reject(new Error('Transfer stopped.'));
    this.waiting = null;
    this.assembler?.clear();
    this.storage?.dispose();
    this.storage = null;
    clearInterval(this.timer);
  }
  async cancel(notify = true, preserve = false): Promise<void> {
    if (!this.active && this.view.state !== 'reconnecting') return;
    this.transition({ type: 'CANCEL' });
    this.stop();
    if (notify && this.view.manifest)
      await this.send('TRANSFER_CANCEL', { reason: 'user' }).catch(() => {});
    if (!preserve || (this.options.retention ?? 'discard') === 'discard') await this.cleanup();
  }
  private async fail(
    message: string,
    reason: 'timeout' | 'invalid-data' | 'storage' | 'integrity' | 'connection',
  ): Promise<void> {
    if (!this.active) return;
    this.transition({ type: 'FAIL', code: reason });
    this.update({ error: message });
    this.stop();
    if (this.view.manifest) await this.send('TRANSFER_CANCEL', { reason }).catch(() => {});
    if ((this.options.retention ?? 'discard') === 'discard') await this.cleanup();
  }
  disconnect(): void {
    if (!this.active) return;
    if (this.view.state === 'preparing') {
      void this.fail(
        'Preparation was interrupted. Reselect the original source to retry.',
        'connection',
      );
      return;
    }
    this.transition({ type: 'DISCONNECT' });
    this.update({
      recovery:
        'Connection interrupted. Saved blocks are retained. Reconnect, compare the new pairing code, then resume.',
      error: '',
    });
    this.stop();
    if ((this.options.retention ?? 'discard') === 'discard') void this.cleanup();
  }
  download(fileId: string): File | undefined {
    return this.view.state === 'complete' ? this.outputs.get(fileId) : undefined;
  }
  private async cleanup(): Promise<boolean> {
    try {
      if (
        this.options.role === 'owner' &&
        this.view.manifest &&
        this.options.retention &&
        typeof indexedDB !== 'undefined'
      )
        await new CheckpointDB().removeSource(this.view.manifest.transferId);
      if (!this.storageKey) return true;
      await (this.options.purgeStorage ?? purgeTemporaryStore)(this.storageKey);
      this.storageKey = null;
      this.outputs.clear();
      return true;
    } catch {
      this.update({
        error:
          this.view.error ||
          'Temporary browser data could not be removed. Clear site data if needed.',
      });
      return false;
    }
  }
  async dispose(purge = true): Promise<boolean> {
    this.stop();
    if (purge || (this.options.retention ?? 'discard') === 'discard') return this.cleanup();
    return true;
  }
}
