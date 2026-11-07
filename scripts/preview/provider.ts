import { CloudflareReadOnly, requireHostedObservation } from '../deploy/cloudflare-readonly';
import type { ReadOnlyExpectation, ReadTransport } from '../deploy/cloudflare-readonly';
import { ReleaseError, requireRelease } from '../deploy/release-record';
import type { Manifest } from '../deploy/release-record';
import { deploymentConfig } from '../deploy/config';
import { isolation, buildValues } from './contract';
import type { Isolation } from './contract';

const API = 'https://api.cloudflare.com/client/v4';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const object = (v: unknown): Record<string, unknown> => {
  requireRelease(
    v && typeof v === 'object' && !Array.isArray(v),
    'PREVIEW_PROVIDER_SCHEMA_INVALID',
  );
  return v as Record<string, unknown>;
};
/** GET-only discovery plus the existing authenticated, scoped Task 05 readback.
 * No provider body, secret binding or response message is returned to callers. */
export class PreviewReadback {
  readonly #pins: Isolation;
  readonly #token: string;
  readonly #transport: ReadTransport;
  constructor(
    pins: Isolation,
    token: string,
    private readonly fixture?: ReadTransport,
  ) {
    this.#pins = isolation(pins.target, pins.deny);
    requireRelease(/^[A-Za-z0-9_-]{20,256}$/.test(token), 'PREVIEW_INFRASTRUCTURE_NOT_CONFIGURED');
    this.#token = token;
    this.#transport = fixture ?? ((url, init) => fetch(url, init));
  }
  async #get(path: string) {
    const url = `${API}/accounts/${this.#pins.target.accountId}/${path}`;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReleaseError('PREVIEW_PROVIDER_TIMEOUT'));
      }, 10000);
    });
    try {
      return await Promise.race([
        timeout,
        (async () => {
          const r = await this.#transport(url, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            cache: 'no-store',
            headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' },
          });
          requireRelease(
            r.status === 200 &&
              !r.redirected &&
              (!r.url || r.url === url) &&
              /^application\/json(?:;|$)/i.test(r.headers.get('content-type') ?? ''),
            'PREVIEW_PROVIDER_READ_FAILED',
          );
          const age = Date.now() - Date.parse(r.headers.get('date') ?? '');
          requireRelease(
            Number.isFinite(age) && age >= -5000 && age <= 60000,
            'PREVIEW_PROVIDER_STALE',
          );
          requireRelease(r.body, 'PREVIEW_PROVIDER_SCHEMA_INVALID');
          reader = r.body.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            requireRelease(size <= 512 * 1024, 'PREVIEW_PROVIDER_RESPONSE_LIMIT');
            chunks.push(item.value);
          }
          const body = object(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
          );
          requireRelease(
            body.success === true && Array.isArray(body.errors) && body.errors.length === 0,
            'PREVIEW_PROVIDER_READ_FAILED',
          );
          return object(body.result);
        })(),
      ]);
    } catch (e) {
      throw new ReleaseError(e instanceof ReleaseError ? e.code : 'PREVIEW_PROVIDER_READ_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    }
  }
  async observe(manifest?: Manifest, requirePagesSource = true) {
    const t = this.#pins.target;
    const worker = `workers/scripts/${t.worker}`;
    const deployment = await this.#get(`${worker}/deployments?page=1&per_page=1`);
    requireRelease(
      Array.isArray(deployment.deployments) && deployment.deployments.length === 1,
      'PREVIEW_SINGLE_ACTIVE_VERSION_REQUIRED',
    );
    const active = object(deployment.deployments[0]);
    requireRelease(
      typeof active.id === 'string' &&
        UUID.test(active.id) &&
        Array.isArray(active.versions) &&
        active.versions.length === 1,
      'PREVIEW_SINGLE_ACTIVE_VERSION_REQUIRED',
    );
    const version = object(active.versions[0]);
    requireRelease(
      version.percentage === 100 &&
        typeof version.version_id === 'string' &&
        UUID.test(version.version_id),
      'PREVIEW_SINGLE_ACTIVE_VERSION_REQUIRED',
    );
    const project = await this.#get(`pages/projects/${t.project}`);
    requireRelease(
      project.id === t.projectId &&
        project.name === t.project &&
        project.subdomain === `${t.project}.pages.dev` &&
        project.production_branch === 'release' &&
        Array.isArray(project.domains) &&
        project.domains.every((v) => v === `${t.project}.pages.dev`),
      'PREVIEW_PROJECT_IDENTITY_MISMATCH',
    );
    const canonical = object(project.canonical_deployment);
    const workerCreatedAt = active.created_on,
      pagesCreatedAt = canonical.created_on;
    requireRelease(
      typeof workerCreatedAt === 'string' &&
        Number.isFinite(Date.parse(workerCreatedAt)) &&
        typeof pagesCreatedAt === 'string' &&
        Number.isFinite(Date.parse(pagesCreatedAt)),
      'PREVIEW_DEPLOYMENT_TIME_UNVERIFIED',
    );
    requireRelease(
      typeof canonical.id === 'string' && UUID.test(canonical.id),
      'PREVIEW_BASELINE_ID_REQUIRED',
    );
    const expected: ReadOnlyExpectation = {
      schemaVersion: 1,
      accountId: t.accountId,
      environment: 'preview',
      worker: t.worker,
      workerVersion: version.version_id,
      workerDeployment: active.id,
      project: t.project,
      projectId: t.projectId,
      pagesSubdomain: `${t.project}.pages.dev`,
      pagesDeployment: canonical.id,
      pagesEnvironment: 'production',
      origin: t.origin,
      migrationTag: t.migrationTag,
      durableObjects: t.durableObjects,
    };
    const settings = await this.#get(`${worker}/versions/${expected.workerVersion}`);
    const resources = object(settings.resources);
    requireRelease(Array.isArray(resources.bindings), 'PREVIEW_WORKER_BINDINGS_REQUIRED');
    const bindings = resources.bindings.map(object);
    const text = (name: string) =>
      bindings.find((b) => b.name === name && b.type === 'plain_text')?.text;
    const config = deploymentConfig('preview', buildValues(t), process.cwd());
    requireRelease(
      Object.entries(config.worker.vars).every(([name, value]) => text(name) === value) &&
        bindings
          .filter((b) => b.type === 'plain_text')
          .every((b) => Object.hasOwn(config.worker.vars, String(b.name))),
      'PREVIEW_EXTRA_OR_CHANGED_VARIABLE',
    );
    requireRelease(
      bindings
        .filter((b) => b.type === 'ratelimit')
        .every((b) => config.worker.ratelimits.some((v) => v.name === b.name)),
      'PREVIEW_UNEXPECTED_WRITABLE_RESOURCE',
    );
    requireRelease(
      text('TURN_PROVIDER') === 'direct' &&
        text('TURN_URLS') === '' &&
        text('ADMISSION_PAUSED') === 'true',
      'PREVIEW_ADMISSION_OR_TURN_UNVERIFIED',
    );
    requireRelease(
      bindings
        .filter((b) => b.type === 'secret_text')
        .every((b) => b.name === 'OPS_REVOKE_SECRET') &&
        bindings.some((b) => b.name === 'OPS_REVOKE_SECRET' && b.type === 'secret_text'),
      'PREVIEW_SECRET_ISOLATION_UNVERIFIED',
    );
    requireRelease(
      !bindings.some(
        (b) =>
          !['plain_text', 'secret_text', 'durable_object_namespace', 'ratelimit'].includes(
            String(b.type),
          ),
      ),
      'PREVIEW_UNEXPECTED_WRITABLE_RESOURCE',
    );
    if (manifest) {
      requireRelease(
        object(settings.annotations)['workers/message'] === manifest.id,
        'PREVIEW_UPLOAD_MANIFEST_CORRELATION_MISSING',
      );
      if (requirePagesSource) {
        const p = await this.#get(
          `pages/projects/${t.project}/deployments/${expected.pagesDeployment}`,
        );
        requireRelease(
          object(object(p.deployment_trigger).metadata).commit_hash === manifest.sourceCommit,
          'PREVIEW_PAGES_SOURCE_CORRELATION_MISSING',
        );
      }
    }
    const adapter = new CloudflareReadOnly(
      expected,
      this.#token,
      this.fixture ? { transport: this.#transport } : {},
    );
    const observation = await adapter.observe();
    requireRelease(
      observation.current.admissionPaused === true,
      'PREVIEW_ADMISSION_MUST_STAY_PAUSED',
    );
    if (!this.fixture) requireHostedObservation(observation, new Date());
    return { expected, observation, workerCreatedAt, pagesCreatedAt };
  }
}
