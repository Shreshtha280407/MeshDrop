export type BlockRange = readonly [number, number];
/** Sorted, disjoint, bounded inclusive ranges. Never silently accept overlapping peer input. */
export function normalizeRanges(input: readonly BlockRange[], totalBlocks: number): BlockRange[] {
  if (!Number.isInteger(totalBlocks) || totalBlocks < 0 || totalBlocks > 65536)
    throw new Error('Invalid block count.');
  if (!Array.isArray(input) || input.length > totalBlocks)
    throw new Error('Range count exceeds file block count.');
  if (input.some((range) => !Array.isArray(range) || range.length !== 2))
    throw new Error('Invalid range tuple.');
  const sorted = input.map(([a, b]) => [a, b] as const).sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const [a, b] of sorted) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b >= totalBlocks)
      throw new Error('Range outside file.');
    const last = result.at(-1);
    if (last && a <= last[1]) throw new Error('Overlapping ranges.');
    if (last && a === last[1] + 1) last[1] = b;
    else result.push([a, b]);
  }
  return result;
}
export function missingBlocks(total: number, have: readonly BlockRange[]): BlockRange[] {
  const ranges = normalizeRanges(have, total);
  const result: BlockRange[] = [];
  let start = 0;
  for (const [a, b] of ranges) {
    if (start < a) result.push([start, a - 1]);
    start = b + 1;
  }
  if (start < total) result.push([start, total - 1]);
  return result;
}
