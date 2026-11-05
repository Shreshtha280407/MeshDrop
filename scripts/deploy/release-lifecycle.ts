import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acceptRelease,
  canonical,
  initialRecord,
  parseManifest,
  parseRecord,
  requireRelease,
  ReleaseError,
  validateIdentity,
  fingerprint,
} from './release-record';
import type { Manifest, ProviderIdentity, ReleaseRecord } from './release-record';

export type CurrentDeployment = Pick<
  ProviderIdentity,
  | 'accountId'
  | 'environment'
  | 'worker'
  | 'project'
  | 'origin'
  | 'workerVersion'
  | 'pagesDeployment'
  | 'admissionPaused'
  | 'observedAt'
>;
export type AdmissionIntent = { action: 'preserve' | 'pause' | 'reopen'; confirmation: string };
export function admissionIntent(value: string | undefined, confirmation = ''): AdmissionIntent {
  requireRelease(
    value === 'preserve' || value === 'pause' || value === 'reopen',
    'EXPLICIT_ADMISSION_ACTION_REQUIRED',
  );
  return { action: value, confirmation };
}
export function explicitPause(value: string | undefined): boolean {
  requireRelease(value === 'true' || value === 'false', 'EXPLICIT_ADMISSION_STATE_REQUIRED');
  return value === 'true';
}
function fresh(observedAt: string, now: Date) {
  const age = now.getTime() - Date.parse(observedAt);
  requireRelease(Number.isFinite(age) && age >= -5000 && age <= 60000, 'STALE_HOSTED_PREFLIGHT');
}
export function verifyAdmission(
  manifest: Manifest,
  live: CurrentDeployment,
  intent: AdmissionIntent,
  now: Date,
): void {
  for (const key of ['accountId', 'environment', 'worker', 'project', 'origin'] as const)
    requireRelease(live[key] === manifest[key], 'ADMISSION_SCOPE_MISMATCH');
  fresh(live.observedAt, now);
  requireRelease(typeof live.admissionPaused === 'boolean', 'UNKNOWN_LIVE_ADMISSION_STATE');
  if (intent.action === 'preserve')
    requireRelease(
      manifest.admissionPaused === live.admissionPaused,
      'ADMISSION_PRESERVATION_FAILED',
    );
  if (intent.action === 'pause')
    requireRelease(manifest.admissionPaused, 'PAUSE_ACTION_REQUIRES_PAUSED_STATE');
  if (intent.action === 'reopen')
    requireRelease(
      !manifest.admissionPaused &&
        intent.confirmation ===
          `REOPEN:${manifest.environment}:${live.workerVersion}:${manifest.id}`,
      'EXPLICIT_REOPEN_CONFIRMATION_REQUIRED',
    );
  if (live.admissionPaused && !manifest.admissionPaused)
    requireRelease(intent.action === 'reopen', 'UNAUTHORIZED_REOPENING');
}

/** No default network transport, CLI parser or provider credential is hidden here. */
export interface PublicationProvider {
  readonly mode: 'offline-fixture' | 'hosted-observation';
  current(): Promise<CurrentDeployment>;
  publishWorker(manifest: Manifest): Promise<void>;
  confirmWorker(
    manifest: Manifest,
  ): Promise<
    Pick<
      ProviderIdentity,
      'workerVersion' | 'manifestId' | 'sourceCommit' | 'configurationSha256' | 'observedAt'
    >
  >;
  publishPages(manifest: Manifest): Promise<void>;
  confirmPages(
    manifest: Manifest,
  ): Promise<
    Pick<
      ProviderIdentity,
      'pagesDeployment' | 'manifestId' | 'sourceCommit' | 'configurationSha256' | 'observedAt'
    >
  >;
  readiness(manifest: Manifest): Promise<{
    health: number;
    ready: number;
    newRoom: number;
    admissionPaused: boolean;
    authorizationVerified: boolean;
    existingSessionVerified: boolean;
  }>;
  cleanup(): Promise<void>;
}
/** Hosted readback semantics require a separately reviewed adapter, never a fixture fallback. */
export function hostedProvider(): never {
  throw new ReleaseError('HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED');
}

/** An optional write-ahead evidence port; it does not authenticate a store by itself. */
export interface ReleaseEvidenceSink {
  checkpoint(record: ReleaseRecord): Promise<void>;
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function exclusiveFile(path: string, contents: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
export class ReleaseJournal {
  private constructor(
    readonly directory: string,
    readonly manifest: Manifest,
    private record: ReleaseRecord,
    private readonly evidence: ReleaseEvidenceSink | undefined,
  ) {}
  static async create(
    directory: string,
    manifest: Manifest,
    evidence?: ReleaseEvidenceSink,
  ): Promise<ReleaseJournal> {
    parseManifest(manifest);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(dirname(directory));
    const record = initialRecord(manifest);
    await evidence?.checkpoint(record);
    await exclusiveFile(join(directory, 'manifest.json'), canonical(manifest));
    await exclusiveFile(join(directory, '000000.json'), canonical(record));
    await exclusiveFile(join(directory, 'release.json'), canonical(record));
    return new ReleaseJournal(directory, manifest, record, evidence);
  }
  current(): ReleaseRecord {
    return structuredClone(this.record);
  }
  async checkpoint(next: ReleaseRecord): Promise<void> {
    parseRecord(next, this.manifest);
    requireRelease(next.sequence === this.record.sequence + 1, 'CONFLICTING_RELEASE_SEQUENCE');
    requireRelease(
      canonical(JSON.parse(await readFile(join(this.directory, 'release.json'), 'utf8'))) ===
        canonical(this.record),
      'CONCURRENT_RELEASE_RECORD_CHANGE',
    );
    await this.evidence?.checkpoint(next);
    await exclusiveFile(
      join(this.directory, `${String(next.sequence).padStart(6, '0')}.json`),
      canonical(next),
    );
    const temporary = join(this.directory, `record-${randomUUID()}.tmp`);
    try {
      await exclusiveFile(temporary, canonical(next));
      await rename(temporary, join(this.directory, 'release.json'));
      await syncDirectory(this.directory);
      this.record = structuredClone(next);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async publish(
    provider: PublicationProvider,
    options: {
      previous: { manifest: Manifest; record: ReleaseRecord };
      authenticatePrevious(manifest: Manifest, record: ReleaseRecord): Promise<boolean>;
      admission: AdmissionIntent;
      integrity(): Promise<void>;
      now(): Date;
      signal?: AbortSignal;
    },
  ): Promise<ReleaseRecord> {
    requireRelease(provider.mode === 'offline-fixture', 'HOSTED_PUBLICATION_DISABLED');
    const lock = join(this.directory, 'publication.lock');
    await exclusiveFile(lock, 'Reconciliation required before retrying publication.\n');
    await exclusiveFile(
      join(
        dirname(this.directory),
        `environment-${fingerprint({ repository: this.manifest.repository, environment: this.manifest.environment })}.lock`,
      ),
      canonical({
        manifestId: this.manifest.id,
        environment: this.manifest.environment,
        instruction: 'Reconcile this attempt before permitting another release.',
      }),
    );
    let record = this.current();
    let failure: string | null = null;
    const checkpoint = async (
      phase: ReleaseRecord['phase'],
      update: Partial<ReleaseRecord> = {},
    ) => {
      const next = { ...record, ...update, phase, sequence: record.sequence + 1 };
      await this.checkpoint(next);
      record = next;
    };
    const active = (actual: CurrentDeployment, workerVersion: string, pagesDeployment: string) => {
      for (const key of ['accountId', 'environment', 'worker', 'project', 'origin'] as const)
        requireRelease(actual[key] === this.manifest[key], 'PROVIDER_SCOPE_MISMATCH');
      fresh(actual.observedAt, options.now());
      requireRelease(
        actual.workerVersion === workerVersion && actual.pagesDeployment === pagesDeployment,
        'CONCURRENT_PROVIDER_RELEASE',
      );
    };
    const check = async () => {
      requireRelease(!options.signal?.aborted, 'PUBLICATION_ABORTED');
      await options.integrity();
    };
    try {
      requireRelease(record.state === 'PREPARED', 'RELEASE_ALREADY_ATTEMPTED');
      parseManifest(options.previous.manifest);
      parseRecord(options.previous.record, options.previous.manifest);
      for (const key of ['accountId', 'environment', 'worker', 'project', 'origin'] as const)
        requireRelease(
          options.previous.manifest[key] === this.manifest[key],
          'PREVIOUS_RELEASE_SCOPE_MISMATCH',
        );
      requireRelease(
        options.previous.record.state === 'ACCEPTED' &&
          options.previous.record.scope === 'offline-fixture',
        'PREVIOUS_ACCEPTED_RELEASE_REQUIRED',
      );
      requireRelease(
        await options.authenticatePrevious(options.previous.manifest, options.previous.record),
        'PREVIOUS_ACCEPTANCE_UNVERIFIED',
      );
      const old = options.previous.record.provider;
      requireRelease(
        old.workerVersion && old.pagesDeployment,
        'PREVIOUS_ACCEPTED_RELEASE_REQUIRED',
      );
      const live = await provider.current();
      active(live, old.workerVersion, old.pagesDeployment);
      verifyAdmission(this.manifest, live, options.admission, options.now());
      await check();
      await checkpoint('preflight', {
        state: 'INCOMPLETE',
        scope: provider.mode,
        admission: {
          action: options.admission.action,
          observedPaused: live.admissionPaused,
          desiredPaused: this.manifest.admissionPaused,
          previousWorkerVersion: live.workerVersion,
        },
      });
      await checkpoint('worker-intent');
      await provider.publishWorker(this.manifest);
      await check();
      const worker = await provider.confirmWorker(this.manifest);
      requireRelease(
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(worker.workerVersion) &&
          worker.manifestId === this.manifest.id &&
          worker.sourceCommit === this.manifest.sourceCommit &&
          worker.configurationSha256 === this.manifest.configurationSha256,
        'WORKER_IDENTITY_UNCONFIRMED',
      );
      fresh(worker.observedAt, options.now());
      await checkpoint('worker-confirmed', {
        provider: { ...record.provider, workerVersion: worker.workerVersion },
      });
      const partial = await provider.current();
      active(partial, worker.workerVersion, old.pagesDeployment);
      requireRelease(
        partial.admissionPaused === this.manifest.admissionPaused,
        'ADMISSION_PUBLICATION_MISMATCH',
      );
      await check();
      await checkpoint('pages-intent');
      await provider.publishPages(this.manifest);
      await check();
      const pages = await provider.confirmPages(this.manifest);
      requireRelease(
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pages.pagesDeployment) &&
          pages.manifestId === this.manifest.id &&
          pages.sourceCommit === this.manifest.sourceCommit &&
          pages.configurationSha256 === this.manifest.configurationSha256,
        'PAGES_IDENTITY_UNCONFIRMED',
      );
      fresh(pages.observedAt, options.now());
      const final = await provider.current();
      active(final, worker.workerVersion, pages.pagesDeployment);
      const observation = validateIdentity(
        {
          ...final,
          manifestId: this.manifest.id,
          sourceCommit: this.manifest.sourceCommit,
          configurationSha256: this.manifest.configurationSha256,
        },
        this.manifest,
      );
      await checkpoint('pages-confirmed', {
        provider: {
          workerVersion: worker.workerVersion,
          pagesDeployment: pages.pagesDeployment,
          confirmed: false,
          observation,
        },
      });
      await checkpoint('readiness');
      const readiness = await provider.readiness(this.manifest);
      requireRelease(
        readiness.health === 200 &&
          readiness.ready === (this.manifest.admissionPaused ? 503 : 200) &&
          readiness.newRoom === (this.manifest.admissionPaused ? 503 : 201) &&
          readiness.admissionPaused === this.manifest.admissionPaused &&
          readiness.authorizationVerified &&
          readiness.existingSessionVerified,
        'RELEASE_READINESS_FAILED',
      );
      await check();
    } catch (error) {
      failure = error instanceof ReleaseError ? error.code : 'PUBLICATION_FAILED';
    } finally {
      try {
        await provider.cleanup();
      } catch {
        failure = 'PUBLICATION_CLEANUP_FAILED';
      }
    }
    await checkpoint(failure ? record.phase : 'published', {
      state: failure ? 'INCOMPLETE' : 'PUBLISHED',
      failure,
    });
    // Keep the write-ahead lock even on success: the same release is never retried.
    if (failure) throw new ReleaseError(failure);
    return this.current();
  }
  async accept(
    decision: NonNullable<ReleaseRecord['acceptance']>,
    expected: Parameters<typeof acceptRelease>[3],
    authorize: (
      manifest: Manifest,
      record: ReleaseRecord,
      decision: NonNullable<ReleaseRecord['acceptance']>,
    ) => Promise<boolean>,
  ): Promise<ReleaseRecord> {
    requireRelease(
      this.record.scope === 'offline-fixture',
      'HOSTED_ACCEPTANCE_AUTHORITY_NOT_CONFIGURED',
    );
    const next = acceptRelease(this.manifest, this.current(), decision, expected);
    requireRelease(
      await authorize(this.manifest, this.current(), decision),
      'AUTHENTICATED_OPERATOR_APPROVAL_REQUIRED',
    );
    await exclusiveFile(
      join(this.directory, 'acceptance.json'),
      canonical({ manifestId: this.manifest.id, ...decision }),
    );
    await this.checkpoint(next);
    return this.current();
  }
}

export async function writeBlockedPublication(
  directory: string,
  manifest: Manifest,
): Promise<never> {
  const record = parseRecord(
    JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')),
    manifest,
  );
  requireRelease(record.state === 'PREPARED', 'RELEASE_ALREADY_ATTEMPTED');
  // No credentials, .env reads or provider operations are performed by this path.
  await writeFile(
    join(directory, 'hosted-preflight-required.json'),
    canonical({
      recordVersion: 1,
      manifestId: manifest.id,
      code: 'HOSTED_PREFLIGHT_AND_IDENTITY_ADAPTER_REQUIRED',
    }),
    { flag: 'wx', mode: 0o600 },
  );
  return hostedProvider();
}
