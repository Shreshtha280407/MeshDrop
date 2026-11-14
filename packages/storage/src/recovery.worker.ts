/// <reference lib="webworker" />
import { uuidSchema } from '@meshdrop/protocol';
import { CheckpointDB } from './CheckpointDB';
import { LedgerReconciler } from './LedgerReconciler';
import { OpfsReceiverStore, purgeStoredTransfer } from './OpfsReceiverStore';
import { verifyReselectedSource, digestManifest } from './integrity';
import { StorageFailure } from './ReceiverStore';
async function run(operation: string, input: unknown): Promise<unknown> {
  if (operation === 'list') return new LedgerReconciler().listAndReconcile();
  const payload = input as { transferId: string; fileId?: string; file?: File };
  const id = uuidSchema.parse(payload.transferId);
  if (operation === 'purge') {
    await purgeStoredTransfer(id);
    return null;
  }
  const db = new CheckpointDB();
  if (operation === 'remove-source') {
    await db.removeSource(id);
    return null;
  }
  if (operation === 'reselect') {
    let source = (await db.sources()).find((source) => source.transferId === id);
    if (source && source.expiresAt <= Date.now()) {
      await db.removeSource(id, 'retention');
      source = (await db.sources()).find(
        (value) => value.transferId === id && value.expiresAt > Date.now(),
      );
    }
    const receiver = source ? null : await db.get(id);
    if (
      !source &&
      (!receiver ||
        receiver.expiresAt <= Date.now() ||
        receiver.retention === 'discard' ||
        receiver.state === 'deleting')
    )
      throw new StorageFailure('unavailable', 'Source retention has ended.');
    const manifest = source?.manifest ?? (await db.manifest(id));
    const digest = source?.manifestDigest ?? receiver?.manifestDigest;
    if (manifest.transferId !== id || digestManifest(manifest) !== digest)
      throw new Error('Source manifest is damaged.');
    const expected = manifest.files.find((file) => file.fileId === payload.fileId);
    if (!expected || !payload.file) throw new Error('Source identity unavailable.');
    const actual = await verifyReselectedSource(payload.file, expected);
    return { sha256: actual, fileId: expected.fileId };
  }
  if (operation === 'export') {
    const store = new OpfsReceiverStore();
    try {
      await store.open(id);
      const checkpoint = await new LedgerReconciler().reconcile(store);
      const file = checkpoint.files.find((file) => file.fileId === payload.fileId);
      if (!file?.finalized) throw new Error('Partial files cannot be exported as verified files.');
      return (await store.finalize(file.fileId)).file;
    } finally {
      await store.close();
    }
  }
  throw new Error('Unknown local storage operation.');
}
let busy = false;
self.onmessage = (event: MessageEvent<{ id: number; operation: string; payload: unknown }>) => {
  const { id, operation, payload } = event.data;
  if (busy) {
    self.postMessage({ id, ok: false, code: 'busy' });
    return;
  }
  busy = true;
  void run(operation, payload)
    .then((result) => self.postMessage({ id, ok: true, result }))
    .catch((error: unknown) => {
      self.postMessage({
        id,
        ok: false,
        code: error instanceof StorageFailure ? error.code : 'unavailable',
      });
    })
    .finally(() => {
      busy = false;
    });
};
