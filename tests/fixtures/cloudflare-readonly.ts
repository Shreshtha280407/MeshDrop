import type { ReadOnlyExpectation, ReadTransport } from '../../scripts/deploy/cloudflare-readonly';
import { manifestFixture, NOW, OLD_WORKER, OLD_PAGES } from './release-record';

// Sanitized offline examples shaped from the documented Cloudflare API. No real account IDs.
export const FIXTURE_TOKEN = 'offline-fixture-read-token-only';
export function readOnlyExpectation(): ReadOnlyExpectation {
  const manifest = manifestFixture();
  return {
    schemaVersion: 1,
    accountId: manifest.accountId,
    environment: manifest.environment,
    worker: manifest.worker,
    workerVersion: OLD_WORKER,
    workerDeployment: '20000000-0000-4000-8000-000000000001',
    project: manifest.project,
    projectId: '30000000-0000-4000-8000-000000000001',
    pagesSubdomain: `${manifest.project}.pages.dev`,
    pagesDeployment: OLD_PAGES,
    pagesEnvironment: 'production',
    origin: manifest.origin,
    migrationTag: 'v2',
    durableObjects: {
      SESSION_ROOMS: { className: 'SessionRoom', namespaceId: '1'.repeat(32) },
      RELAY_POOLS: { className: 'RelayPool', namespaceId: '2'.repeat(32) },
      OPERATIONS_MONITOR: { className: 'OperationsMonitor', namespaceId: '3'.repeat(32) },
    },
  };
}
export function readOnlyResponses(expected = readOnlyExpectation(), paused = true) {
  const active = {
    deployments: [
      {
        id: expected.workerDeployment,
        created_on: '2026-10-01T00:00:00.000Z',
        strategy: 'percentage',
        source: 'api',
        versions: [{ version_id: expected.workerVersion, percentage: 100 }],
      },
    ],
  };
  const version = {
    id: expected.workerVersion,
    resources: {
      bindings: [
        { type: 'plain_text', name: 'ENVIRONMENT', text: expected.environment },
        { type: 'plain_text', name: 'ADMISSION_PAUSED', text: String(paused) },
        { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: expected.origin },
        ...Object.entries(expected.durableObjects).map(([name, item]) => ({
          type: 'durable_object_namespace',
          name,
          class_name: item.className,
          namespace_id: item.namespaceId,
        })),
        // Deliberately sensitive-looking unused values must never appear in observations/errors.
        { type: 'secret_text', name: 'UNUSED_SECRET', text: FIXTURE_TOKEN },
      ],
      script: { etag: 'provider-etag-not-an-artifact-sha256', named_handlers: [] },
      script_runtime: {
        migration_tag: expected.migrationTag,
        exports: Object.fromEntries(
          Object.values(expected.durableObjects).map((item) => [
            item.className,
            { type: 'durable-object', storage: 'sqlite', state: 'created' },
          ]),
        ),
      },
    },
  };
  const deployment = {
    id: expected.pagesDeployment,
    project_id: expected.projectId,
    project_name: expected.project,
    environment: expected.pagesEnvironment,
    is_skipped: false,
    latest_stage: { name: 'deploy', status: 'success', ended_on: '2026-10-01T00:01:00.000Z' },
    env_vars: {
      PUBLIC_ORIGIN: { type: 'plain_text', value: expected.origin },
      UNUSED_SECRET: { type: 'secret_text', value: FIXTURE_TOKEN },
    },
    deployment_trigger: { type: 'ad_hoc', metadata: { commit_hash: 'a'.repeat(40) } },
    url: `https://untrusted-alias.${expected.project}.pages.dev`,
  };
  const project = {
    id: expected.projectId,
    name: expected.project,
    subdomain: expected.pagesSubdomain,
    canonical_deployment: structuredClone(deployment),
    deployment_configs: {
      [expected.pagesEnvironment]: {
        services: { SIGNALING: { service: expected.worker, environment: 'production' } },
      },
    },
  };
  const domain = {
    name: new URL(expected.origin).hostname,
    status: 'active',
    validation_data: { status: 'active' },
    verification_data: { status: 'active' },
  };
  return { active, version, deployment, project, domain };
}
export function jsonResponse(
  result: unknown,
  options: { date?: string; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    headers: {
      'content-type': 'application/json',
      date: options.date ?? new Date(NOW).toUTCString(),
      ...options.headers,
    },
  });
}
export function fixtureTransport(
  responses = readOnlyResponses(),
  expected = readOnlyExpectation(),
) {
  expected = structuredClone(expected);
  const calls: { url: string; init: Parameters<ReadTransport>[1] }[] = [];
  const transport: ReadTransport = async (url, init) => {
    calls.push({ url, init });
    const base = `https://api.cloudflare.com/client/v4/accounts/${expected.accountId}`;
    const routes = new Map<string, unknown>([
      [
        `${base}/workers/scripts/${expected.worker}/deployments?page=1&per_page=1`,
        responses.active,
      ],
      [
        `${base}/workers/scripts/${expected.worker}/versions/${expected.workerVersion}`,
        responses.version,
      ],
      [`${base}/pages/projects/${expected.project}`, responses.project],
      [
        `${base}/pages/projects/${expected.project}/deployments/${expected.pagesDeployment}`,
        responses.deployment,
      ],
      [
        `${base}/pages/projects/${expected.project}/domains/${new URL(expected.origin).hostname}`,
        responses.domain,
      ],
    ]);
    return routes.has(url)
      ? jsonResponse(routes.get(url))
      : new Response('Not found', { status: 404 });
  };
  return { calls, transport };
}
