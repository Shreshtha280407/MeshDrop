import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareReadOnly,
  parseReadOnlyExpectation,
  READ_MAX_BYTES,
  READ_TIMEOUT_MS,
  verifyObservedAdmission,
} from '../../scripts/deploy/cloudflare-readonly';
import type { ReadOnlyExpectation, ReadTransport } from '../../scripts/deploy/cloudflare-readonly';
import { hostedProvider } from '../../scripts/deploy/release-lifecycle';
import { parseRecord, requireAccepted, ReleaseError } from '../../scripts/deploy/release-record';
import {
  runReadOnlyPreflight,
  verifyExpectedArchitecture,
} from '../../scripts/deploy/preflight-cloudflare';
import {
  FIXTURE_TOKEN,
  fixtureTransport,
  jsonResponse,
  readOnlyExpectation,
  readOnlyResponses,
} from '../fixtures/cloudflare-readonly';
import {
  acceptedFixture,
  manifestFixture,
  NOW,
  NEW_WORKER,
  OLD_WORKER,
} from '../fixtures/release-record';

const now = () => new Date(NOW);
const object = (value: unknown) => value as Record<string, unknown>;
const responses = readOnlyResponses;
function setup(data = responses(), expected = readOnlyExpectation()) {
  const fixture = fixtureTransport(data, expected);
  return {
    ...fixture,
    adapter: new CloudflareReadOnly(expected, FIXTURE_TOKEN, { transport: fixture.transport, now }),
  };
}
function withTransport(transport: ReadTransport) {
  return new CloudflareReadOnly(readOnlyExpectation(), FIXTURE_TOKEN, { transport, now });
}
beforeEach(() => {
  // Any accidental default network call fails the suite; all provider data is injected.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network forbidden'));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scoped documented readback', () => {
  it.each(['preview', 'production'] as const)(
    'checks exact identities in the %s application environment',
    async (environment) => {
      const expected = readOnlyExpectation();
      expected.environment = environment;
      expected.project = `meshdrop-fixture-${environment}`;
      expected.worker = `${expected.project}-signaling`;
      expected.origin = `https://${expected.project}.pages.dev`;
      expected.pagesSubdomain = `${expected.project}.pages.dev`;
      const test = setup(responses(expected), expected);
      const result = await test.adapter.observe();
      expect(result).toMatchObject({
        scope: 'offline-fixture',
        providerConfirmed: false,
        current: {
          accountId: expected.accountId,
          environment,
          worker: expected.worker,
          workerVersion: expected.workerVersion,
          pagesDeployment: expected.pagesDeployment,
          admissionPaused: true,
        },
        projectId: expected.projectId,
        workerDeployment: expected.workerDeployment,
        migrationTag: 'v2',
        classStorage: { SessionRoom: 'sqlite', RelayPool: 'sqlite', OperationsMonitor: 'sqlite' },
        releaseAccepted: false,
        productionApproved: false,
        publicationEnabled: false,
      });
      expect(result.unverified).toContain('ARTIFACT_TO_PROVIDER_CORRELATION_UNVERIFIED');
      expect(test.calls).toHaveLength(6);
      for (const { url, init } of test.calls) {
        expect(url).toMatch(/^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\//);
        expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
        expect(init.signal.aborted).toBe(true);
        expect(Object.keys(init).sort()).toEqual([
          'cache',
          'headers',
          'method',
          'redirect',
          'signal',
        ]);
      }
      expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
      expect(JSON.stringify(result)).not.toContain('UNUSED_SECRET');
      expect(JSON.stringify(result)).not.toContain('etag');
      expect(result).not.toHaveProperty('manifestId');
      expect(test.adapter).not.toHaveProperty('publishWorker');
      expect(test.adapter).not.toHaveProperty('publishPages');
    },
  );
  it.each([true, false])(
    'reads admission %s from the active version, independently of desired state',
    async (paused) => {
      expect(
        (await setup(responses(undefined, paused)).adapter.observe()).current.admissionPaused,
      ).toBe(paused);
    },
  );
  it('verifies a configured custom domain without requesting its public URL', async () => {
    const expected = { ...readOnlyExpectation(), origin: 'https://meshdrop.example.test' };
    const test = setup(responses(expected), expected);
    expect((await test.adapter.observe()).route).toBe('canonical-production');
    expect(test.calls).toHaveLength(7);
    expect(test.calls.every(({ url }) => new URL(url).hostname === 'api.cloudflare.com')).toBe(
      true,
    );
  });
  it('allows optional created state to be omitted as documented', async () => {
    const data = responses();
    delete object(data.version.resources.script_runtime.exports.SessionRoom).state;
    expect((await setup(data).adapter.observe()).classStorage.SessionRoom).toBe('sqlite');
  });
  it('uses opaque project IDs and a pinned subdomain without deriving either', async () => {
    const expected = {
      ...readOnlyExpectation(),
      projectId: 'opaque-provider-project-id',
      pagesSubdomain: 'explicit-subdomain.pages.dev',
      origin: 'https://explicit-subdomain.pages.dev',
    };
    const data = responses(expected),
      test = setup(data, expected);
    const observation = await test.adapter.observe();
    expect(observation.projectId).toBe(expected.projectId);
    expect(observation.pagesSubdomain).toBe(expected.pagesSubdomain);
    data.project.subdomain = 'wrong-subdomain.pages.dev';
    await expect(test.adapter.observe()).rejects.toThrow('PAGES_PROJECT_MISMATCH');
  });
  it('accepts an explicitly self-scoped Durable Object binding', async () => {
    const data = responses();
    object(data.version.resources.bindings[3]).script_name = readOnlyExpectation().worker;
    object(data.version.resources.bindings[3]).environment = 'production';
    expect((await setup(data).adapter.observe()).classStorage.SessionRoom).toBe('sqlite');
  });
  it('does not mistake old creation dates for stale current observations', async () => {
    const data = responses();
    data.active.deployments[0]!.created_on = '2020-01-01T00:00:00.000Z';
    expect((await setup(data).adapter.observe()).observedAt).toBe(NOW);
  });
  it('discards unknown provider fields and ignores URLs/next-page instructions', async () => {
    const data = responses();
    object(data.version).unknown = {
      token: FIXTURE_TOKEN,
      url: 'https://attacker.invalid',
      method: 'POST',
    };
    const fixture = fixtureTransport(data);
    const test = withTransport(async (url, init) => {
      const response = await fixture.transport(url, init);
      const body = object(await response.json());
      body.next = `https://attacker.invalid/${FIXTURE_TOKEN}`;
      return new Response(JSON.stringify(body), { headers: response.headers });
    });
    expect(JSON.stringify(await test.observe())).not.toMatch(/attacker|token|unknown/);
    expect(fixture.calls.every(({ init }) => init.method === 'GET')).toBe(true);
  });
  it('validates first-page pagination without scanning historical deployments', async () => {
    const fixture = fixtureTransport();
    const adapter = withTransport(async (url, init) => {
      const response = await fixture.transport(url, init);
      const body = object(await response.json());
      if (url.includes('?'))
        body.result_info = { count: 1, page: 1, per_page: 1, total_count: 5000, total_pages: 5000 };
      return new Response(JSON.stringify(body), { headers: response.headers });
    });
    await adapter.observe();
    expect(fixture.calls.filter(({ url }) => url.includes('?'))).toHaveLength(2);
    expect(fixture.calls.every(({ url }) => !url.includes('page=2'))).toBe(true);
  });
});

describe('identity and configuration failures', () => {
  it.each(['accountId', 'worker', 'project'] as const)(
    'rejects a wrong scoped %s through the exact endpoint',
    async (field) => {
      const expected = readOnlyExpectation(),
        fixture = fixtureTransport();
      if (field === 'accountId') expected.accountId = 'd'.repeat(32);
      else {
        expected.project = 'meshdrop-other-preview';
        expected.worker = `${expected.project}-signaling`;
      }
      await expect(
        new CloudflareReadOnly(expected, FIXTURE_TOKEN, {
          transport: fixture.transport,
          now,
        }).observe(),
      ).rejects.toThrow('CLOUDFLARE_READ_HTTP_ERROR');
    },
  );
  const mutations: {
    name: string;
    change: (data: ReturnType<typeof responses>) => void;
    code: string;
  }[] = [
    {
      name: 'missing Worker deployment ID',
      change: (d) => {
        delete object(d.active.deployments[0]).id;
      },
      code: 'MISSING_OR_INVALID_PROVIDER_ID',
    },
    {
      name: 'wrong Worker deployment ID',
      change: (d) => {
        d.active.deployments[0]!.id = NEW_WORKER;
      },
      code: 'WORKER_DEPLOYMENT_MISMATCH',
    },
    {
      name: 'wrong Worker version',
      change: (d) => {
        d.version.id = NEW_WORKER;
      },
      code: 'WORKER_VERSION_MISMATCH',
    },
    {
      name: 'split Worker traffic',
      change: (d) => {
        d.active.deployments[0]!.versions = [
          { version_id: OLD_WORKER, percentage: 50 },
          { version_id: NEW_WORKER, percentage: 50 },
        ];
      },
      code: 'CONFLICTING_WORKER_VERSIONS',
    },
    {
      name: 'missing active deployment',
      change: (d) => {
        d.active.deployments = [];
      },
      code: 'ACTIVE_WORKER_DEPLOYMENT_UNVERIFIED',
    },
    {
      name: 'deferred DO update',
      change: (d) => {
        object(d.active.deployments[0]).code_update_strategy = { mode: 'deferred', max_delay: 300 };
      },
      code: 'DEFERRED_WORKER_UPDATE_UNVERIFIED',
    },
    {
      name: 'missing Pages ID',
      change: (d) => {
        delete object(d.deployment).id;
      },
      code: 'MISSING_OR_INVALID_PROVIDER_ID',
    },
    {
      name: 'wrong Pages project ID',
      change: (d) => {
        d.deployment.project_id = NEW_WORKER;
      },
      code: 'PAGES_IDENTITY_MISMATCH',
    },
    {
      name: 'wrong Pages project name',
      change: (d) => {
        d.project.name = 'meshdrop-other-preview';
      },
      code: 'PAGES_PROJECT_MISMATCH',
    },
    {
      name: 'wrong Pages environment',
      change: (d) => {
        d.deployment.environment = 'preview';
      },
      code: 'PAGES_ENVIRONMENT_MISMATCH',
    },
    {
      name: 'wrong application environment',
      change: (d) => {
        object(d.version.resources.bindings[0]).text = 'production';
      },
      code: 'WORKER_ENVIRONMENT_MISMATCH',
    },
    {
      name: 'missing admission binding',
      change: (d) => {
        d.version.resources.bindings.splice(1, 1);
      },
      code: 'REQUIRED_WORKER_VARIABLE_UNVERIFIED',
    },
    {
      name: 'ambiguous admission value',
      change: (d) => {
        object(d.version.resources.bindings[1]).text = 'FALSE';
      },
      code: 'EXPLICIT_ADMISSION_STATE_REQUIRED',
    },
    {
      name: 'secret admission binding',
      change: (d) => {
        object(d.version.resources.bindings[1]).type = 'secret_text';
      },
      code: 'REQUIRED_WORKER_VARIABLE_UNVERIFIED',
    },
    {
      name: 'duplicate admission binding',
      change: (d) => {
        d.version.resources.bindings.push(d.version.resources.bindings[1]!);
      },
      code: 'AMBIGUOUS_WORKER_BINDINGS',
    },
    {
      name: 'missing version resources',
      change: (d) => {
        delete object(d.version).resources;
      },
      code: 'INVALID_API_SCHEMA',
    },
    {
      name: 'undocumented bindings shape',
      change: (d) => {
        object(d.version.resources).bindings = {};
      },
      code: 'INVALID_API_SCHEMA',
    },
    {
      name: 'missing migration tag',
      change: (d) => {
        delete object(d.version.resources.script_runtime).migration_tag;
      },
      code: 'MIGRATION_TAG_UNVERIFIED',
    },
    {
      name: 'different migration tag',
      change: (d) => {
        d.version.resources.script_runtime.migration_tag = 'v1';
      },
      code: 'MIGRATION_TAG_UNVERIFIED',
    },
    {
      name: 'wrong namespace ID',
      change: (d) => {
        object(d.version.resources.bindings[3]).namespace_id = '9'.repeat(32);
      },
      code: 'DURABLE_OBJECT_BINDING_MISMATCH',
    },
    {
      name: 'external DO script',
      change: (d) => {
        object(d.version.resources.bindings[3]).script_name = 'other-worker';
      },
      code: 'DURABLE_OBJECT_BINDING_MISMATCH',
    },
    {
      name: 'missing class export',
      change: (d) => {
        delete object(d.version.resources.script_runtime.exports).RelayPool;
      },
      code: 'DURABLE_OBJECT_EXPORT_MISMATCH',
    },
    {
      name: 'non-SQLite class',
      change: (d) => {
        object(d.version.resources.script_runtime.exports.SessionRoom).storage = 'legacy-kv';
      },
      code: 'DURABLE_OBJECT_LIFECYCLE_UNVERIFIED',
    },
    {
      name: 'pending class transfer',
      change: (d) => {
        object(d.version.resources.script_runtime.exports.SessionRoom).state = 'expecting-transfer';
      },
      code: 'DURABLE_OBJECT_LIFECYCLE_UNVERIFIED',
    },
    {
      name: 'wrong Worker origin',
      change: (d) => {
        object(d.version.resources.bindings[2]).text = 'https://attacker.invalid';
      },
      code: 'WORKER_ORIGIN_MISMATCH',
    },
    {
      name: 'failed Pages build',
      change: (d) => {
        d.deployment.latest_stage.status = 'failure';
      },
      code: 'PAGES_DEPLOYMENT_NOT_SUCCESSFUL',
    },
    {
      name: 'skipped Pages deployment',
      change: (d) => {
        d.deployment.is_skipped = true;
      },
      code: 'PAGES_DEPLOYMENT_NOT_SUCCESSFUL',
    },
    {
      name: 'wrong Pages origin',
      change: (d) => {
        d.deployment.env_vars.PUBLIC_ORIGIN.value = 'https://attacker.invalid';
      },
      code: 'PAGES_ORIGIN_MISMATCH',
    },
    {
      name: 'wrong Pages signaling service',
      change: (d) => {
        d.project.deployment_configs.production!.services.SIGNALING.service = 'other-worker';
      },
      code: 'PAGES_SERVICE_SCOPE_MISMATCH',
    },
    {
      name: 'wrong Pages service environment',
      change: (d) => {
        d.project.deployment_configs.production!.services.SIGNALING.environment = 'preview';
      },
      code: 'PAGES_SERVICE_SCOPE_MISMATCH',
    },
  ];
  it.each(mutations)('rejects $name', async ({ change, code }) => {
    const data = responses();
    change(data);
    await expect(setup(data).adapter.observe()).rejects.toThrow(code);
  });
  it('rejects an explicit native Pages preview instead of assuming a canonical active route', async () => {
    const expected = { ...readOnlyExpectation(), pagesEnvironment: 'preview' as const };
    await expect(setup(responses(expected), expected).adapter.observe()).rejects.toThrow(
      'ACTIVE_PAGES_ROUTE_UNVERIFIED',
    );
  });
  it('rejects an unexpected Durable Object export outside the pinned inventory', async () => {
    const data = responses();
    object(data.version.resources.script_runtime.exports).UnexpectedActor = {
      type: 'durable-object',
      storage: 'sqlite',
    };
    await expect(setup(data).adapter.observe()).rejects.toThrow('DURABLE_OBJECT_EXPORT_MISMATCH');
  });
  it('rejects an inactive custom domain', async () => {
    const expected = { ...readOnlyExpectation(), origin: 'https://meshdrop.example.test' };
    const data = responses(expected);
    data.domain.status = 'pending';
    await expect(setup(data, expected).adapter.observe()).rejects.toThrow(
      'PAGES_CUSTOM_DOMAIN_UNVERIFIED',
    );
  });
  it('rejects changing active Worker identities', async () => {
    const fixture = fixtureTransport();
    let lists = 0;
    const adapter = withTransport(async (url, init) => {
      if (url.includes('?') && ++lists === 2) {
        const data = responses();
        data.active.deployments[0]!.versions[0]!.version_id = NEW_WORKER;
        return jsonResponse(data.active);
      }
      return fixture.transport(url, init);
    });
    await expect(adapter.observe()).rejects.toThrow('CONFLICTING_WORKER_VERSIONS');
  });
  it('rejects changing Pages canonical identities', async () => {
    const data = responses(),
      fixture = fixtureTransport(data);
    let projects = 0;
    const adapter = withTransport(async (url, init) => {
      if (url.endsWith(readOnlyExpectation().project) && ++projects === 2)
        data.project.canonical_deployment.id = NEW_WORKER;
      return fixture.transport(url, init);
    });
    await expect(adapter.observe()).rejects.toThrow('PAGES_IDENTITY_MISMATCH');
  });
});

describe('bounded read-only transport', () => {
  it.each([401, 403, 429, 500, 503, 404])(
    'sanitizes HTTP %i without logging error bodies or retrying',
    async (status) => {
      const transport = vi
        .fn<ReadTransport>()
        .mockResolvedValue(new Response(FIXTURE_TOKEN, { status }));
      await expect(withTransport(transport).observe()).rejects.toThrow(
        status === 401 || status === 403
          ? 'CLOUDFLARE_READ_UNAUTHORIZED'
          : status === 429
            ? 'CLOUDFLARE_READ_RATE_LIMITED'
            : status >= 500
              ? 'CLOUDFLARE_READ_SERVER_ERROR'
              : 'CLOUDFLARE_READ_HTTP_ERROR',
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([false, true])('redacts raw transport exceptions (ReleaseError=%s)', async (release) => {
    const adapter = withTransport(async () => {
      throw release ? new ReleaseError(FIXTURE_TOKEN) : new Error(FIXTURE_TOKEN);
    });
    await expect(adapter.observe()).rejects.toThrow('CLOUDFLARE_READ_FAILED');
  });
  it('rejects API failure envelopes without reflecting messages', async () => {
    const response = jsonResponse(null);
    const body = {
      success: false,
      errors: [{ code: 10000, message: FIXTURE_TOKEN }],
      messages: [],
      result: null,
    };
    await expect(
      withTransport(
        async () => new Response(JSON.stringify(body), { headers: response.headers }),
      ).observe(),
    ).rejects.toThrow('CLOUDFLARE_API_ERROR');
  });
  it.each(['{broken', 'null', '[]'])(
    'rejects malformed or non-object API JSON %s',
    async (body) => {
      await expect(
        withTransport(
          async () => new Response(body, { headers: jsonResponse(null).headers }),
        ).observe(),
      ).rejects.toThrow(/INVALID_API_JSON|INVALID_API_SCHEMA/);
    },
  );
  it('rejects an HTML response', async () => {
    await expect(
      withTransport(
        async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
      ).observe(),
    ).rejects.toThrow('INVALID_API_CONTENT_TYPE');
  });
  it.each(['2026-11-04T23:58:00Z', '2026-11-05T00:00:06Z'])(
    'rejects a stale/future HTTP observation %s',
    async (date) => {
      await expect(
        withTransport(async () =>
          jsonResponse(responses().active, { date: new Date(date).toUTCString() }),
        ).observe(),
      ).rejects.toThrow('STALE_HOSTED_PREFLIGHT');
    },
  );
  it('rejects a missing HTTP date', async () => {
    const response = jsonResponse(responses().active);
    response.headers.delete('date');
    await expect(withTransport(async () => response).observe()).rejects.toThrow('INVALID_API_TIME');
  });
  it.each([false, true])(
    'bounds response size even without Content-Length (header=%s)',
    async (header) => {
      const headers = new Headers(jsonResponse(null).headers);
      if (header) headers.set('content-length', String(READ_MAX_BYTES + 1));
      await expect(
        withTransport(
          async () => new Response('x'.repeat(READ_MAX_BYTES + 1), { headers }),
        ).observe(),
      ).rejects.toThrow('CLOUDFLARE_RESPONSE_TOO_LARGE');
    },
  );
  it('rejects redirect attempts without following Location', async () => {
    const transport = vi
      .fn<ReadTransport>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }),
      );
    await expect(withTransport(transport).observe()).rejects.toThrow(
      'CLOUDFLARE_REDIRECT_REJECTED',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects a transport that already followed a redirect', async () => {
    const response = jsonResponse(responses().active);
    Object.defineProperty(response, 'redirected', { value: true });
    await expect(withTransport(async () => response).observe()).rejects.toThrow(
      'CLOUDFLARE_REDIRECT_REJECTED',
    );
  });
  it('rejects unexpected response URLs', async () => {
    const response = jsonResponse(responses().active);
    Object.defineProperty(response, 'url', { value: 'https://attacker.invalid' });
    await expect(withTransport(async () => response).observe()).rejects.toThrow(
      'CLOUDFLARE_REDIRECT_REJECTED',
    );
  });
  it('enforces a timeout even when a transport ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<ReadTransport>().mockImplementation(() => new Promise(() => {}));
    const assertion = expect(withTransport(transport).observe()).rejects.toThrow(
      'CLOUDFLARE_READ_TIMEOUT',
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    await assertion;
    expect(transport.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  it('bounds slow body reads and cancels the reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: jsonResponse(null).headers,
    });
    const assertion = expect(withTransport(async () => response).observe()).rejects.toThrow(
      'CLOUDFLARE_READ_TIMEOUT',
    );
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels a response returned after the transport deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let resolveResponse: (response: Response) => void = () => {};
    const adapter = withTransport(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const assertion = expect(adapter.observe()).rejects.toThrow('CLOUDFLARE_READ_TIMEOUT');
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    await assertion;
    resolveResponse(
      new Response(new ReadableStream({ cancel }), { headers: jsonResponse(null).headers }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('redacts a failing response stream', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new ReleaseError(FIXTURE_TOKEN));
      },
    });
    await expect(
      withTransport(
        async () => new Response(body, { headers: jsonResponse(null).headers }),
      ).observe(),
    ).rejects.toThrow('CLOUDFLARE_READ_FAILED');
  });
  it('rejects pagination that could select an old deployment', async () => {
    const response = jsonResponse(responses().active);
    const body = object(await response.json());
    body.result_info = { page: 2, per_page: 1, total_count: 5 };
    await expect(
      withTransport(
        async () => new Response(JSON.stringify(body), { headers: response.headers }),
      ).observe(),
    ).rejects.toThrow('UNVERIFIED_API_PAGINATION');
  });
});

describe('lifecycle trust and admission boundaries', () => {
  it('preserves paused admission and rejects unauthorized reopening', async () => {
    const observation = await setup().adapter.observe();
    verifyObservedAdmission(
      manifestFixture(),
      observation,
      { action: 'preserve', confirmation: '' },
      now(),
    );
    const open = manifestFixture({ admissionPaused: false });
    expect(() =>
      verifyObservedAdmission(open, observation, { action: 'preserve', confirmation: '' }, now()),
    ).toThrow('ADMISSION_PRESERVATION_FAILED');
    expect(() =>
      verifyObservedAdmission(open, observation, { action: 'reopen', confirmation: '' }, now()),
    ).toThrow('EXPLICIT_REOPEN_CONFIRMATION_REQUIRED');
    verifyObservedAdmission(
      open,
      observation,
      { action: 'reopen', confirmation: `REOPEN:preview:${OLD_WORKER}:${open.id}` },
      now(),
    );
    expect(observation.releaseAccepted).toBe(false);
  });
  it('rejects an observation from a different application scope', async () => {
    const observation = await setup().adapter.observe();
    expect(() =>
      verifyObservedAdmission(
        manifestFixture({ accountId: 'd'.repeat(32) }),
        observation,
        { action: 'preserve', confirmation: '' },
        now(),
      ),
    ).toThrow('ADMISSION_SCOPE_MISMATCH');
  });
  it('rejects expired, serialized and modified observations', async () => {
    const observation = await setup().adapter.observe();
    const manifest = manifestFixture(),
      intent = { action: 'preserve' as const, confirmation: '' };
    expect(() =>
      verifyObservedAdmission(manifest, observation, intent, new Date(Date.parse(NOW) + 60001)),
    ).toThrow('STALE_HOSTED_PREFLIGHT');
    expect(() =>
      verifyObservedAdmission(manifest, structuredClone(observation), intent, now()),
    ).toThrow('UNTRUSTED_OR_MODIFIED_OBSERVATION');
    observation.current.admissionPaused = false;
    expect(() => verifyObservedAdmission(manifest, observation, intent, now())).toThrow(
      'UNTRUSTED_OR_MODIFIED_OBSERVATION',
    );
  });
  it('does not promote fixture observations to authenticated lifecycle current()', async () => {
    const test = setup();
    await expect(test.adapter.current()).rejects.toThrow('AUTHENTICATED_READBACK_REQUIRED');
    expect(test.calls).toHaveLength(0);
  });
  it('cannot populate or accept release provenance or enable publication', async () => {
    const observation = await setup().adapter.observe(),
      manifest = manifestFixture();
    expect(() => parseRecord(observation, manifest)).toThrow();
    expect(() => requireAccepted(manifest, acceptedFixture(manifest))).toThrow(
      'UNVERIFIED_RELEASE_PROVENANCE',
    );
    expect(hostedProvider).toThrow('HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED');
    expect(observation.publicationEnabled).toBe(false);
  });
  it('does not expose private token values through object serialization', () => {
    expect(JSON.stringify(setup().adapter)).toBe('{}');
  });
  it('preserves constructor scope when a caller changes its original input', async () => {
    const expected = readOnlyExpectation(),
      test = setup(responses(expected), expected);
    expected.accountId = 'd'.repeat(32);
    expect((await test.adapter.observe()).current.accountId).toBe('c'.repeat(32));
  });
});

describe('operator diagnostic', () => {
  it.each([
    { worker: '../untrusted' },
    { accountId: 'wrong' },
    { environment: undefined },
    { pagesDeployment: undefined },
    { projectId: '' },
    { origin: 'https://good.test@evil.test' },
    { unknownToken: FIXTURE_TOKEN },
    { migrationTag: '' },
  ])('rejects malformed expected scope case %#', (change) => {
    expect(() => parseReadOnlyExpectation({ ...readOnlyExpectation(), ...change })).toThrow();
  });
  it('compares required bindings/migrations with the actual local architecture', async () => {
    const config = ts.parseConfigFileTextToJson(
      'wrangler.jsonc',
      await readFile('apps/signaling/wrangler.jsonc', 'utf8'),
    ).config as unknown;
    const expected = readOnlyExpectation();
    verifyExpectedArchitecture(expected, config);
    delete expected.durableObjects.RELAY_POOLS;
    expect(() => verifyExpectedArchitecture(expected, config)).toThrow(
      'EXPECTED_ARCHITECTURE_MISMATCH',
    );
  });
  it('reports missing credentials as UNVERIFIED without reading files or making requests', async () => {
    const create = vi.fn();
    const result = await runReadOnlyPreflight(
      ['--read-only', 'preview', '/nonexistent'],
      undefined,
      process.cwd(),
      create,
    );
    expect(result).toMatchObject({
      exitCode: 1,
      report: {
        status: 'UNVERIFIED',
        code: 'READ_ONLY_CREDENTIAL_REQUIRED',
        productionApproved: false,
      },
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('requires an explicit read-only flag and environment', async () => {
    expect(
      (await runReadOnlyPreflight(['preview'], FIXTURE_TOKEN, process.cwd())).report,
    ).toMatchObject({ status: 'UNVERIFIED', code: 'EXPLICIT_READ_ONLY_SCOPE_REQUIRED' });
  });
  it('never treats a successful fixture diagnostic as verified hosted evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meshdrop-preflight-test-'));
    const path = join(directory, 'expected.json');
    try {
      await writeFile(path, JSON.stringify(readOnlyExpectation()));
      const create = (expected: ReadOnlyExpectation, token: string) =>
        new CloudflareReadOnly(expected, token, { transport: fixtureTransport().transport, now });
      const result = await runReadOnlyPreflight(
        ['--read-only', 'preview', path],
        FIXTURE_TOKEN,
        process.cwd(),
        create,
      );
      expect(result).toMatchObject({
        exitCode: 1,
        report: {
          status: 'UNVERIFIED',
          observation: { scope: 'offline-fixture', providerConfirmed: false },
        },
      });
      expect(JSON.stringify(result)).not.toContain(FIXTURE_TOKEN);
      expect(
        (
          await runReadOnlyPreflight(
            ['--read-only', 'production', path],
            FIXTURE_TOKEN,
            process.cwd(),
            create,
          )
        ).report,
      ).toMatchObject({ code: 'PREFLIGHT_ENVIRONMENT_MISMATCH' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('executes the real CLI without credentials and preserves the Git HEAD', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    const env = { ...process.env };
    delete env.MESHDROP_CLOUDFLARE_READ_TOKEN;
    const result = spawnSync(
      'pnpm',
      ['preflight:cloud', '--read-only', 'preview', '/nonexistent'],
      { encoding: 'utf8', env },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('READ_ONLY_CREDENTIAL_REQUIRED');
    expect(result.stdout).not.toContain(FIXTURE_TOKEN);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
  }, 30000);
});
