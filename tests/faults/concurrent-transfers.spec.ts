import { access } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  B,
  StreamingPair,
  deferred,
  nodeFileHash,
  sourceHash,
  until,
} from '../helpers/streaming-transfer';
import { loadEvidence } from '../helpers/control-load';

async function exact(pair: StreamingPair) {
  await pair.completed();
  expect(pair.owner.snapshot.state).toBe('complete');
  expect(pair.receiver.snapshot.state).toBe('complete');
  expect(pair.violations).toEqual([]);
  expect(pair.receiptWrites).toBe(1);
  expect(pair.committedBytes).toBe(pair.source.size);
  expect(pair.owner.snapshot.committedBytes).toBe(pair.source.size);
  expect(pair.receiver.snapshot.committedBytes).toBe(pair.source.size);
  expect(pair.owner.snapshot.receipt).toEqual(pair.receiver.snapshot.receipt);
  expect(pair.finalHash).toBe(sourceHash(pair.source.size));
  expect(await nodeFileHash(pair.path)).toBe(pair.finalHash);
  expect(pair.peakQueueBytes).toBeLessThanOrEqual(512 * 1024);
  expect(pair.peakUnacknowledgedBytes).toBeLessThanOrEqual(B);
  expect(pair.peakOutstandingBlocks).toBeLessThanOrEqual(1);
  expect(pair.peakWriteQueue).toBeLessThanOrEqual(1);
}
async function dispose(pairs: StreamingPair[]) {
  await Promise.all(pairs.map((p) => p.close()));
  for (const pair of pairs) await expect(access(pair.root)).rejects.toThrow();
}
for (const count of [10, 25])
  it(`completes ${count} simultaneous file-backed engines with separate manifests, exact bytes and bounded per-transfer queues`, async () => {
    const pairs: StreamingPair[] = [];
    const gate = deferred();
    let blocked = 0;
    try {
      for (let i = 0; i < count; i++) {
        const pair = await new StreamingPair(2 * B + i * 37 + 1).initialize();
        pair.hooks.beforeCommit = async (index) => {
          if (index === 0) {
            blocked++;
            await gate.promise;
          }
        };
        pairs.push(pair);
      }
      await Promise.all(pairs.map((p) => p.start()));
      await until(() => blocked === count);
      expect(
        pairs.every((p) => p.owner.snapshot.committedBytes === 0 && p.committedBytes === 0),
      ).toBe(true);
      expect(new Set(pairs.map((p) => p.manifest.transferId)).size).toBe(count);
      gate.release();
      await Promise.all(pairs.map(exact));
      for (const p of pairs) {
        const receipt = p.controls.find((c) => c.control.type === 'TRANSFER_RECEIPT')!.control;
        await p.owner.receiveControl(receipt);
        await p.owner.receiveControl(receipt);
        expect(p.receiptWrites).toBe(1);
        expect(p.owner.snapshot.state).toBe('complete');
      }
      await loadEvidence(`engines-${count}`, {
        scope: 'local-file-backed-transfer-simulation',
        concurrentTransfers: count,
        simultaneousBlockedCommits: blocked,
        verifiedHashes: count,
        peakPerTransferQueuedBytes: Math.max(...pairs.map((p) => p.peakQueueBytes)),
        peakPerTransferUnacknowledgedBytes: Math.max(
          ...pairs.map((p) => p.peakUnacknowledgedBytes),
        ),
        falseCompletions: 0,
      });
    } finally {
      gate.release();
      await dispose(pairs);
    }
  }, 90000);

it('recovers twenty interrupted transfer engines simultaneously using rehashed source/checkpoint identities and missing-only epoch 2 data', async () => {
  const pairs: StreamingPair[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      const p = await new StreamingPair(4 * B + i * 41 + 1).initialize();
      let cut = false;
      p.hooks.view = (role, v) => {
        if (!cut && role === 'receiver' && v.committedBytes >= B && v.state === 'active') {
          cut = true;
          p.cut();
        }
      };
      pairs.push(p);
    }
    await Promise.all(pairs.map((p) => p.start()));
    await until(() => pairs.every((p) => p.receiver.snapshot.state === 'reconnecting'));
    await Promise.all(pairs.map((p) => p.flush()));
    expect(pairs.every((p) => p.committedBytes === B)).toBe(true);
    const stale = pairs.map((p) =>
      p.wrap('receiver', {
        type: 'FLOW_STATE',
        transferId: p.manifest.transferId,
        payload: { paused: true },
      }),
    );
    await Promise.all(pairs.map((p) => p.reconnect()));
    for (const [i, p] of pairs.entries()) {
      const before = p.owner.snapshot;
      const ignored = p.owner.receiveControl(stale[i]!);
      expect(p.owner.snapshot).toBe(before);
      await ignored;
    }
    await Promise.all(pairs.map(exact));
    for (const p of pairs) {
      expect(p.epoch).toBe(2);
      expect(p.owner.snapshot.reusedBytes).toBe(B);
      expect(p.owner.snapshot.attemptBytes).toBe(p.source.size - B);
      expect(p.payloadBytes).toBe(p.source.size);
      expect(p.sentBlocks.filter((b) => b.epoch === 2).every((b) => b.index >= 1)).toBe(true);
    }
    await loadEvidence('engine-reconnect-20', {
      scope: 'local-file-backed-transfer-simulation',
      concurrentRecoveries: 20,
      freshEpoch: 2,
      verifiedHashes: 20,
      staleEpochMutations: 0,
      duplicatedCommittedBytes: 0,
    });
  } finally {
    await dispose(pairs);
  }
}, 90000);

it('completes eight small files while a 64 MiB logical transfer is blocked without a global scheduler lock', async () => {
  const large = await new StreamingPair(64 * B).initialize(),
    pairs = [large],
    gate = deferred();
  let held = false;
  large.hooks.beforeCommit = async (index) => {
    if (index === 0) {
      held = true;
      await gate.promise;
    }
  };
  try {
    for (let i = 0; i < 8; i++)
      pairs.push(await new StreamingPair(256 * 1024 + i * 19 + 1).initialize());
    await Promise.all(pairs.map((p) => p.start()));
    await until(() => held);
    await Promise.all(pairs.slice(1).map(exact));
    expect(large.committedBytes).toBe(0);
    expect(large.owner.snapshot.state).not.toBe('complete');
    gate.release();
    await exact(large);
    await loadEvidence('large-small-fairness', {
      scope: 'local-file-backed-transfer-simulation',
      largeLogicalBytes: 64 * B,
      smallTransfers: 8,
      smallCompletedBeforeLargeReleased: 8,
      verifiedHashes: 9,
      falseCompletions: 0,
    });
  } finally {
    gate.release();
    await dispose(pairs);
  }
}, 90000);

it('cancels five of ten busy engines without completing cancelled files or starving their peers', async () => {
  const pairs: StreamingPair[] = [],
    gate = deferred();
  let blocked = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const p = await new StreamingPair(3 * B + i * 31 + 1).initialize();
      p.hooks.beforeCommit = async (index) => {
        if (index === 0) {
          blocked++;
          await gate.promise;
        }
      };
      pairs.push(p);
    }
    await Promise.all(pairs.map((p) => p.start()));
    await until(() => blocked === 10);
    await Promise.all(pairs.slice(0, 5).map((p) => p.owner.cancel(false)));
    gate.release();
    await Promise.all(pairs.map((p) => p.completed()));
    for (const p of pairs.slice(0, 5)) {
      expect(p.owner.snapshot.state).toBe('cancelled');
      expect(p.receiver.snapshot.state).not.toBe('complete');
      expect(p.receiptWrites).toBe(0);
    }
    await Promise.all(pairs.slice(5).map(exact));
    await loadEvidence('concurrent-cancel', {
      scope: 'local-file-backed-transfer-simulation',
      concurrentTransfers: 10,
      cancelled: 5,
      independentCompleted: 5,
      cancelledCompletions: 0,
    });
  } finally {
    gate.release();
    await dispose(pairs);
  }
}, 90000);
