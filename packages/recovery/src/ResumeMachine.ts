import { RESUME_PROOF_PAGE_SIZE } from '@meshdrop/protocol';
import type { BlockProof, TransferManifest } from '@meshdrop/protocol';
import { checkpointDigest, proofBytes, proofKey } from './Reconciliation';
/** Pure bounded handshake state. The transport authenticates room, peer, transcript, epoch and sequence. */
export class ResumeMachine {
  readonly accepted = new Map<string, BlockProof>();
  private seen = new Set<string>();
  private page = 0;
  private finished = false;
  private announced: BlockProof[] = [];
  constructor(
    readonly manifest: TransferManifest,
    readonly digest: string,
    readonly attemptId: string,
  ) {}
  assertScope(attemptId: string, digest: string): void {
    if (attemptId !== this.attemptId || digest !== this.digest)
      throw new Error('Resume scope changed.');
  }
  async have(
    page: number,
    last: boolean,
    blocks: readonly BlockProof[],
    authenticate: (proof: BlockProof) => Promise<boolean>,
  ): Promise<number[]> {
    if (
      this.finished ||
      page !== this.page ||
      blocks.length > RESUME_PROOF_PAGE_SIZE ||
      (!last && blocks.length !== RESUME_PROOF_PAGE_SIZE)
    )
      throw new Error('Duplicate or out-of-order resume page.');
    const rejected: number[] = [];
    for (const [index, block] of blocks.entries()) {
      proofBytes(this.manifest, block);
      const key = proofKey(block);
      if (this.seen.has(key)) throw new Error('Duplicate resume proof.');
      this.seen.add(key);
      this.announced.push(block);
      if (await authenticate(block)) this.accepted.set(key, block);
      else rejected.push(index);
    }
    this.page++;
    this.finished = last;
    return rejected;
  }
  get reusedBytes(): number {
    return [...this.accepted.values()].reduce((sum, b) => sum + proofBytes(this.manifest, b), 0);
  }
  get digestOfAccepted(): string {
    return checkpointDigest(this.digest, [...this.accepted.values()]);
  }
  confirm(originalDigest: string, acceptedDigest: string, bytes: number): void {
    if (
      !this.finished ||
      checkpointDigest(this.digest, this.announced) !== originalDigest ||
      this.digestOfAccepted !== acceptedDigest ||
      bytes !== this.reusedBytes
    )
      throw new Error('Resume checkpoint proof mismatch.');
  }
}
