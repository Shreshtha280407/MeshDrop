import {
  decodeDataFrame,
  encodeDataFrame,
  FRAME_HEADER_BYTES,
  TRANSFER_FRAME_HEADER_BYTES,
  DEFAULT_FRAME_BYTES,
} from '@meshdrop/protocol';
import type { DataFrame } from '@meshdrop/protocol';

export interface TransferFrame extends DataFrame {
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
}
function fragments(index: number, count: number): void {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1048576 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new Error('Invalid fragment index/count.');
}
/** DATA type 2 adds explicit fragment index/count. Historical P0 DATA type 1 stays unchanged. */
export function encodeTransferFrame(
  frame: TransferFrame,
  ceiling = DEFAULT_FRAME_BYTES,
): Uint8Array<ArrayBuffer> {
  fragments(frame.fragmentIndex, frame.fragmentCount);
  const base = encodeDataFrame(frame, ceiling - (TRANSFER_FRAME_HEADER_BYTES - FRAME_HEADER_BYTES));
  const wire = new Uint8Array(base.length + 8);
  wire.set(base.subarray(0, FRAME_HEADER_BYTES));
  wire[5] = 2;
  const view = new DataView(wire.buffer);
  view.setUint32(64, frame.fragmentIndex);
  view.setUint32(68, frame.fragmentCount);
  wire.set(frame.payload, TRANSFER_FRAME_HEADER_BYTES);
  return wire;
}
export function decodeTransferFrame(
  wire: Uint8Array,
  ceiling = DEFAULT_FRAME_BYTES,
): TransferFrame {
  if (wire.length < TRANSFER_FRAME_HEADER_BYTES || wire.length > ceiling || wire[5] !== 2)
    throw new Error('Invalid transfer DATA frame.');
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const fragmentIndex = view.getUint32(64);
  const fragmentCount = view.getUint32(68);
  fragments(fragmentIndex, fragmentCount);
  const base = new Uint8Array(wire.length - 8);
  base.set(wire.subarray(0, FRAME_HEADER_BYTES));
  base[5] = 1;
  base.set(wire.subarray(TRANSFER_FRAME_HEADER_BYTES), FRAME_HEADER_BYTES);
  return { ...decodeDataFrame(base, ceiling - 8), fragmentIndex, fragmentCount };
}
