import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RESUME_PROOF_PAGE_SIZE, fileControlSchema } from '@meshdrop/protocol';
import type { BlockProof, TransferManifest } from '@meshdrop/protocol';
import {
  checkpointDigest,
  missingBlocks,
  normalizeRanges,
  ResumeMachine,
  RetryPolicy,
  validateResumeEpoch,
  sourceReselectEntries,
} from '../../packages/recovery/src/index';
const id = randomUUID(),
  fileId = randomUUID(),
  digest = 'a'.repeat(64);
const manifest: TransferManifest = {
  version: 1,
  revision: 1,
  transferId: id,
  blockBytes: 1048576,
  files: [{ fileId, path: 'original.bin', size: 40 * 1048576, sha256: digest }],
  totalBytes: 40 * 1048576,
};
const proof = (index: number): BlockProof => ({ fileId, index, digest });
it('normalizes bounded ranges and requests only complement holes including tail and empty files', () => {
  expect(
    normalizeRanges(
      [
        [4, 4],
        [0, 1],
        [2, 2],
      ],
      6,
    ),
  ).toEqual([
    [0, 2],
    [4, 4],
  ]);
  expect(
    missingBlocks(6, [
      [0, 2],
      [4, 4],
    ]),
  ).toEqual([
    [3, 3],
    [5, 5],
  ]);
  expect(missingBlocks(0, [])).toEqual([]);
  for (const ranges of [
    [
      [0, 1],
      [1, 2],
    ],
    [[-1, 0]],
    [[0, 6]],
    [[2, 1]],
    [[0.1, 1]],
  ] as const)
    expect(() => normalizeRanges(ranges, 6)).toThrow();
});
it('binds deterministic checkpoint hashes to full proof content and manifest', () => {
  expect(checkpointDigest(digest, [proof(1), proof(0)])).toBe(
    checkpointDigest(digest, [proof(0), proof(1)]),
  );
  expect(checkpointDigest(digest, [proof(0)])).not.toBe(
    checkpointDigest('b'.repeat(64), [proof(0)]),
  );
  expect(checkpointDigest(digest, [proof(0)])).not.toBe(
    checkpointDigest(digest, [{ ...proof(0), digest: 'b'.repeat(64) }]),
  );
});
it('proves receiver ranges against the source and binds both original and accepted checkpoint digests', async () => {
  const blocks = [proof(0), proof(2), proof(3)];
  const machine = new ResumeMachine(manifest, digest, randomUUID());
  expect(await machine.have(0, true, blocks, async (block) => block.index !== 2)).toEqual([1]);
  expect(machine.reusedBytes).toBe(2 * 1048576);
  expect(() =>
    machine.confirm(
      checkpointDigest(digest, blocks),
      checkpointDigest(digest, [proof(0), proof(3)]),
      2 * 1048576,
    ),
  ).not.toThrow();
  expect(() =>
    machine.confirm(checkpointDigest(digest, blocks), 'f'.repeat(64), 2 * 1048576),
  ).toThrow();
  expect(() => machine.assertScope(randomUUID(), digest)).toThrow();
  await expect(machine.have(0, true, blocks, async () => true)).rejects.toThrow();
});
it('requires ordered proof pages, rejects duplicates and out-of-bounds blocks before reuse', async () => {
  const machine = new ResumeMachine(manifest, digest, randomUUID());
  await expect(machine.have(1, true, [], async () => true)).rejects.toThrow();
  await expect(machine.have(0, false, [proof(0)], async () => true)).rejects.toThrow();
  const page = Array.from({ length: RESUME_PROOF_PAGE_SIZE }, (_, index) => proof(index));
  await machine.have(0, false, page, async () => true);
  await expect(machine.have(1, true, [proof(0)], async () => true)).rejects.toThrow();
  const other = new ResumeMachine(manifest, digest, randomUUID());
  await expect(other.have(0, true, [proof(40)], async () => true)).rejects.toThrow();
});
it('cannot reuse an earlier epoch of the same room, while fresh room admission creates a new scope', () => {
  const roomId = randomUUID();
  expect(() => validateResumeEpoch({ roomId, epoch: 3 }, { roomId, epoch: 3 })).toThrow();
  expect(() => validateResumeEpoch({ roomId, epoch: 3 }, { roomId, epoch: 2 })).toThrow();
  expect(() => validateResumeEpoch({ roomId, epoch: 3 }, { roomId, epoch: 4 })).not.toThrow();
  expect(() =>
    validateResumeEpoch({ roomId, epoch: 3 }, { roomId: randomUUID(), epoch: 1 }),
  ).not.toThrow();
});
it('caps retries exponentially and resets only on explicit retry or a ready connection', () => {
  const retry = new RetryPolicy();
  expect(Array.from({ length: 5 }, () => retry.next(0).nextAt)).toEqual([
    1000, 2000, 4000, 8000, 16000,
  ]);
  expect(retry.next(0)).toEqual({ attempt: 5, nextAt: null, exhausted: true });
  expect(retry.mode(1)).toBe('ice-restart');
  expect(retry.mode(2)).toBe('new-connection');
  retry.reset();
  expect(retry.next(0).attempt).toBe(1);
});
it('preserves manifest IDs during source selection and rejects changed names or sizes', () => {
  const small = { ...manifest, files: [{ ...manifest.files[0]!, size: 3 }], totalBytes: 3 };
  const file = new File(['abc'], 'original.bin');
  expect(sourceReselectEntries(small, [file])[0]).toEqual({ fileId, path: 'original.bin', file });
  expect(() => sourceReselectEntries(small, [new File(['abc'], 'other.bin')])).toThrow();
  expect(() => sourceReselectEntries(small, [new File(['abcd'], 'original.bin')])).toThrow();
});
it('bounds resume controls and proof pages on the wire', () => {
  const base = {
    version: 1,
    roomId: randomUUID(),
    peerId: randomUUID(),
    epoch: 2,
    transcript: digest,
    messageId: randomUUID(),
    seq: 0,
    transferId: id,
  };
  const wire = {
    ...base,
    type: 'HAVE_RANGES',
    payload: {
      attemptId: randomUUID(),
      manifestDigest: digest,
      page: 0,
      last: false,
      blocks: Array.from({ length: 32 }, (_, index) => proof(index)),
    },
  };
  expect(fileControlSchema.safeParse(wire).success).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(wire)).length).toBeLessThan(8192);
  expect(
    fileControlSchema.safeParse({
      ...wire,
      payload: { ...wire.payload, blocks: [...wire.payload.blocks, proof(32)] },
    }).success,
  ).toBe(false);
});
