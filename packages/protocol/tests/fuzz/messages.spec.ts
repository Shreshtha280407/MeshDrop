import { expect, it } from 'vitest';
import {
  decodeDataFrame,
  encodeDataFrame,
  parseSignalingMessage,
  serializeSignalingMessage,
} from '../../src/index';
import { decodeTransferFrame, encodeTransferFrame } from '../../../transfer-core/src/FrameCodec';
import fixture from '../../../../tests/fixtures/frame-v1.json';

it('rejects oversized UTF-8 SDP/ICE, unknown keys and extreme numeric fields from valid seeds', () => {
  const base = {
    version: 1,
    type: 'SDP_OFFER',
    roomId: fixture.transferId,
    peerId: fixture.fileId,
    messageId: fixture.transferId,
    epoch: 1,
    seq: 1,
    sentAt: '2026-10-18T00:00:00.000Z',
    payload: { sdp: 'v=0' },
  };
  expect(parseSignalingMessage(JSON.stringify(base))).toMatchObject(base);
  const invalid = [
    { ...base, payload: { sdp: '猫'.repeat(17000) } },
    { ...base, seq: 2 ** 32 },
    { ...base, epoch: -1 },
    { ...base, version: 2 },
    { ...base, ownerCapability: 'private-canary' },
    {
      ...base,
      type: 'ICE_CANDIDATE',
      payload: { candidate: '猫'.repeat(1400), sdpMid: null, sdpMLineIndex: null },
    },
  ];
  for (const message of invalid)
    expect(() => parseSignalingMessage(JSON.stringify(message))).toThrow();
});

it('seed 0xc0ffee: 5000 bounded arbitrary byte/JSON inputs reject or round-trip canonically', () => {
  let seed = 0xc0ffee;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  for (let run = 0; run < 5000; run++) {
    const bytes = Uint8Array.from({ length: random() % 200 }, () => random() >>> 24);
    let decoded;
    try {
      decoded = decodeDataFrame(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    if (decoded) expect(decodeDataFrame(encodeDataFrame(decoded))).toEqual(decoded);
    const text =
      run % 2
        ? new TextDecoder().decode(bytes)
        : JSON.stringify({
            type: ['SDP_OFFER', 'ERROR', null][run % 3],
            payload: Array.from(bytes),
          });
    let parsed;
    try {
      parsed = parseSignalingMessage(text);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    if (parsed) expect(parseSignalingMessage(serializeSignalingMessage(parsed))).toEqual(parsed);
  }
});
it('mutates every transfer header byte and 1000 valid payload geometries without unbounded allocation', () => {
  for (let run = 1; run <= 1000; run++) {
    const frame = {
      transferId: fixture.transferId,
      fileId: fixture.fileId,
      epoch: 1,
      blockIndex: 0,
      blockOffset: 0,
      sequence: run,
      fragmentIndex: 0,
      fragmentCount: 1,
      payload: new Uint8Array((run % 512) + 1).fill(run % 256),
    };
    const wire = encodeTransferFrame(frame);
    expect(decodeTransferFrame(wire)).toEqual(frame);
    if (run <= 72) {
      const altered = wire.slice();
      altered[run - 1] = altered[run - 1]! ^ 255;
      let parsed;
      try {
        parsed = decodeTransferFrame(altered);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      if (parsed) expect(decodeTransferFrame(encodeTransferFrame(parsed))).toEqual(parsed);
    }
  }
});
