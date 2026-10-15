import {
  DEFAULT_FRAME_BYTES,
  FRAME_HEADER_BYTES,
  MAX_UINT32,
  PROTOCOL_VERSION,
  VERIFICATION_BLOCK_BYTES,
} from './constants';
import { uuidSchema } from './schemas';

const MAGIC = 0x4d445031; // ASCII MDP1, network byte order.
export interface DataFrame {
  readonly transferId: string;
  readonly fileId: string;
  readonly epoch: number;
  readonly blockIndex: number;
  readonly blockOffset: number;
  readonly sequence: number;
  readonly payload: Uint8Array;
}

function validateCap(maxFrameBytes: number): void {
  if (
    !Number.isInteger(maxFrameBytes) ||
    maxFrameBytes <= FRAME_HEADER_BYTES ||
    maxFrameBytes > DEFAULT_FRAME_BYTES
  )
    throw new Error('Invalid negotiated frame ceiling.');
}
function validateFrame(frame: DataFrame, maxFrameBytes: number): void {
  validateCap(maxFrameBytes);
  uuidSchema.parse(frame.transferId);
  uuidSchema.parse(frame.fileId);
  for (const value of [frame.epoch, frame.blockIndex, frame.blockOffset, frame.sequence]) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32)
      throw new Error('Invalid unsigned frame field.');
  }
  if (
    frame.payload.byteLength === 0 ||
    frame.payload.byteLength + FRAME_HEADER_BYTES > maxFrameBytes
  )
    throw new Error('Invalid frame payload length.');
  if (frame.blockOffset + frame.payload.byteLength > VERIFICATION_BLOCK_BYTES)
    throw new Error('Frame crosses a verification block boundary.');
}
function writeUuid(bytes: Uint8Array, offset: number, uuid: string): void {
  const hex = uuid.replaceAll('-', '');
  for (let i = 0; i < 16; i++) bytes[offset + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
}
function readUuid(bytes: Uint8Array, offset: number): string {
  const hex = Array.from(bytes.subarray(offset, offset + 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function encodeDataFrame(frame: DataFrame, maxFrameBytes = DEFAULT_FRAME_BYTES): Uint8Array {
  validateFrame(frame, maxFrameBytes);
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC);
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, 1); // DATA; flags and reserved words remain zero.
  writeUuid(bytes, 8, frame.transferId);
  writeUuid(bytes, 24, frame.fileId);
  view.setUint32(40, frame.epoch);
  view.setUint32(44, frame.blockIndex);
  view.setUint32(48, frame.blockOffset);
  view.setUint32(52, frame.payload.byteLength);
  view.setUint32(56, frame.sequence);
  bytes.set(frame.payload, FRAME_HEADER_BYTES);
  return bytes;
}
export function decodeDataFrame(bytes: Uint8Array, maxFrameBytes = DEFAULT_FRAME_BYTES): DataFrame {
  validateCap(maxFrameBytes);
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes.byteLength > maxFrameBytes)
    throw new Error('Invalid frame size.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0) !== MAGIC ||
    view.getUint8(4) !== PROTOCOL_VERSION ||
    view.getUint8(5) !== 1 ||
    view.getUint16(6) !== 0 ||
    view.getUint32(60) !== 0
  )
    throw new Error('Unsupported frame header.');
  if (view.getUint32(52) !== bytes.byteLength - FRAME_HEADER_BYTES)
    throw new Error('Frame payload length mismatch.');
  const frame: DataFrame = {
    transferId: readUuid(bytes, 8),
    fileId: readUuid(bytes, 24),
    epoch: view.getUint32(40),
    blockIndex: view.getUint32(44),
    blockOffset: view.getUint32(48),
    sequence: view.getUint32(56),
    payload: bytes.slice(FRAME_HEADER_BYTES),
  };
  validateFrame(frame, maxFrameBytes);
  return frame;
}
