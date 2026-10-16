import { StorageFailure } from './ReceiverStore';
import { uuidSchema } from '@meshdrop/protocol';
export async function acquireStoreLock(transferId: string): Promise<() => Promise<void>> {
  uuidSchema.parse(transferId);
  if (!navigator.locks)
    throw new StorageFailure('unavailable', 'Exclusive browser storage locks are unavailable.');
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled: Promise<void>;
  await new Promise<void>((resolve, reject) => {
    settled = Promise.resolve(
      navigator.locks.request(
        `meshdrop-store:${transferId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(new StorageFailure('busy', 'This transfer is open in another tab.'));
            return;
          }
          resolve();
          await hold;
        },
      ),
    ).then(() => {});
    void settled.catch(reject);
  });
  return async () => {
    release();
    await settled;
  };
}
