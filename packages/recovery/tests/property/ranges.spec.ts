import { expect, it } from 'vitest';
import { missingBlocks, normalizeRanges } from '../../src/RangeSet';
import type { BlockRange } from '../../src/RangeSet';

it('seed 0x8badf00d: 2000 range sets match an independent bitset complement', () => {
  let seed = 0x8badf00d;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let run = 0; run < 2000; run++) {
    const total = random() % 257;
    const have = Array.from({ length: total }, () => random() % 3 === 0);
    const input: BlockRange[] = have
      .flatMap((present, i) => (present ? [[i, i] as const] : []))
      .reverse();
    const before = JSON.stringify(input);
    const normalized = normalizeRanges(input, total);
    expect(normalizeRanges(normalized, total)).toEqual(normalized);
    const missing = missingBlocks(total, input);
    const expanded = new Set(
      missing.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)),
    );
    expect(Array.from({ length: total }, (_, i) => expanded.has(i))).toEqual(
      have.map((value) => !value),
    );
    expect(JSON.stringify(input)).toBe(before);
  }
});
it('rejects overlaps, extreme counts and invalid endpoints before range allocation', () => {
  expect(() => normalizeRanges([[0, 0, 1]] as unknown as BlockRange[], 1)).toThrow(
    'Invalid range tuple.',
  );
  for (const [ranges, total] of [
    [
      [
        [0, 2],
        [2, 3],
      ],
      4,
    ],
    [
      [
        [0, 0],
        [0, 0],
      ],
      1,
    ],
    [[[0, 65536]], 65536],
    [[[NaN, 1]], 2],
    [[[0, Infinity]], 2],
    [[[1, 0]], 2],
    [[[-1, 0]], 2],
    [[], 65537],
    [[], Infinity],
    [new Array(65537), 65536],
  ] as [BlockRange[], number][])
    expect(() => normalizeRanges(ranges, total)).toThrow();
});
