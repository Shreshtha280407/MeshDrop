import { deploymentConfig } from '../../scripts/deploy/config';
import { fingerprint } from '../../scripts/deploy/release-record';
import { buildValues, isolation, WORKFLOW } from '../../scripts/preview/contract';
import { manifestFixture } from './release-record';
import { readOnlyExpectation } from './cloudflare-readonly';

export function previewFixture() {
  const e = readOnlyExpectation();
  const pins = isolation(
    {
      schemaVersion: 1,
      environment: 'preview',
      accountId: e.accountId,
      worker: e.worker,
      project: e.project,
      projectId: e.projectId,
      origin: e.origin,
      githubEnvironmentId: '555',
      migrationTag: 'v2',
      admissionPaused: true,
      turnProvider: 'direct',
      durableObjects: e.durableObjects,
    },
    {
      accountId: 'd'.repeat(32),
      worker: 'separate-fixture-live-signaling',
      project: 'separate-fixture-live',
      projectId: 'live-project',
      origin: 'https://separate-fixture-live.pages.dev',
      githubEnvironmentId: '999',
      durableObjectNamespaces: ['a'.repeat(32), 'b'.repeat(32), 'e'.repeat(32)],
    },
  );
  const config = deploymentConfig('preview', buildValues(pins.target), process.cwd());
  const manifest = manifestFixture({
    configurationSha256: fingerprint({ worker: config.worker, pages: config.pages }),
    migrationsSha256: fingerprint({
      bindings: config.worker.durable_objects.bindings,
      migrations: config.worker.migrations,
    }),
  });
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'Shreshtha280407/MeshDrop',
    GITHUB_REPOSITORY_ID: '111',
    PREVIEW_CANARY_REPOSITORY_ID: '111',
    GITHUB_REPOSITORY_OWNER_ID: '222',
    PREVIEW_CANARY_OWNER_ID: '222',
    GITHUB_REF: 'refs/heads/main',
    PREVIEW_CANARY_EXPECTED_REF: 'refs/heads/main',
    GITHUB_SHA: manifest.sourceCommit,
    PREVIEW_CANARY_EXPECTED_SHA: manifest.sourceCommit,
    GITHUB_WORKFLOW_SHA: manifest.sourceCommit,
    GITHUB_WORKFLOW_REF: `Shreshtha280407/MeshDrop/${WORKFLOW}@refs/heads/main`,
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_RUN_ID: '333',
    GITHUB_RUN_ATTEMPT: '1',
  };
  return { pins, e, config, manifest, env };
}
