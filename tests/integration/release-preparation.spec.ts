import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import {
  buildPreparedRelease,
  collectSource,
  sourceFingerprint,
  verifyPreparedArtifacts,
} from '../../scripts/deploy/release-preparation';
import { canonical, initialRecord, sealManifest } from '../../scripts/deploy/release-record';
import { admissionIntent, ReleaseJournal } from '../../scripts/deploy/release-lifecycle';
import {
  inspectCommit,
  validateArchive,
  verifyPairProvenance,
} from '../../scripts/deploy/rollback-compatibility';
import {
  acceptedFixture,
  decisionFixture,
  NEW_PAGES,
  NEW_WORKER,
  NOW,
  providerFixture,
} from '../fixtures/release-record';
import { API, approve, capability, create, join as admit, request, runtime } from './harness';

it('builds a real versioned preparation, preserves real admission state and keeps simulator acceptance ineligible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meshdrop-release-integration-'));
  let worker: Miniflare | undefined;
  try {
    const root = process.cwd();
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const source = { sourceCommit, sourceTreeSha256: sourceFingerprint(root, sourceCommit) };
    const values = {
      PAGES_PROJECT: 'meshdrop-preparation-preview',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      OPS_REVOKE_SECRET: capability(),
      ADMISSION_PAUSED: 'true',
    };
    const prepared = await buildPreparedRelease({
      root,
      target: 'preview',
      values,
      source,
      preparedAt: NOW,
      artifactRoot: join(directory, 'artifacts'),
      journalRoot: join(directory, 'journals'),
    });
    const manifest = prepared.manifest;
    expect(await readFile(join(prepared.directory, 'manifest.json'), 'utf8')).toBe(
      canonical(manifest),
    );
    expect(canonical(manifest)).not.toContain(values.OPS_REVOKE_SECRET);
    expect(JSON.parse(await readFile(join(prepared.directory, 'release.json'), 'utf8'))).toEqual(
      initialRecord(manifest),
    );
    await verifyPreparedArtifacts(prepared.directory, manifest);
    const web = { ...manifest.files };
    delete web['_worker.js'];
    delete web['_routes.json'];
    const archive = await validateArchive(
      prepared.directory,
      await inspectCommit(sourceCommit),
      web,
    );
    expect(archive.record?.state).toBe('PREPARED');
    await expect(
      verifyPairProvenance({ current: archive, target: archive }, async () => true),
    ).rejects.toMatchObject({ code: 'UNVERIFIED_RELEASE_PROVENANCE' });

    const { id: originalId, ...payload } = manifest;
    const previous = sealManifest({ ...payload, preparedAt: '2026-11-04T00:00:00.000Z' });
    expect(previous.id).not.toBe(originalId);
    const journal = await ReleaseJournal.create(join(directory, 'simulation'), manifest);
    const { provider } = providerFixture(manifest, previous);
    const state = join(directory, 'state');
    worker = await runtime({
      persist: state,
      outboundService: () => new Response(null, { status: 503 }),
    });
    const room = await create(worker);
    const { guest } = await admit(worker, room);
    expect((await approve(worker, room, guest.peerId)).status).toBe(200);
    await worker.dispose();
    worker = await runtime({
      persist: state,
      bindings: { ADMISSION_PAUSED: 'true' },
      outboundService: () => new Response(null, { status: 503 }),
    });
    const simulatedCurrent = provider.current.bind(provider);
    provider.current = async () => {
      const metadata = await simulatedCurrent();
      const health = (await (await worker!.dispatchFetch(`${API}/health`)).json()) as {
        sessionsAvailable: boolean;
      };
      return { ...metadata, admissionPaused: !health.sessionsAvailable };
    };
    const simulateWorker = provider.publishWorker.bind(provider);
    provider.publishWorker = async (record) => {
      await simulateWorker(record);
      await worker!.dispose();
      worker = await runtime({
        persist: state,
        bindings: { ADMISSION_PAUSED: 'true' },
        outboundService: () => new Response(null, { status: 503 }),
      });
    };
    provider.readiness = async () => {
      const status = await request(worker!, `/v1/sessions/${room.roomId}/status`, {
        token: room.ownerCapability,
      });
      const peer = await request(worker!, `/v1/sessions/${room.roomId}/status`, {
        token: guest.peerCapability,
      });
      return {
        health: (await worker!.dispatchFetch(`${API}/health`)).status,
        ready: (await worker!.dispatchFetch(`${API}/ready`)).status,
        newRoom: (await request(worker!, '/v1/sessions', { method: 'POST', body: {} })).status,
        admissionPaused: true,
        existingSessionVerified:
          status.status === 200 &&
          peer.status === 200 &&
          ((await status.json()) as { state: string }).state === 'approved',
        authorizationVerified:
          (await request(worker!, `/v1/sessions/${room.roomId}/status`)).status === 401 &&
          (await request(worker!, `/v1/sessions/${room.roomId}/status`, { token: capability() }))
            .status === 403 &&
          (
            await request(worker!, `/v1/sessions/${room.roomId}`, {
              method: 'DELETE',
              token: guest.peerCapability,
            })
          ).status === 403,
      };
    };
    await journal.publish(provider, {
      previous: { manifest: previous, record: acceptedFixture(previous) },
      authenticatePrevious: async () => true, // Simulator authority; never hosted provenance.
      admission: admissionIntent('preserve'),
      integrity: () => verifyPreparedArtifacts(prepared.directory, manifest),
      now: () => new Date(NOW),
    });
    expect(journal.current().state).toBe('PUBLISHED');
    expect(journal.current().acceptance).toBeNull();
    const accepted = await journal.accept(
      decisionFixture(),
      {
        manifestId: manifest.id,
        workerVersion: NEW_WORKER,
        pagesDeployment: NEW_PAGES,
      },
      async () => true,
    ); // Explicit simulator approval; provider confirmation stays false.
    expect(accepted.scope).toBe('offline-fixture');
    expect(accepted.provider.confirmed).toBe(false);
    await writeFile(join(prepared.directory, 'release.json'), canonical(accepted));
    const simulated = await validateArchive(
      prepared.directory,
      await inspectCommit(sourceCommit),
      web,
    );
    await expect(
      verifyPairProvenance({ current: simulated, target: simulated }, async () => true),
    ).rejects.toMatchObject({ code: 'UNVERIFIED_RELEASE_PROVENANCE' });
    expect(
      (
        await request(worker!, `/v1/sessions/${room.roomId}`, {
          method: 'DELETE',
          token: room.ownerCapability,
        })
      ).status,
    ).toBe(200);

    const file = join(prepared.directory, 'worker/index.js');
    await writeFile(file, 'changed');
    await expect(verifyPreparedArtifacts(prepared.directory, manifest)).rejects.toThrow(
      'PREPARED_ARTIFACT_MISMATCH',
    );
  } finally {
    try {
      await worker?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30000);

it('rejects wrong source or ambiguous admission before generating artifacts and preserves unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meshdrop-prepare-negative-'));
  try {
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const base = {
      root: process.cwd(),
      target: 'preview' as const,
      values: {
        PAGES_PROJECT: 'meshdrop-preparation-preview',
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        OPS_REVOKE_SECRET: capability(),
        ADMISSION_PAUSED: 'true',
      },
      source: { sourceCommit, sourceTreeSha256: '0'.repeat(64) },
      preparedAt: NOW,
      artifactRoot: join(directory, 'artifacts'),
      journalRoot: join(directory, 'journals'),
    };
    await mkdir(base.artifactRoot);
    await writeFile(join(base.artifactRoot, 'unrelated.txt'), 'keep');
    await expect(buildPreparedRelease(base)).rejects.toThrow('SOURCE_IDENTITY_MISMATCH');
    await expect(
      buildPreparedRelease({ ...base, values: { ...base.values, ADMISSION_PAUSED: '' } }),
    ).rejects.toThrow('EXPLICIT_ADMISSION_STATE_REQUIRED');
    expect(await readdir(base.artifactRoot)).toEqual(['unrelated.txt']);
    expect(await readFile(join(base.artifactRoot, 'unrelated.txt'), 'utf8')).toBe('keep');
    // Agree with actual Git cleanliness, both during local work and in clean CI.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      encoding: 'utf8',
    });
    if (status) expect(() => collectSource(process.cwd())).toThrow('SOURCE_WORKTREE_NOT_CLEAN');
    else expect(collectSource(process.cwd()).sourceCommit).toBe(sourceCommit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
