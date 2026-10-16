import {
  manifestSchema,
  receiptSchema,
  transitionTransfer,
  VERIFICATION_BLOCK_BYTES,
  MIN_TRANSFER_FRAME_BYTES,
  MAX_TRANSFER_BYTES,
} from '@meshdrop/protocol';
import type {
  FileControl,
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
};
const terminal = (state: TransferState | null) =>
  state === 'complete' || state === 'failed' || state === 'cancelled';
export interface TransferOptions {
  role: 'owner' | 'receiver';
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
        void this.sendFiles().catch(() => {
          if (this.active)
            void this.fail(
              'Transfer stopped before all bytes were verified and stored.',
              'invalid-data',
            );
        });
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
        this.nextBlock = 0;
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
    this.nextBlock++;
    this.update({
      committedBytes: this.view.committedBytes + block.length,
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
    if (!this.active) return;
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
    if (this.active)
      void this.fail(
        'Connection changed. Retained blocks can be checked in Saved transfers after reopening. Network resume is not available yet.',
        'connection',
      );
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
