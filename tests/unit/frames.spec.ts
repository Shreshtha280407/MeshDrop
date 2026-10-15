import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_BYTES,
  DEFAULT_PAYLOAD_BYTES,
  FRAME_HEADER_BYTES,
  VERIFICATION_BLOCK_BYTES,
  decodeDataFrame,
  encodeDataFrame,
} from '@meshdrop/protocol';
import fixture from '../fixtures/frame-v1.json';

const frame = {
  transferId: fixture.transferId,
  fileId: fixture.fileId,
  epoch: fixture.epoch,
  blockIndex: fixture.blockIndex,
  blockOffset: fixture.blockOffset,
  sequence: fixture.sequence,
  payload: Uint8Array.from(Buffer.from(fixture.payloadHex, 'hex')),
};
describe('binary data framing v1', () => {
  it('matches independently specified golden bytes in both directions', () => {
    expect(Buffer.from(encodeDataFrame(frame)).toString('hex')).toBe(fixture.wireHex);
    expect(decodeDataFrame(Uint8Array.from(Buffer.from(fixture.wireHex, 'hex')))).toEqual(frame);
  });
  it('includes the 64-byte header in the 16 KiB ceiling', () => {
    const full = { ...frame, blockOffset: 0, payload: new Uint8Array(DEFAULT_PAYLOAD_BYTES) };
    expect(encodeDataFrame(full)).toHaveLength(DEFAULT_FRAME_BYTES);
    expect(() =>
      encodeDataFrame({ ...full, payload: new Uint8Array(DEFAULT_PAYLOAD_BYTES + 1) }),
    ).toThrow();
  });
  it('respects negotiated smaller frame caps', () => {
    const encoded = encodeDataFrame(frame, 80);
    expect(decodeDataFrame(encoded, 80)).toEqual(frame);
    expect(() => decodeDataFrame(encoded, 66)).toThrow();
    for (const cap of [0, FRAME_HEADER_BYTES, DEFAULT_FRAME_BYTES + 1, 1.5, Number.NaN])
      expect(() => encodeDataFrame(frame, cap)).toThrow();
  });
  it.each([0, 4, 5, 6, 60])('rejects unsupported header field at byte %s', (offset) => {
    const bytes = encodeDataFrame(frame);
    bytes[offset] = 255;
    expect(() => decodeDataFrame(bytes)).toThrow();
  });
  it('rejects truncated frames, wrong lengths and trailing bytes', () => {
    const bytes = encodeDataFrame(frame);
    for (const invalid of [bytes.slice(0, 10), bytes.slice(0, -1), new Uint8Array([...bytes, 0])])
      expect(() => decodeDataFrame(invalid)).toThrow();
  });
  it('rejects empty payloads, non-UUID ids and invalid uint32 fields', () => {
    for (const invalid of [
      { ...frame, payload: new Uint8Array() },
      { ...frame, fileId: 'invalid' },
      { ...frame, epoch: -1 },
      { ...frame, sequence: 2 ** 32 },
      { ...frame, blockIndex: 0.1 },
    ])
      expect(() => encodeDataFrame(invalid)).toThrow();
  });
  it('rejects fragments crossing logical block boundaries', () => {
    expect(() => encodeDataFrame({ ...frame, blockOffset: VERIFICATION_BLOCK_BYTES - 2 })).toThrow(
      'boundary',
    );
  });
  it('handles nonzero view offsets and returns independent payload bytes', () => {
    const wire = encodeDataFrame(frame);
    const padded = new Uint8Array(wire.length + 17);
    padded.set(wire, 9);
    const decoded = decodeDataFrame(padded.subarray(9, 9 + wire.length));
    expect(decoded).toEqual(frame);
    padded.fill(0);
    expect(decoded.payload).toEqual(frame.payload);
  });
});
