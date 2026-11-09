import { appendFile, mkdir, open } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { receiptSchema } from '@meshdrop/protocol';
import { StorageFailure } from '../../packages/storage/src/ReceiverStore';
import {
  encodeTransferFrame,
  decodeTransferFrame,
} from '../../packages/transfer-core/src/FrameCodec';
import {
  B,
  StreamingPair,
  GeneratedFile,
  deferred,
  nodeFileHash,
  sourceHash,
  until,
} from '../helpers/streaming-transfer';

async function verified(pair: StreamingPair, label: string) {
  await pair.completed();
  expect(pair.owner.snapshot.state).toBe('complete');
  expect(pair.receiver.snapshot.state).toBe('complete');
  expect(pair.owner.snapshot.receipt).toEqual(pair.receiver.snapshot.receipt);
  expect(receiptSchema.parse(pair.receipt).totalBytes).toBe(pair.source.size);
  expect(pair.receiptWrites).toBe(1);
  expect(pair.committedBytes).toBe(pair.source.size);
  expect([...pair.proofs.keys()].sort((a, b) => a - b)).toEqual(
    Array.from({ length: Math.ceil(pair.source.size / B) }, (_, i) => i),
  );
  const expected = sourceHash(pair.source.size);
  expect(pair.finalHash).toBe(expected);
  expect(await nodeFileHash(pair.path)).toBe(expected);
  expect(pair.owner.snapshot.receipt?.files[0]!.sha256).toBe(expected);
  expect(pair.owner.snapshot.committedBytes).toBe(pair.committedBytes);
  expect(pair.receiver.snapshot.committedBytes).toBe(pair.committedBytes);
  expect(pair.violations).toEqual([]);
  expect(pair.peakQueueBytes).toBeLessThanOrEqual(512 * 1024);
  expect(pair.peakUnacknowledgedBytes).toBeLessThanOrEqual(B);
  expect(pair.peakOutstandingBlocks).toBeLessThanOrEqual(1);
  expect(pair.peakWriteQueue).toBeLessThanOrEqual(1);
  expect(pair.peakWriteBytes).toBeLessThanOrEqual(B);
  expect(pair.source.peakReadBytes).toBeLessThanOrEqual(B);
  await mkdir('.meshdrop-artifacts/task12-transfer-reliability', { recursive: true });
  await appendFile(
    '.meshdrop-artifacts/task12-transfer-reliability/metrics.jsonl',
    JSON.stringify({
      label,
      scope: 'local-file-backed-engine-simulation',
      ...pair.metrics(),
      sha256: expected,
    }) + '\n',
  );
}

for (const mib of [64, 256, 1024])
  it(`streams ${mib} MiB through real framing, storage commits, final SHA-256 and one receipt with bounded queues`, async () => {
    const pair = await new StreamingPair(mib * B).initialize();
    try {
      expect(() => pair.source.arrayBuffer()).toThrow('Whole-file allocation forbidden');
      await pair.start();
      await verified(pair, `complete-${mib}-MiB`);
      const expectedHashes: Record<number, string> = {
        64: '55a064c1b98749f7987191ea29c07e1b476bc1da8c4901ee5ac784dd40b3c5aa',
        256: 'a6235523156aa08cbcdef46c980f2f5072001e96d6bfa449947edfdef14ade1b',
        1024: '0cc366b96f16232566988ed5f2426954e17a7e991035d6a33a41677faa7f5bbc',
      };
      expect(pair.finalHash).toBe(expectedHashes[mib]);
    } finally {
      await pair.close();
    }
  }, 180000);

for (const percent of [0, 1, 10, 25, 50, 75, 95])
  it(`reconciles a ${percent}% interruption and transmits only the missing ranges on epoch 2`, async () => {
    const pair = await new StreamingPair(100 * B).initialize();
    let cut = false;
    pair.hooks.view = (role, view) => {
      if (
        !cut &&
        role === 'receiver' &&
        view.state === 'active' &&
        view.committedBytes >= percent * B
      ) {
        cut = true;
        pair.cut();
      }
    };
    try {
      await pair.start();
      await until(() => pair.receiver.snapshot.state === 'reconnecting');
      await pair.flush();
      expect(pair.committedBytes).toBe(percent * B);
      await pair.reconnect();
      await verified(pair, `interrupt-${percent}-percent`);
      expect(pair.owner.snapshot.reusedBytes).toBe(percent * B);
      expect(pair.owner.snapshot.attemptBytes).toBe((100 - percent) * B);
      expect(
        pair.sentBlocks.filter((block) => block.epoch === 2).map((block) => block.index),
      ).toEqual(Array.from({ length: 100 - percent }, (_, i) => percent + i));
    } finally {
      await pair.close();
    }
  }, 90000);

it('recovers three consecutive connections without overwriting any receiver-committed range', async () => {
  const pair = await new StreamingPair(32 * B + 17).initialize();
  const cuts = [3, 11, 24];
  let next = 0;
  pair.hooks.view = (role, view) => {
    if (
      role === 'receiver' &&
      view.state === 'active' &&
      next < cuts.length &&
      view.committedBytes >= cuts[next]! * B
    ) {
      next++;
      pair.cut();
    }
  };
  try {
    await pair.start();
    for (let cycle = 0; cycle < 3; cycle++) {
      await until(() => pair.receiver.snapshot.state === 'reconnecting');
      await pair.reconnect();
    }
    await verified(pair, 'three-reconnects');
    expect(pair.reconnectCount).toBe(3);
    expect(pair.receiver.snapshot.receipt?.epoch).toBe(4);
    expect(pair.payloadBytes).toBe(pair.source.size);
  } finally {
    await pair.close();
  }
}, 90000);

it('a committed block with a lost ACK is recovered from disk and is not sent again', async () => {
  const pair = await new StreamingPair(10 * B + 7).initialize();
  pair.hooks.control = (role, control) => {
    if (
      role === 'receiver' &&
      pair.epoch === 1 &&
      control.type === 'BLOCK_ACK' &&
      control.payload.blockIndex === 4
    ) {
      pair.cut();
      return false;
    }
  };
  try {
    await pair.start();
    await until(() => pair.receiver.snapshot.state === 'reconnecting');
    expect(pair.committedBytes).toBe(5 * B);
    expect(pair.owner.snapshot.committedBytes).toBe(4 * B);
    await pair.reconnect();
    await verified(pair, 'lost-committed-ack');
    expect(pair.owner.snapshot.reusedBytes).toBe(5 * B);
    expect(
      pair.sentBlocks.filter((block) => block.epoch === 2).every((block) => block.index >= 5),
    ).toBe(true);
    expect(pair.payloadBytes).toBe(pair.source.size);
  } finally {
    await pair.close();
  }
});

it('a fast sender waits for a delayed committed ACK without advancing progress or scheduling another block', async () => {
  const pair = await new StreamingPair(4 * B).initialize();
  const gate = deferred();
  pair.hooks.control = async (role, control) => {
    if (role === 'receiver' && control.type === 'BLOCK_ACK' && control.payload.blockIndex === 0)
      await gate.promise;
  };
  try {
    await pair.start();
    await until(() => pair.committedBytes === B);
    expect(pair.owner.snapshot.committedBytes).toBe(0);
    expect(pair.sentBlocks.map((block) => block.index)).toEqual([0]);
    expect(pair.owner.snapshot.attemptBytes).toBe(B);
    gate.release();
    await verified(pair, 'slow-ack-backpressure');
  } finally {
    gate.release();
    await pair.close();
  }
});

it('an out-of-order future-block ACK cannot advance a sender awaiting a storage commit', async () => {
  const pair = await new StreamingPair(3 * B).initialize();
  const gate = deferred();
  let committing = false;
  pair.hooks.beforeCommit = async () => {
    committing = true;
    await gate.promise;
  };
  try {
    await pair.start();
    await until(() => committing);
    await pair.owner.receiveControl(
      pair.wrap('receiver', {
        type: 'BLOCK_ACK',
        transferId: pair.manifest.transferId,
        payload: {
          fileId: pair.manifest.files[0]!.fileId,
          blockIndex: 1,
          digest: 'a'.repeat(64),
          committedBytes: B,
        },
      }),
    );
    expect(pair.owner.snapshot.state).toBe('failed');
    expect(pair.owner.snapshot.committedBytes).toBe(0);
    expect(pair.owner.snapshot.receipt).toBeNull();
    gate.release();
    await pair.flush();
    expect(pair.owner.snapshot.state).toBe('failed');
  } finally {
    gate.release();
    await pair.close();
  }
});

for (const duplicate of ['BLOCK_ACK', 'TRANSFER_FINALIZE'] as const)
  it(`duplicate ${duplicate} preserves exact progress and a single persisted receipt`, async () => {
    const pair = await new StreamingPair(2 * B + 7).initialize();
    pair.hooks.control = async (role, control) => {
      if (control.type === duplicate)
        await (role === 'owner' ? pair.receiver : pair.owner).receiveControl(control);
    };
    try {
      await pair.start();
      await verified(pair, `duplicate-${duplicate}`);
    } finally {
      await pair.close();
    }
  });

it('duplicate data fragments are rejected before storage progress or completion', async () => {
  const pair = await new StreamingPair(B + 7).initialize();
  let repeated = false;
  pair.hooks.duplicateFrame = () => {
    if (repeated) return false;
    repeated = true;
    return true;
  };
  try {
    await pair.start();
    await pair.completed();
    expect(pair.receiver.snapshot.state).toBe('failed');
    expect(pair.committedBytes).toBe(0);
    expect(pair.receiver.snapshot.receipt).toBeNull();
    expect(pair.owner.snapshot.committedBytes).toBe(0);
  } finally {
    await pair.close();
  }
});

it('duplicate resume pages and controls cannot reuse a committed block twice', async () => {
  const pair = await new StreamingPair(4 * B + 7).initialize();
  let cut = false;
  pair.hooks.view = (role, view) => {
    if (!cut && role === 'receiver' && view.state === 'active' && view.committedBytes === B) {
      cut = true;
      pair.cut();
    }
  };
  pair.hooks.control = async (role, control) => {
    if (['HAVE_RANGES', 'NEED_RANGES', 'RESUME_ACCEPT'].includes(control.type))
      await (role === 'owner' ? pair.receiver : pair.owner).receiveControl(control);
  };
  try {
    await pair.start();
    await until(() => pair.receiver.snapshot.state === 'reconnecting');
    await pair.reconnect();
    await verified(pair, 'duplicate-resume-controls');
    expect(pair.owner.snapshot.reusedBytes).toBe(B);
    expect(pair.payloadBytes).toBe(pair.source.size);
  } finally {
    await pair.close();
  }
});

it('an out-of-order frame is rejected on the required reliable ordered channel', async () => {
  const pair = await new StreamingPair(B).initialize();
  pair.hooks.frame = (wire) => {
    const frame = decodeTransferFrame(wire);
    return encodeTransferFrame({ ...frame, sequence: frame.sequence + 1 });
  };
  try {
    await pair.start();
    await pair.completed();
    expect(pair.receiver.snapshot.state).toBe('failed');
    expect(pair.committedBytes).toBe(0);
    expect(pair.receiver.snapshot.receipt).toBeNull();
  } finally {
    await pair.close();
  }
});

for (const corruption of ['middle', 'final', 'resumed'] as const)
  it(`corrupted ${corruption} data cannot become a verified transfer`, async () => {
    const pair = await new StreamingPair(3 * B + 17).initialize();
    let cut = false;
    if (corruption === 'resumed')
      pair.hooks.view = (role, view) => {
        if (!cut && role === 'receiver' && view.state === 'active' && view.committedBytes === B) {
          cut = true;
          pair.cut();
        }
      };
    pair.hooks.frame = (wire, epoch) => {
      const frame = decodeTransferFrame(wire);
      if (
        frame.fragmentIndex === 0 &&
        frame.blockIndex === (corruption === 'final' ? 3 : 1) &&
        (corruption !== 'resumed' || epoch > 1)
      ) {
        const bad = wire.slice();
        bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
        return bad;
      }
      return wire;
    };
    try {
      await pair.start();
      if (corruption === 'resumed') {
        await until(() => pair.receiver.snapshot.state === 'reconnecting');
        await pair.reconnect();
      }
      await pair.completed();
      expect(pair.receiver.snapshot.state).toBe('failed');
      expect(pair.receiver.snapshot.receipt).toBeNull();
      expect(pair.owner.snapshot.state).not.toBe('complete');
      expect(pair.receiptWrites).toBe(0);
      expect(pair.violations).toEqual([]);
    } finally {
      await pair.close();
    }
  });

it('final stored-byte hashing rejects damage after otherwise valid block commitments', async () => {
  const pair = await new StreamingPair(3 * B + 17).initialize();
  pair.hooks.beforeFinalize = async () => {
    const file = await open(pair.path, 'r+');
    try {
      await file.write(new Uint8Array([255]), 0, 1, B + 37);
      await file.sync();
    } finally {
      await file.close();
    }
  };
  try {
    await pair.start();
    await pair.completed();
    expect(pair.committedBytes).toBe(pair.source.size);
    expect(pair.receiver.snapshot.state).toBe('failed');
    expect(pair.receiver.snapshot.receipt).toBeNull();
    expect(pair.owner.snapshot.state).not.toBe('complete');
    expect(pair.finalized).toBe(false);
  } finally {
    await pair.close();
  }
});

it('same-name same-size changed source is rejected before resume sends any new DATA', async () => {
  const pair = await new StreamingPair(4 * B).initialize();
  let cut = false;
  pair.hooks.view = (role, view) => {
    if (!cut && role === 'receiver' && view.state === 'active' && view.committedBytes === B) {
      cut = true;
      pair.cut();
    }
  };
  try {
    await pair.start();
    await until(() => pair.receiver.snapshot.state === 'reconnecting');
    const before = pair.payloadBytes;
    await pair.reconnect(new GeneratedFile(pair.source.size, 20));
    expect(pair.owner.snapshot.state).toBe('failed');
    expect(pair.owner.snapshot.error).toContain('SHA-256');
    expect(pair.owner.snapshot.receipt).toBeNull();
    expect(pair.payloadBytes).toBe(before);
    expect(pair.committedBytes).toBe(B);
  } finally {
    await pair.close();
  }
});

for (const failure of ['insufficient-space', 'write-failure', 'worker-failure'] as const)
  it(`${failure} cannot emit ACK-backed progress for failed bytes`, async () => {
    const pair = await new StreamingPair(3 * B).initialize();
    if (failure === 'insufficient-space')
      pair.hooks.prepareReceiver = async () => {
        throw new StorageFailure('quota', 'Synthetic capacity exhausted');
      };
    else
      pair.hooks.beforeCommit = async (index) => {
        if (index === 1) throw new StorageFailure('unavailable', failure);
      };
    try {
      await pair.start();
      await pair.completed();
      expect(pair.receiver.snapshot.state).toBe('failed');
      expect(pair.owner.snapshot.state).not.toBe('complete');
      expect(pair.owner.snapshot.committedBytes).toBe(failure === 'insufficient-space' ? 0 : B);
      expect(pair.controls.filter(({ control }) => control.type === 'BLOCK_ACK').length).toBe(
        failure === 'insufficient-space' ? 0 : 1,
      );
      expect(pair.receiver.snapshot.receipt).toBeNull();
      expect(pair.violations).toEqual([]);
    } finally {
      await pair.close();
    }
  });

it('quota exhaustion retains the valid prefix, issues no failed-block ACK and retries exactly once', async () => {
  const pair = await new StreamingPair(3 * B + 7).initialize();
  let exhausted = true;
  pair.hooks.beforeCommit = async (index) => {
    if (index === 1 && exhausted) throw new StorageFailure('quota', 'Synthetic quota exhausted');
  };
  try {
    await pair.start();
    await until(() => pair.receiver.snapshot.storageFull);
    expect(pair.committedBytes).toBe(B);
    expect(pair.owner.snapshot.committedBytes).toBe(B);
    expect(pair.controls.filter(({ control }) => control.type === 'BLOCK_ACK')).toHaveLength(1);
    expect(pair.receiver.snapshot.receipt).toBeNull();
    exhausted = false;
    await pair.receiver.retryStorage();
    await verified(pair, 'quota-retry');
  } finally {
    await pair.close();
  }
});

for (const phase of [
  'before-first-chunk',
  'mid-transfer',
  'paused',
  'recovery',
  'receipt-signing',
] as const)
  it(`cancellation at ${phase} cannot be revived by queued work or late completion`, async () => {
    const pair = await new StreamingPair(4 * B).initialize();
    const gate = deferred();
    let waiting = false;
    if (phase === 'mid-transfer')
      pair.hooks.beforeCommit = async (index) => {
        if (index === 1) {
          waiting = true;
          await gate.promise;
        }
      };
    if (phase === 'paused')
      pair.hooks.control = async (role, control) => {
        if (
          role === 'receiver' &&
          control.type === 'BLOCK_ACK' &&
          control.payload.blockIndex === 0
        ) {
          waiting = true;
          await gate.promise;
        }
      };
    if (phase === 'receipt-signing')
      pair.hooks.control = async (role, control) => {
        if (role === 'owner' && control.type === 'RECEIPT_ACK') {
          waiting = true;
          await gate.promise;
        }
      };
    if (phase === 'recovery')
      pair.hooks.view = (role, view) => {
        if (
          !waiting &&
          role === 'receiver' &&
          view.state === 'active' &&
          view.committedBytes === B
        ) {
          waiting = true;
          pair.cut();
        }
      };
    try {
      if (phase === 'before-first-chunk') {
        await pair.owner.offer([pair.source]);
        await until(() => pair.receiver.snapshot.state === 'negotiating');
      } else {
        await pair.start();
        await until(() => waiting);
      }
      if (phase === 'paused') {
        await pair.receiver.setPaused(true);
        await until(() => pair.owner.snapshot.state === 'paused');
      }
      await pair.owner.cancel();
      if (phase === 'recovery') await pair.receiver.cancel(false);
      gate.release();
      await until(() => pair.receiver.snapshot.state === 'cancelled');
      await pair.flush();
      expect(pair.owner.snapshot.state).toBe('cancelled');
      expect(pair.receiver.snapshot.state).toBe('cancelled');
      expect(pair.owner.snapshot.receipt).toBeNull();
      expect(pair.receiver.snapshot.receipt).toBeNull();
      expect(pair.receiptWrites).toBe(0);
      expect(pair.committedBytes).toBe(0);
      expect(pair.owner.download(pair.owner.snapshot.manifest!.files[0]!.fileId)).toBeUndefined();
    } finally {
      gate.release();
      await pair.close();
    }
  });
