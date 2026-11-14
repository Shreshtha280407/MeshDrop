/// <reference lib="webworker" />
// Real production sender-worker RPC, with controlled catalog scheduling only.
import { CheckpointDB } from '../../packages/storage/src/CheckpointDB';
import type { SourceRecord } from '../../packages/storage/src/ReceiverStore';
import '../../packages/transfer-core/src/hash-storage.worker';
const list = CheckpointDB.prototype.sources;
const remember = CheckpointDB.prototype.rememberSource;
let snapshot: SourceRecord[] | null = null;
let release: (() => void) | null = null;
CheckpointDB.prototype.sources = async function () {
  return snapshot ? structuredClone(snapshot) : list.call(this);
};
CheckpointDB.prototype.rememberSource = async function (record) {
  if (snapshot)
    await new Promise<void>((resolve) => {
      release = resolve;
      self.postMessage({ event: 'stage', stage: 'source-append' });
    });
  return remember.call(this, record);
};
const productionHandler = self.onmessage!;
self.onmessage = (
  event: MessageEvent<{ id: number; operation: string; payload: { now: number } }>,
) => {
  const { id, operation, payload } = event.data;
  if (operation === 'clock') {
    Date.now = () => payload.now;
    self.postMessage({ id, ok: true, result: null });
  } else if (operation === 'arm-sources') {
    void list.call(new CheckpointDB()).then((value) => {
      snapshot = value;
      self.postMessage({ id, ok: true, result: null });
    });
  } else if (operation === 'release') {
    snapshot = null;
    release?.();
    self.postMessage({ id, ok: true, result: null });
  } else productionHandler.call(self, event);
};
