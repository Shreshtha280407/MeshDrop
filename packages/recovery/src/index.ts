/** Inclusive block indexes. Validate, bound and normalize before trusting in P5. */
export type BlockRange = readonly [start: number, end: number];
export interface Checkpoint {
  readonly version: 1;
  readonly transferId: string;
  readonly fileId: string;
  readonly manifestDigest: string;
  readonly fileSize: number;
  readonly blockSize: number;
  readonly epoch: number;
  readonly committedRanges: readonly BlockRange[];
  readonly updatedAt: string;
}
export interface RecoveryEngine {
  revalidate(checkpoint: Checkpoint): Promise<readonly BlockRange[]>;
  missingBlocks(totalBlocks: number, verifiedRanges: readonly BlockRange[]): readonly BlockRange[];
}
