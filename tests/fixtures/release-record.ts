import {
  ACCEPTANCE_CHECKS,
  acceptRelease,
  fingerprint,
  initialRecord,
  sealManifest,
} from '../../scripts/deploy/release-record';
import type {
  Manifest,
  ProviderIdentity,
  ReleaseRecord,
} from '../../scripts/deploy/release-record';
import type { PublicationProvider } from '../../scripts/deploy/release-lifecycle';

// These are explicit simulator identities. No fixture claims provider confirmation.
export const NOW = '2026-11-05T00:00:00.000Z';
export const OLD_WORKER = '00000000-0000-4000-8000-000000000001';
export const NEW_WORKER = '00000000-0000-4000-8000-000000000002';
export const OLD_PAGES = '10000000-0000-4000-8000-000000000001';
export const NEW_PAGES = '10000000-0000-4000-8000-000000000002';
export function manifestFixture(overrides: Partial<Omit<Manifest, 'id'>> = {}): Manifest {
  return sealManifest({
    schemaVersion: 2,
    repository: 'https://github.com/Shreshtha280407/MeshDrop',
    sourceCommit: 'a'.repeat(40),
    sourceTreeSha256: 'b'.repeat(64),
    environment: 'preview',
    accountId: 'c'.repeat(32),
    origin: 'https://meshdrop-fixture-preview.pages.dev',
    worker: 'meshdrop-fixture-preview-signaling',
    project: 'meshdrop-fixture-preview',
    protocolVersion: 1,
    admissionPaused: true,
    preparedAt: NOW,
    files: { 'index.html': 'd'.repeat(64), '_worker.js': 'e'.repeat(64) },
    workerFiles: { 'index.js': 'f'.repeat(64) },
    gatewaySha256: 'e'.repeat(64),
    configurationSha256: '1'.repeat(64),
    migrationsSha256: '2'.repeat(64),
    toolchain: {
      node: 'v24.22.2',
      pnpm: '10.34.7',
      esbuild: '0.28.1',
      vite: '7.3.7',
      lockSha256: '3'.repeat(64),
    },
    ...overrides,
  });
}
export function identityFixture(
  manifest: Manifest,
  workerVersion = NEW_WORKER,
  pagesDeployment = NEW_PAGES,
): ProviderIdentity {
  return {
    accountId: manifest.accountId,
    environment: manifest.environment,
    worker: manifest.worker,
    project: manifest.project,
    origin: manifest.origin,
    manifestId: manifest.id,
    sourceCommit: manifest.sourceCommit,
    configurationSha256: manifest.configurationSha256,
    workerVersion,
    pagesDeployment,
    admissionPaused: manifest.admissionPaused,
    observedAt: NOW,
  };
}
export function decisionFixture(
  decision: 'ACCEPT' | 'REJECT' = 'ACCEPT',
): NonNullable<ReleaseRecord['acceptance']> {
  return {
    operator: 'offline-test-operator',
    decidedAt: NOW,
    decision,
    evidence: Object.fromEntries(
      ACCEPTANCE_CHECKS.map((check) => [check, fingerprint({ fixture: check })]),
    ) as NonNullable<ReleaseRecord['acceptance']>['evidence'],
  };
}
export function publishedFixture(
  manifest: Manifest,
  worker = OLD_WORKER,
  pages = OLD_PAGES,
): ReleaseRecord {
  return {
    ...initialRecord(manifest),
    state: 'PUBLISHED',
    scope: 'offline-fixture',
    phase: 'published',
    sequence: 1,
    admission: {
      action: 'preserve',
      observedPaused: manifest.admissionPaused,
      desiredPaused: manifest.admissionPaused,
      previousWorkerVersion: worker,
    },
    provider: {
      workerVersion: worker,
      pagesDeployment: pages,
      confirmed: false,
      observation: identityFixture(manifest, worker, pages),
    },
  };
}
export function acceptedFixture(manifest: Manifest): ReleaseRecord {
  const record = publishedFixture(manifest);
  return acceptRelease(manifest, record, decisionFixture(), {
    manifestId: manifest.id,
    workerVersion: OLD_WORKER,
    pagesDeployment: OLD_PAGES,
  });
}
export function providerFixture(manifest: Manifest, previous: Manifest) {
  const calls: string[] = [];
  let workerVersion = OLD_WORKER,
    pagesDeployment = OLD_PAGES,
    paused = previous.admissionPaused;
  const provider: PublicationProvider = {
    mode: 'offline-fixture',
    async current() {
      calls.push('current');
      return {
        ...identityFixture(manifest, workerVersion, pagesDeployment),
        admissionPaused: paused,
      };
    },
    async publishWorker() {
      calls.push('publishWorker');
      workerVersion = NEW_WORKER;
      paused = manifest.admissionPaused;
    },
    async confirmWorker() {
      calls.push('confirmWorker');
      return {
        workerVersion,
        manifestId: manifest.id,
        sourceCommit: manifest.sourceCommit,
        configurationSha256: manifest.configurationSha256,
        observedAt: NOW,
      };
    },
    async publishPages() {
      calls.push('publishPages');
      pagesDeployment = NEW_PAGES;
    },
    async confirmPages() {
      calls.push('confirmPages');
      return {
        pagesDeployment,
        manifestId: manifest.id,
        sourceCommit: manifest.sourceCommit,
        configurationSha256: manifest.configurationSha256,
        observedAt: NOW,
      };
    },
    async readiness() {
      calls.push('readiness');
      return {
        health: 200,
        ready: paused ? 503 : 200,
        newRoom: paused ? 503 : 201,
        admissionPaused: paused,
        authorizationVerified: true,
        existingSessionVerified: true,
      };
    },
    async cleanup() {
      calls.push('cleanup');
    },
  };
  return { provider, calls };
}
