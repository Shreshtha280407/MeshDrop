import { probeStorageApis } from './StorageProbe';

self.onmessage = async () => {
  self.postMessage(await probeStorageApis());
};
