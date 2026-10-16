import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { manifestSchema, safeRelativePath, VERIFICATION_BLOCK_BYTES } from '@meshdrop/protocol';
import {
  encodeTransferFrame,
  decodeTransferFrame,
} from '../../packages/transfer-core/src/FrameCodec';
import { ReceiverAssembler } from '../../packages/transfer-core/src/ReceiverAssembler';
import { blockLength, manifestDigest } from '../../packages/transfer-core/src/Manifest';
import {
  SenderScheduler,
  SEND_HIGH_WATER_BYTES,
} from '../../packages/transfer-core/src/SenderScheduler';

const transferId = randomUUID();
const fileId = randomUUID();
const manifest = {
  version: 1 as const,
  transferId,
  revision: 1 as const,
  blockBytes: VERIFICATION_BLOCK_BYTES,
  files: [{ fileId, path: 'folder/file.bin', size: 17 * 1024, sha256: 'a'.repeat(64) }],
  totalBytes: 17 * 1024,
};
it.each([
  '../escape',
  '/absolute',
  'C:/drive',
  'a\\b',
  'a/../b',
  'a//b',
  'CON.txt',
  'aux',
  'a\u0000b',
  'a\u202eb',
  'end.',
  ' space',
  'x/'.repeat(9) + 'x',
])('rejects unsafe relative path %j', (path) => expect(safeRelativePath(path)).toBe(false));
it.each(['report.txt', 'folder/photo 1.jpg', 'notes/अभ्यास.txt', 'zero.bin'])(
  'accepts safe names %j',
  (path) => expect(safeRelativePath(path)).toBe(true),
);
it('binds manifest digest to exact metadata and rejects duplicate IDs, path collisions and false totals', async () => {
  const digest = await manifestDigest(manifest);
  expect(digest).toBe(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
  expect(
    await manifestDigest({
      ...manifest,
      files: [{ ...manifest.files[0]!, path: 'different.bin' }],
    }),
  ).not.toBe(digest);
  for (const value of [
    { ...manifest, totalBytes: 1 },
    {
      ...manifest,
      files: [manifest.files[0], manifest.files[0]],
      totalBytes: manifest.totalBytes * 2,
    },
    {
      ...manifest,
      files: [
        manifest.files[0],
        { ...manifest.files[0], fileId: randomUUID(), path: 'FOLDER/FILE.BIN' },
      ],
      totalBytes: manifest.totalBytes * 2,
    },
    { ...manifest, files: [] },
  ])
    expect(manifestSchema.safeParse(value).success).toBe(false);
});
it('bounds logical blocks including empty files', () => {
  expect(blockLength(VERIFICATION_BLOCK_BYTES + 17, 1)).toBe(17);
  expect(() => blockLength(0, 0)).toThrow();
  expect(() => blockLength(1, 1)).toThrow();
  expect(() => blockLength(1, -1)).toThrow();
});
const frame = {
  transferId,
  fileId,
  epoch: 1,
  blockIndex: 0,
  blockOffset: 0,
  sequence: 0,
  fragmentIndex: 0,
  fragmentCount: 1,
  payload: new Uint8Array([1, 2, 3]),
};
it('encodes explicit fragment index/count without changing historical v1 DATA frames', () => {
  const wire = encodeTransferFrame(frame);
  expect(wire.length).toBe(75);
  expect(wire[5]).toBe(2);
  expect(new DataView(wire.buffer).getUint32(68)).toBe(1);
  expect(decodeTransferFrame(wire)).toEqual(frame);
  wire[74] = 9;
  expect(frame.payload[2]).toBe(3);
});
it.each(['length', 'index', 'count', 'kind', 'flags', 'version', 'oversize'] as const)(
  'rejects malformed transfer frame %s',
  (field) => {
    let wire = encodeTransferFrame(frame);
    const view = new DataView(wire.buffer);
    if (field === 'length') view.setUint32(52, 900);
    if (field === 'index') view.setUint32(64, 1);
    if (field === 'count') view.setUint32(68, 0);
    if (field === 'kind') wire[5] = 1;
    if (field === 'flags') wire[6] = 1;
    if (field === 'version') wire[4] = 2;
    if (field === 'oversize') wire = new Uint8Array(16385);
    expect(() => decodeTransferFrame(wire)).toThrow();
  },
);
describe('bounded assembler and sender', () => {
  it('assembles exactly one block and rejects duplicate, misaligned and cross-transfer fragments', () => {
    const assembly = new ReceiverAssembler(transferId, 1, 1024);
    assembly.begin(fileId, 0, 1000, 'a'.repeat(64));
    expect(
      assembly.append({ ...frame, fragmentCount: 2, payload: new Uint8Array(952) }),
    ).toBeNull();
    expect(() =>
      assembly.append({ ...frame, fragmentCount: 2, payload: new Uint8Array(952) }),
    ).toThrow();
    const result = assembly.append({
      ...frame,
      blockOffset: 952,
      sequence: 1,
      fragmentIndex: 1,
      fragmentCount: 2,
      payload: new Uint8Array(48),
    });
    expect(result?.bytes.length).toBe(1000);
    expect(assembly.peakBytes).toBe(1000);
    expect(() => assembly.append(frame)).toThrow();
    assembly.begin(fileId, 1, 1, 'a'.repeat(64));
    expect(() =>
      assembly.append({
        ...frame,
        sequence: 2,
        blockIndex: 1,
        transferId: randomUUID(),
        payload: new Uint8Array(1),
      }),
    ).toThrow();
  });
  it('honors negotiated message size and drain watermark, without buffering a file', async () => {
    let buffered = SEND_HIGH_WATER_BYTES - 100;
    let drains = 0;
    let frames = 0;
    const signal = new AbortController();
    const transport = {
      get bufferedAmount() {
        return buffered;
      },
      sendControl: async () => {},
      sendFrame: (wire: Uint8Array) => {
        expect(wire.length).toBeLessThanOrEqual(8192);
        buffered += wire.length;
        frames++;
      },
      waitForDrain: async () => {
        drains++;
        buffered = 0;
      },
    };
    const scheduler = new SenderScheduler(transport, 8192);
    await scheduler.sendBlock(
      { transferId, fileId, epoch: 1, blockIndex: 0 },
      new Uint8Array(VERIFICATION_BLOCK_BYTES),
      signal.signal,
      async () => {},
    );
    expect(drains).toBeGreaterThan(0);
    expect(frames).toBe(Math.ceil(VERIFICATION_BLOCK_BYTES / (8192 - 72)));
    expect(scheduler.peakBufferedBytes).toBeLessThanOrEqual(SEND_HIGH_WATER_BYTES);
    expect(scheduler.peakBlockBytes).toBe(VERIFICATION_BLOCK_BYTES);
    signal.abort();
    await expect(
      scheduler.sendBlock(
        { transferId, fileId, epoch: 1, blockIndex: 0 },
        new Uint8Array(1),
        signal.signal,
        async () => {},
      ),
    ).rejects.toThrow();
  });
});
