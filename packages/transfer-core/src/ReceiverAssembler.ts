import { TRANSFER_FRAME_HEADER_BYTES } from '@meshdrop/protocol';
import type { TransferFrame } from './FrameCodec';

export class ReceiverAssembler {
  private block: {
    fileId: string;
    blockIndex: number;
    bytes: Uint8Array<ArrayBuffer>;
    digest: string;
    offset: number;
    fragment: number;
  } | null = null;
  private sequence = -1;
  peakBytes = 0;
  constructor(
    private readonly transferId: string,
    private readonly epoch: number,
    private readonly frameBytes: number,
  ) {}
  begin(fileId: string, blockIndex: number, bytes: number, digest: string): void {
    if (this.block) throw new Error('A verification block is already in flight.');
    this.block = {
      fileId,
      blockIndex,
      bytes: new Uint8Array(bytes),
      digest,
      offset: 0,
      fragment: 0,
    };
    this.peakBytes = Math.max(this.peakBytes, bytes);
  }
  append(
    frame: TransferFrame,
  ): { fileId: string; blockIndex: number; bytes: Uint8Array<ArrayBuffer>; digest: string } | null {
    const block = this.block;
    const payloadBytes = this.frameBytes - TRANSFER_FRAME_HEADER_BYTES;
    if (
      !block ||
      frame.transferId !== this.transferId ||
      frame.epoch !== this.epoch ||
      frame.fileId !== block.fileId ||
      frame.blockIndex !== block.blockIndex ||
      frame.sequence !== this.sequence + 1 ||
      frame.blockOffset !== block.offset ||
      frame.fragmentIndex !== block.fragment ||
      frame.fragmentCount !== Math.ceil(block.bytes.length / payloadBytes) ||
      frame.payload.length !== Math.min(payloadBytes, block.bytes.length - block.offset)
    )
      throw new Error('Duplicate, out-of-order or out-of-bounds transfer fragment.');
    block.bytes.set(frame.payload, block.offset);
    block.offset += frame.payload.length;
    block.fragment++;
    this.sequence = frame.sequence;
    if (block.offset !== block.bytes.length) return null;
    this.block = null;
    return {
      fileId: block.fileId,
      blockIndex: block.blockIndex,
      bytes: block.bytes,
      digest: block.digest,
    };
  }
  get assembling(): boolean {
    return this.block !== null;
  }
  clear(): void {
    this.block = null;
  }
}
