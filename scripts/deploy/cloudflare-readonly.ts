import { explicitPause, verifyAdmission } from './release-lifecycle';
import type { AdmissionIntent, CurrentDeployment } from './release-lifecycle';
import { ReleaseError, requireRelease, sameContent } from './release-record';
import type { Environment, Manifest } from './release-record';

/** No publication, secret lookup, user-session request or configurable API origin. */
export type ReadOnlyExpectation = {
  schemaVersion: 1;
  accountId: string;
  environment: Environment;
  worker: string;
  workerVersion: string;
  workerDeployment: string;
  project: string;
  projectId: string;
  pagesSubdomain: string;
  pagesDeployment: string;
  pagesEnvironment: Environment;
  origin: string;
  migrationTag: string;
  durableObjects: Record<string, { className: string; namespaceId: string }>;
};
export type ReadOnlyObservation = {
  schemaVersion: 1;
  scope: 'cloudflare-api' | 'offline-fixture';
  providerConfirmed: boolean;
  startedAt: string;
  observedAt: string;
  current: CurrentDeployment;
  workerDeployment: string;
  projectId: string;
  pagesSubdomain: string;
  pagesEnvironment: Environment;
  durableObjects: ReadOnlyExpectation['durableObjects'];
  classStorage: Record<string, 'sqlite'>;
  migrationTag: string;
  route: 'canonical-production';
  unverified: readonly string[];
  releaseAccepted: false;
  productionApproved: false;
  publicationEnabled: false;
};
export type ReadTransport = (
  url: string,
  init: {
    method: 'GET';
    headers: Readonly<Record<string, string>>;
    redirect: 'error';
    signal: AbortSignal;
    cache: 'no-store';
  },
) => Promise<Response>;
const API = 'https://api.cloudflare.com/client/v4';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TAG = /^[a-f0-9]{32}$/;
export const READ_TIMEOUT_MS = 5000;
export const READ_MAX_BYTES = 512 * 1024;
const MAX_AGE_MS = 60000;
const UNVERIFIED = [
  'ARTIFACT_TO_PROVIDER_CORRELATION_UNVERIFIED',
  'APPLIED_MIGRATION_HISTORY_UNVERIFIED',
  'DEPLOYED_GATEWAY_BINDINGS_UNVERIFIED',
  'FULL_CONFIGURATION_FINGERPRINT_UNVERIFIED',
  'HTTP_READINESS_AND_SESSION_BEHAVIOR_UNVERIFIED',
  'RELEASE_ACCEPTANCE_UNVERIFIED',
] as const;
// Only in-process observations may feed current()/admission checks. JSON is not authentication.
const observations = new WeakMap<object, { snapshot: ReadOnlyObservation; started: number }>();
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  requireRelease(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_API_SCHEMA');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  requireRelease(Array.isArray(value) && value.length <= 1000, 'INVALID_API_SCHEMA');
  return value;
}
function uuid(value: unknown): string {
  requireRelease(typeof value === 'string' && UUID.test(value), 'MISSING_OR_INVALID_PROVIDER_ID');
  return value;
}
function date(value: unknown): number {
  requireRelease(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    'INVALID_API_TIME',
  );
  return Date.parse(value);
}
function age(started: number, now: Date) {
  const elapsed = now.getTime() - started;
  requireRelease(
    Number.isFinite(elapsed) && elapsed >= -5000 && elapsed <= MAX_AGE_MS,
    'STALE_HOSTED_PREFLIGHT',
  );
}
export function parseReadOnlyExpectation(value: unknown): ReadOnlyExpectation {
  const item = object(value);
  requireRelease(
    Object.keys(item).sort().join(',') ===
      'schemaVersion,accountId,environment,worker,workerVersion,workerDeployment,project,projectId,pagesSubdomain,pagesDeployment,pagesEnvironment,origin,migrationTag,durableObjects'
        .split(',')
        .sort()
        .join(','),
    'INVALID_PREFLIGHT_EXPECTATION',
  );
  requireRelease(
    item.schemaVersion === 1 &&
      typeof item.accountId === 'string' &&
      TAG.test(item.accountId) &&
      (item.environment === 'preview' || item.environment === 'production') &&
      (item.pagesEnvironment === 'preview' || item.pagesEnvironment === 'production') &&
      typeof item.project === 'string' &&
      /^[a-z][a-z0-9-]{2,40}$/.test(item.project) &&
      item.project.endsWith(`-${item.environment}`) &&
      item.worker === `${item.project}-signaling`,
    'INVALID_PREFLIGHT_SCOPE',
  );
  for (const key of ['workerVersion', 'workerDeployment', 'pagesDeployment']) uuid(item[key]);
  // Pages documents project IDs as strings, not necessarily UUIDs.
  requireRelease(
    typeof item.projectId === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(item.projectId) &&
      typeof item.pagesSubdomain === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,62}\.pages\.dev$/.test(item.pagesSubdomain),
    'INVALID_PAGES_PROJECT_IDENTITY',
  );
  requireRelease(
    typeof item.migrationTag === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.migrationTag),
    'INVALID_EXPECTED_MIGRATION_TAG',
  );
  requireRelease(
    typeof item.origin === 'string' &&
      /^https:\/\/[a-z0-9.-]+$/.test(item.origin) &&
      new URL(item.origin).origin === item.origin,
    'INVALID_PREFLIGHT_ORIGIN',
  );
  const bindings = object(item.durableObjects);
  requireRelease(
    Object.keys(bindings).length > 0 && Object.keys(bindings).length <= 32,
    'INVALID_EXPECTED_BINDINGS',
  );
  const classes = new Set<string>(),
    namespaces = new Set<string>();
  for (const [name, value] of Object.entries(bindings)) {
    const binding = object(value);
    requireRelease(
      /^[A-Z][A-Z0-9_]{0,63}$/.test(name) &&
        Object.keys(binding).sort().join(',') === 'className,namespaceId' &&
        typeof binding.className === 'string' &&
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(binding.className) &&
        typeof binding.namespaceId === 'string' &&
        TAG.test(binding.namespaceId) &&
        !classes.has(binding.className) &&
        !namespaces.has(binding.namespaceId),
      'INVALID_EXPECTED_BINDINGS',
    );
    classes.add(binding.className);
    namespaces.add(binding.namespaceId);
  }
  return structuredClone(item) as ReadOnlyExpectation;
}

/** Select just the required configuration. All other values, including secrets, are discarded. */
function workerConfiguration(value: unknown, expected: ReadOnlyExpectation) {
  const result = object(value);
  requireRelease(uuid(result.id) === expected.workerVersion, 'WORKER_VERSION_MISMATCH');
  const resources = object(result.resources);
  const bindings = new Map<string, ObjectValue>();
  for (const value of array(resources.bindings)) {
    const binding = object(value);
    requireRelease(
      typeof binding.name === 'string' &&
        typeof binding.type === 'string' &&
        !bindings.has(binding.name),
      'AMBIGUOUS_WORKER_BINDINGS',
    );
    bindings.set(binding.name, binding);
  }
  const text = (name: string) => {
    const binding = bindings.get(name);
    requireRelease(
      binding?.type === 'plain_text' && typeof binding.text === 'string',
      'REQUIRED_WORKER_VARIABLE_UNVERIFIED',
    );
    return binding.text;
  };
  requireRelease(text('ENVIRONMENT') === expected.environment, 'WORKER_ENVIRONMENT_MISMATCH');
  requireRelease(text('ALLOWED_ORIGINS') === expected.origin, 'WORKER_ORIGIN_MISMATCH');
  const paused = explicitPause(text('ADMISSION_PAUSED'));
  const runtime = object(resources.script_runtime);
  requireRelease(runtime.migration_tag === expected.migrationTag, 'MIGRATION_TAG_UNVERIFIED');
  const exports = object(runtime.exports);
  requireRelease(
    sameContent(
      Object.entries(exports)
        .filter(([, value]) => object(value).type === 'durable-object')
        .map(([name]) => name)
        .sort(),
      Object.values(expected.durableObjects)
        .map((item) => item.className)
        .sort(),
    ),
    'DURABLE_OBJECT_EXPORT_MISMATCH',
  );
  const classStorage: Record<string, 'sqlite'> = {};
  const actual = [...bindings.values()].filter(
    (binding) => binding.type === 'durable_object_namespace',
  );
  requireRelease(
    actual.length === Object.keys(expected.durableObjects).length,
    'DURABLE_OBJECT_BINDING_MISMATCH',
  );
  for (const [name, binding] of Object.entries(expected.durableObjects)) {
    const live = bindings.get(name);
    requireRelease(
      live?.type === 'durable_object_namespace' &&
        live.class_name === binding.className &&
        live.namespace_id === binding.namespaceId &&
        (live.script_name === undefined || live.script_name === expected.worker) &&
        (live.environment === undefined || live.environment === 'production') &&
        live.dispatch_namespace === undefined,
      'DURABLE_OBJECT_BINDING_MISMATCH',
    );
    const entry = object(exports[binding.className]);
    requireRelease(
      entry.type === 'durable-object' &&
        entry.storage === 'sqlite' &&
        (entry.state === undefined || entry.state === 'created') &&
        entry.container === undefined,
      'DURABLE_OBJECT_LIFECYCLE_UNVERIFIED',
    );
    classStorage[binding.className] = 'sqlite';
  }
  return { paused, classStorage };
}
function activeWorker(value: unknown, expected: ReadOnlyExpectation) {
  const list = array(object(value).deployments);
  requireRelease(list.length === 1, 'ACTIVE_WORKER_DEPLOYMENT_UNVERIFIED');
  const active = object(list[0]);
  requireRelease(
    uuid(active.id) === expected.workerDeployment && active.strategy === 'percentage',
    'WORKER_DEPLOYMENT_MISMATCH',
  );
  date(active.created_on);
  const versions = array(active.versions);
  requireRelease(
    versions.length === 1 &&
      object(versions[0]).percentage === 100 &&
      uuid(object(versions[0]).version_id) === expected.workerVersion,
    'CONFLICTING_WORKER_VERSIONS',
  );
  if (active.code_update_strategy !== undefined)
    requireRelease(
      object(active.code_update_strategy).mode === 'immediate',
      'DEFERRED_WORKER_UPDATE_UNVERIFIED',
    );
  return {
    id: active.id,
    versions: active.versions,
    strategy: active.strategy,
    codeUpdateStrategy: active.code_update_strategy ?? null,
  };
}
function pagesDeployment(value: unknown, expected: ReadOnlyExpectation) {
  const deployment = object(value);
  requireRelease(
    uuid(deployment.id) === expected.pagesDeployment &&
      deployment.project_id === expected.projectId &&
      deployment.project_name === expected.project,
    'PAGES_IDENTITY_MISMATCH',
  );
  requireRelease(
    deployment.environment === expected.pagesEnvironment,
    'PAGES_ENVIRONMENT_MISMATCH',
  );
  const stage = object(deployment.latest_stage);
  requireRelease(
    deployment.is_skipped === false && stage.name === 'deploy' && stage.status === 'success',
    'PAGES_DEPLOYMENT_NOT_SUCCESSFUL',
  );
  date(stage.ended_on);
  const origin = object(object(deployment.env_vars).PUBLIC_ORIGIN);
  requireRelease(
    origin.type === 'plain_text' && origin.value === expected.origin,
    'PAGES_ORIGIN_MISMATCH',
  );
  // Version-specific service bindings and artifact SHA-256 are not exposed here.
  return {
    id: deployment.id,
    environment: deployment.environment,
    project_id: deployment.project_id,
    project_name: deployment.project_name,
  };
}
function pagesProject(value: unknown, expected: ReadOnlyExpectation) {
  const project = object(value);
  requireRelease(
    project.id === expected.projectId &&
      project.name === expected.project &&
      project.subdomain === expected.pagesSubdomain,
    'PAGES_PROJECT_MISMATCH',
  );
  // Native Pages previews have no equivalent canonical active-deployment guarantee.
  requireRelease(expected.pagesEnvironment === 'production', 'ACTIVE_PAGES_ROUTE_UNVERIFIED');
  const canonical = pagesDeployment(project.canonical_deployment, expected);
  const config = object(object(project.deployment_configs)[expected.pagesEnvironment]);
  const signaling = object(object(config.services).SIGNALING);
  requireRelease(
    signaling.service === expected.worker &&
      signaling.environment === 'production' &&
      signaling.entrypoint === undefined,
    'PAGES_SERVICE_SCOPE_MISMATCH',
  );
  return {
    canonical,
    signaling: { service: signaling.service, environment: signaling.environment },
  };
}

export class CloudflareReadOnly {
  readonly #expected: ReadOnlyExpectation;
  readonly #token: string;
  readonly #transport: ReadTransport;
  readonly #now: () => Date;
  readonly #scope: ReadOnlyObservation['scope'];
  constructor(
    expected: ReadOnlyExpectation,
    token: string,
    options: { transport?: ReadTransport; now?: () => Date } = {},
  ) {
    this.#expected = parseReadOnlyExpectation(expected);
    requireRelease(
      typeof token === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(token),
      'READ_ONLY_CREDENTIAL_REQUIRED',
    );
    this.#token = token;
    this.#transport = options.transport ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => new Date());
    this.#scope = options.transport || options.now ? 'offline-fixture' : 'cloudflare-api';
  }
  async #get(path: string): Promise<unknown> {
    const url = `${API}/accounts/${this.#expected.accountId}/${path}`;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cleanup: { body?: ReadableStream<Uint8Array> } = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReleaseError('CLOUDFLARE_READ_TIMEOUT'));
      }, READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        timeout,
        (async () => {
          let response: Response;
          try {
            response = await this.#transport(url, {
              method: 'GET',
              redirect: 'error',
              signal: controller.signal,
              cache: 'no-store',
              headers: Object.freeze({
                Authorization: `Bearer ${this.#token}`,
                Accept: 'application/json',
                'Cache-Control': 'no-store',
              }),
            });
          } catch {
            throw new ReleaseError('CLOUDFLARE_READ_FAILED');
          }
          if (response.body) cleanup.body = response.body;
          if (controller.signal.aborted) {
            if (cleanup.body) void cleanup.body.cancel().catch(() => {});
            throw new ReleaseError('CLOUDFLARE_READ_TIMEOUT');
          }
          requireRelease(
            !response.redirected &&
              (!response.url || response.url === url) &&
              !(response.status >= 300 && response.status < 400),
            'CLOUDFLARE_REDIRECT_REJECTED',
          );
          if (response.status === 401 || response.status === 403)
            throw new ReleaseError('CLOUDFLARE_READ_UNAUTHORIZED');
          if (response.status === 429) throw new ReleaseError('CLOUDFLARE_READ_RATE_LIMITED');
          if (response.status >= 500) throw new ReleaseError('CLOUDFLARE_READ_SERVER_ERROR');
          requireRelease(response.status === 200, 'CLOUDFLARE_READ_HTTP_ERROR');
          requireRelease(
            /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''),
            'INVALID_API_CONTENT_TYPE',
          );
          age(date(response.headers.get('date')), this.#now());
          const length = response.headers.get('content-length');
          requireRelease(
            length === null || (/^\d+$/.test(length) && Number(length) <= READ_MAX_BYTES),
            'CLOUDFLARE_RESPONSE_TOO_LARGE',
          );
          requireRelease(response.body, 'INVALID_API_JSON');
          reader = response.body.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          while (true) {
            let item: ReadableStreamReadResult<Uint8Array>;
            try {
              item = await reader.read();
            } catch {
              throw new ReleaseError('CLOUDFLARE_READ_FAILED');
            }
            if (item.done) break;
            size += item.value.byteLength;
            requireRelease(size <= READ_MAX_BYTES, 'CLOUDFLARE_RESPONSE_TOO_LARGE');
            chunks.push(item.value);
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
            );
          } catch {
            throw new ReleaseError('INVALID_API_JSON');
          }
          const envelope = object(parsed);
          requireRelease(
            envelope.success === true &&
              array(envelope.errors).length === 0 &&
              Array.isArray(envelope.messages),
            'CLOUDFLARE_API_ERROR',
          );
          if (envelope.result_info !== undefined) {
            const info = object(envelope.result_info);
            requireRelease(
              info.page === 1 &&
                info.per_page === 1 &&
                Number.isSafeInteger(info.total_count) &&
                Number(info.total_count) >= 1,
              'UNVERIFIED_API_PAGINATION',
            );
          }
          return envelope.result;
        })(),
      ]);
    } catch (error) {
      // Never include request URLs, token values, provider messages or raw transport errors.
      throw new ReleaseError(error instanceof ReleaseError ? error.code : 'CLOUDFLARE_READ_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (cleanup.body) void cleanup.body.cancel().catch(() => {});
    }
  }
  async observe(): Promise<ReadOnlyObservation> {
    const expected = this.#expected,
      started = this.#now().getTime();
    const workerPath = `workers/scripts/${expected.worker}`;
    const pagesPath = `pages/projects/${expected.project}`;
    // The documented first item is active. Never scan history or choose a matching old version.
    const active = () => this.#get(`${workerPath}/deployments?page=1&per_page=1`);
    const worker = activeWorker(await active(), expected);
    const configuration = workerConfiguration(
      await this.#get(`${workerPath}/versions/${expected.workerVersion}`),
      expected,
    );
    const project = pagesProject(await this.#get(pagesPath), expected);
    pagesDeployment(
      await this.#get(`${pagesPath}/deployments/${expected.pagesDeployment}`),
      expected,
    );
    const host = new URL(expected.origin).hostname;
    if (host !== expected.pagesSubdomain) {
      requireRelease(!host.endsWith('.pages.dev'), 'PAGES_ROUTE_SCOPE_MISMATCH');
      const domain = object(await this.#get(`${pagesPath}/domains/${host}`));
      requireRelease(
        domain.name === host &&
          domain.status === 'active' &&
          object(domain.validation_data).status === 'active' &&
          object(domain.verification_data).status === 'active',
        'PAGES_CUSTOM_DOMAIN_UNVERIFIED',
      );
    }
    // Detect concurrent changes; this is not a provider-wide transaction or lock.
    requireRelease(
      sameContent(worker, activeWorker(await active(), expected)) &&
        sameContent(project, pagesProject(await this.#get(pagesPath), expected)),
      'PROVIDER_CHANGED_DURING_PREFLIGHT',
    );
    const now = this.#now();
    age(started, now);
    const observation: ReadOnlyObservation = {
      schemaVersion: 1,
      scope: this.#scope,
      providerConfirmed: this.#scope === 'cloudflare-api',
      startedAt: new Date(started).toISOString(),
      observedAt: now.toISOString(),
      current: {
        accountId: expected.accountId,
        environment: expected.environment,
        worker: expected.worker,
        project: expected.project,
        origin: expected.origin,
        workerVersion: expected.workerVersion,
        pagesDeployment: expected.pagesDeployment,
        admissionPaused: configuration.paused,
        observedAt: new Date(started).toISOString(),
      },
      workerDeployment: expected.workerDeployment,
      projectId: expected.projectId,
      pagesSubdomain: expected.pagesSubdomain,
      pagesEnvironment: expected.pagesEnvironment,
      durableObjects: structuredClone(expected.durableObjects),
      classStorage: configuration.classStorage,
      migrationTag: expected.migrationTag,
      route: 'canonical-production',
      unverified: [...UNVERIFIED],
      releaseAccepted: false,
      productionApproved: false,
      publicationEnabled: false,
    };
    observations.set(observation, { snapshot: structuredClone(observation), started });
    return observation;
  }
  /** Read-only subset for a future lifecycle adapter. Fixtures/serialized JSON cannot satisfy it. */
  async current(): Promise<CurrentDeployment> {
    requireRelease(this.#scope === 'cloudflare-api', 'AUTHENTICATED_READBACK_REQUIRED');
    return (await this.observe()).current;
  }
}
export function verifyObservedAdmission(
  manifest: Manifest,
  observation: ReadOnlyObservation,
  intent: AdmissionIntent,
  now: Date,
): void {
  const issued = observations.get(observation);
  requireRelease(
    issued && sameContent(issued.snapshot, observation),
    'UNTRUSTED_OR_MODIFIED_OBSERVATION',
  );
  age(issued.started, now);
  verifyAdmission(manifest, observation.current, intent, now);
}

/** In-process API issuance is required; labels in downloaded JSON are not proof. */
export function requireHostedObservation(observation: ReadOnlyObservation, now: Date): void {
  const issued = observations.get(observation);
  requireRelease(
    issued && sameContent(issued.snapshot, observation),
    'UNTRUSTED_OR_MODIFIED_OBSERVATION',
  );
  age(issued.started, now);
  requireRelease(
    observation.scope === 'cloudflare-api' && observation.providerConfirmed,
    'AUTHENTICATED_READBACK_REQUIRED',
  );
}
