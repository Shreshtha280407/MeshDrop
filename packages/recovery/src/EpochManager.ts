/** Epochs are monotonic within a newly authorized room; a different room needs fresh SAS consent. */
export function validateResumeEpoch(
  previous: { roomId: string; epoch: number } | undefined,
  next: { roomId: string; epoch: number },
): void {
  if (
    !Number.isInteger(next.epoch) ||
    next.epoch < 1 ||
    next.epoch > 0xffffffff ||
    (previous?.roomId === next.roomId && next.epoch <= previous.epoch)
  )
    throw new Error('Resume requires a fresh connection epoch.');
}
