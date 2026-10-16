import { TRANSFER_FRAME_HEADER_BYTES } from '@meshdrop/protocol';
import type { FileControlInput } from '@meshdrop/protocol';
import { encodeTransferFrame } from './FrameCodec';

export const SEND_HIGH_WATER_BYTES = 512 * 1024;
export const SEND_LOW_WATER_BYTES = 128 * 1024;
export interface TransferTransport {
  readonly bufferedAmount: number;
  sendControl(message: FileControlInput): Promise<void>;
  sendFrame(bytes: Uint8Array<ArrayBuffer>): void;
  waitForDrain(signal: AbortSignal): Promise<void>;
}
export class SenderScheduler {
  peakBufferedBytes = 0;
  peakBlockBytes = 0;
  private sequence = 0;
  constructor(
    private readonly transport: TransferTransport,
    readonly frameBytes: number,
  ) {}
  async sendBlock(
    context: { transferId: string; fileId: string; epoch: number; blockIndex: number },
    bytes: Uint8Array,
    signal: AbortSignal,
    waitUntilResumed: () => Promise<void>,
  ): Promise<void> {
    const payloadBytes = this.frameBytes - TRANSFER_FRAME_HEADER_BYTES;
    const fragmentCount = Math.ceil(bytes.length / payloadBytes);
    this.peakBlockBytes = Math.max(this.peakBlockBytes, bytes.length);
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
      signal.throwIfAborted();
      await waitUntilResumed();
      signal.throwIfAborted();
      const blockOffset = fragmentIndex * payloadBytes;
      const frame = encodeTransferFrame(
        {
          ...context,
          sequence: this.sequence++,
          fragmentIndex,
          fragmentCount,
          blockOffset,
          payload: bytes.subarray(blockOffset, Math.min(bytes.length, blockOffset + payloadBytes)),
        },
        this.frameBytes,
      );
      if (this.transport.bufferedAmount + frame.length > SEND_HIGH_WATER_BYTES)
        await this.transport.waitForDrain(signal);
      signal.throwIfAborted();
      this.transport.sendFrame(frame);
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.transport.bufferedAmount);
    }
  }
}
