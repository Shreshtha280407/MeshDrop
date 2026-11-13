import { expect, it } from 'vitest';
import { StreamingPair, until } from '../helpers/streaming-transfer';
import { manifestDigest } from '../../packages/transfer-core/src/Manifest';

for (const mutation of ['digest', 'past-size', 'unsent-index', 'wrong-file'])
  it(`a malicious receiver ${mutation} ACK cannot advance progress or produce completion`, async () => {
    const pair = await new StreamingPair(32769).initialize();
    let attacked = false;
    pair.hooks.control = (role, control) => {
      if (role === 'receiver' && control.type === 'BLOCK_ACK' && !attacked) {
        attacked = true;
        if (mutation === 'digest') control.payload.digest = '0'.repeat(64);
        if (mutation === 'past-size') control.payload.committedBytes = pair.source.size + 1;
        if (mutation === 'unsent-index') control.payload.blockIndex++;
        if (mutation === 'wrong-file') control.payload.fileId = crypto.randomUUID();
      }
    };
    try {
      await pair.start();
      await until(() => pair.owner.snapshot.state === 'failed');
      await pair.flush();
      expect(attacked).toBe(true);
      expect(pair.owner.snapshot.committedBytes).toBe(0);
      expect(pair.owner.snapshot.receipt).toBeNull();
      expect(pair.receiptWrites).toBe(0);
      expect(pair.violations).toEqual([]);
    } finally {
      await pair.close();
    }
  });
for (const field of ['manifestDigest', 'totalBytes', 'files', 'transferId'])
  it(`a malicious receiver receipt with substituted ${field} cannot complete the sender`, async () => {
    const pair = await new StreamingPair(32769).initialize();
    let attacked = false;
    pair.hooks.control = (role, control) => {
      if (role === 'receiver' && control.type === 'TRANSFER_RECEIPT' && !attacked) {
        attacked = true;
        if (field === 'manifestDigest') control.payload.manifestDigest = '0'.repeat(64);
        if (field === 'totalBytes') control.payload.totalBytes++;
        if (field === 'files')
          control.payload.files = [{ ...control.payload.files[0]!, sha256: '0'.repeat(64) }];
        if (field === 'transferId') control.payload.transferId = crypto.randomUUID();
      }
    };
    try {
      await pair.start();
      await until(() => pair.owner.snapshot.state === 'failed');
      await pair.flush();
      expect(attacked).toBe(true);
      expect(pair.owner.snapshot.receipt).toBeNull();
      expect(pair.receiptWrites).toBe(0);
      expect(pair.violations).toEqual([]);
    } finally {
      await pair.close();
    }
  });
it.each([-1, 1])(
  'a malicious sender size difference %s is rejected before receiver commitment',
  async (delta) => {
    const pair = await new StreamingPair(32769).initialize();
    let attacked = false;
    pair.hooks.control = async (role, control) => {
      if (role === 'owner' && control.type === 'TRANSFER_OFFER') {
        attacked = true;
        control.payload.manifest = structuredClone(control.payload.manifest);
        control.payload.manifest.files[0]!.size += delta;
        control.payload.manifest.totalBytes += delta;
        control.payload.manifestDigest = await manifestDigest(control.payload.manifest);
      }
      // Model a hostile sender directly below. Do not let the cooperative
      // sender reject the substituted manifest before the receiver is tested.
      if (role === 'receiver' && control.type === 'TRANSFER_ACCEPT') return false;
    };
    try {
      await pair.start();
      const manifest = pair.receiver.snapshot.manifest!;
      await pair.receiver.receiveControl(
        pair.wrap('owner', {
          type: 'BLOCK_START',
          transferId: manifest.transferId,
          payload: {
            fileId: manifest.files[0]!.fileId,
            blockIndex: 0,
            bytes: pair.source.size,
            digest: manifest.files[0]!.sha256,
          },
        }),
      );
      await until(() => pair.receiver.snapshot.state === 'failed');
      await pair.flush();
      expect(attacked).toBe(true);
      expect(pair.committedBytes).toBe(0);
      expect(pair.receiver.snapshot.receipt).toBeNull();
      expect(pair.receiptWrites).toBe(0);
      expect(pair.violations).toEqual([]);
    } finally {
      await pair.close();
    }
  },
);
