import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { bytesHash, canonical, requireRelease, ReleaseError } from '../deploy/release-record';
import { readAttestationInput, verifyAttestation } from '../deploy/github-attestation';
import type { AttestationPolicy } from '../deploy/github-attestation';
import {
  assertNoDeployCredentials,
  createArtifact,
  exact,
  HASH,
  parseArtifact,
  WORKFLOW,
} from './contract';
import type { RehearsalExpectation } from './contract';
import { inspectEnvironment, runtimeExpectation } from './preflight';
import { verifyRehearsal } from './verification';
import { createHostedJournal, inspectHistory } from './recovery';
import {
  checkConfiguration,
  requireConfiguration,
  faultDatabase,
  buildFaultTarget,
} from './configuration';
import { createHostedFaultHarness } from './faults';
import { FAULT_MODES, faultMode } from './fault-contract';
import type { FaultMode } from './fault-contract';
import { faultReport, inspectFaultReport } from './fault-report';
import type { FaultResult } from './fault-report';

const PUBLIC = 'rehearsal-evidence';
function required(key: string): string {
  const value = process.env[key];
  requireRelease(typeof value === 'string' && value.length > 0, 'MISSING_REHEARSAL_CONFIGURATION');
  return value;
}
async function output(values: Record<string, string>) {
  const path = required('GITHUB_OUTPUT');
  for (const [key, value] of Object.entries(values)) {
    requireRelease(
      /^[a-z0-9-]+$/.test(key) && /^[A-Za-z0-9_-]+$/.test(value),
      'UNSAFE_REHEARSAL_OUTPUT',
    );
    await appendFile(path, `${key}=${value}\n`);
  }
}
function policy(expected: RehearsalExpectation, artifactBytes: Uint8Array): AttestationPolicy {
  return {
    schemaVersion: 2,
    signerRef: expected.sourceRef,
    repository: 'Shreshtha280407/MeshDrop',
    repositoryId: expected.repositoryId,
    ownerId: expected.ownerId,
    signerWorkflow: `Shreshtha280407/MeshDrop/${WORKFLOW}`,
    signerCommit: expected.sourceCommit,
    sourceCommit: expected.sourceCommit,
    sourceRef: expected.sourceRef,
    sourceWorkflow: WORKFLOW,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    artifactSha256: bytesHash(Buffer.from(artifactBytes)),
    trustedRootSha256: required('REHEARSAL_ROOT_SHA256'),
    rootReviewedAt: required('REHEARSAL_ROOT_REVIEWED_AT'),
    rootValidUntil: required('REHEARSAL_ROOT_VALID_UNTIL'),
    ghPath: required('REHEARSAL_GH_PATH'),
    ghSha256: required('REHEARSAL_GH_SHA256'),
  };
}
async function verified(bundlePath: string) {
  const artifactBytes = await readAttestationInput(join(PUBLIC, 'rehearsal.json'));
  const artifact = parseArtifact(JSON.parse(artifactBytes.toString()));
  const expected = runtimeExpectation(process.env, required('REHEARSAL_UUID'));
  requireRelease(
    artifact.artifactId === required('REHEARSAL_ARTIFACT_ID') &&
      bytesHash(artifactBytes) === required('REHEARSAL_ARTIFACT_SHA256'),
    'REHEARSAL_DOWNLOAD_SUBSTITUTED',
  );
  const bundle = await readAttestationInput(bundlePath);
  // Only the documented DSSE bundle is exportable, never arbitrary JSON files.
  exact(JSON.parse(bundle.toString()), 'mediaType,verificationMaterial,dsseEnvelope');
  const rootsText = required('REHEARSAL_ROOTS_BASE64');
  requireRelease(
    rootsText.length <= 1400000 && /^[A-Za-z0-9+/=]+$/.test(rootsText),
    'INVALID_REHEARSAL_ROOT_ENCODING',
  );
  const roots = Buffer.from(rootsText, 'base64');
  const verification = await verifyRehearsal(
    artifactBytes,
    bundle,
    roots,
    policy(expected, artifactBytes),
    expected,
  );
  return { artifact, verification, bundle };
}
function escapePass(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}
async function store() {
  const readiness = checkConfiguration(process.env, 'normal');
  if (readiness.status !== 'READY_FOR_HOSTED_REHEARSAL') console.log(canonical(readiness).trim());
  requireConfiguration(process.env, 'normal');
  const { artifact, verification } = await verified(join(PUBLIC, 'bundle.json'));
  const db = exact(
    JSON.parse(required('REHEARSAL_DB_CONFIGURATION')),
    'environment,host,port,database,user,caPem,caSha256,storeId,psqlPath,psqlSha256',
  );
  requireRelease(
    db.environment === artifact.environment &&
      ['host', 'database', 'user', 'caPem', 'caSha256', 'storeId', 'psqlPath', 'psqlSha256'].every(
        (k) => typeof db[k] === 'string',
      ) &&
      Number.isSafeInteger(db.port),
    'INVALID_REHEARSAL_DATABASE_CONFIGURATION',
  );
  const host = db.host as string,
    port = String(db.port),
    database = db.database as string,
    user = db.user as string;
  requireRelease(
    /^[A-Za-z0-9.-]+$/.test(host) &&
      /^[1-9][0-9]{0,4}$/.test(port) &&
      Number(port) <= 65535 &&
      /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(database) &&
      /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(user),
    'INVALID_REHEARSAL_DATABASE_CONFIGURATION',
  );
  const password = required('REHEARSAL_DB_PASSWORD'),
    ca = db.caPem as string;
  requireRelease(
    password.length <= 4096 &&
      !/[\r\n\0]/.test(password) &&
      ca.length <= 65536 &&
      bytesHash(ca) === db.caSha256,
    'INVALID_REHEARSAL_CREDENTIAL_MATERIAL',
  );
  const temporary = await realpath(required('RUNNER_TEMP')),
    workspace = await realpath(process.cwd());
  const relation = relative(workspace, temporary);
  requireRelease(
    isAbsolute(temporary) && (relation.startsWith('..') || isAbsolute(relation)),
    'REHEARSAL_PRIVATE_DIRECTORY_REQUIRED',
  );
  const directory = await mkdtemp(join(temporary, 'meshdrop-rehearsal-private-'));
  const completed = await (async () => {
    try {
      const caFile = join(directory, 'ca.pem'),
        passwordFile = join(directory, 'pgpass');
      await writeFile(caFile, ca, { mode: 0o600, flag: 'wx' });
      await writeFile(
        passwordFile,
        `${host}:${port}:${database}:${user}:${escapePass(password)}\n`,
        {
          mode: 0o600,
          flag: 'wx',
        },
      );
      const journal = await createHostedJournal(artifact, verification, {
        executable: db.psqlPath,
        host,
        port: Number(port),
        database,
        user,
        caFile,
        passwordFile,
        storeId: db.storeId,
        environment: artifact.environment,
        attemptId: artifact.rehearsalId,
        caSha256: db.caSha256,
        psqlSha256: db.psqlSha256,
      });
      return await journal.run();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  const { events, ...summary } = completed;
  await writeFile(join(PUBLIC, 'events.json'), canonical(events), { mode: 0o600, flag: 'wx' });
  await writeFile(join(PUBLIC, 'head.json'), canonical(summary.head), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(PUBLIC, 'summary.json'),
    canonical({
      ...summary,
      artifactSha256: verification.artifactSha256,
      signatureVerified: true,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  console.log(
    canonical({
      ...summary,
      artifactSha256: verification.artifactSha256,
      signatureVerified: true,
    }).trim(),
  );
}
async function runFaults(selected: string) {
  const readiness = checkConfiguration(process.env, 'faults');
  if (readiness.status !== 'READY_FOR_HOSTED_REHEARSAL') console.log(canonical(readiness).trim());
  requireConfiguration(process.env, 'faults');
  const modes = selected === 'all' ? [...FAULT_MODES] : [faultMode(selected)];
  const { artifact, verification } = await verified(join(PUBLIC, 'bundle.json'));
  const db = faultDatabase(process.env);
  const temporary = await realpath(required('RUNNER_TEMP')),
    workspace = await realpath(process.cwd());
  requireRelease(
    relative(workspace, temporary).startsWith('..'),
    'REHEARSAL_PRIVATE_DIRECTORY_REQUIRED',
  );
  const directory = await mkdtemp(join(temporary, 'meshdrop-fault-private-'));
  const results: FaultResult[] = [];
  let failedMode: FaultMode | null = null,
    failure: string | null = null;
  try {
    const paths = {
      caFile: join(directory, 'ca.pem'),
      passwordFile: join(directory, 'writer'),
      readerPasswordFile: join(directory, 'reader'),
    };
    await writeFile(paths.caFile, db.caPem as string, { mode: 0o600, flag: 'wx' });
    for (const [key, user, path] of [
      ['REHEARSAL_FAULT_DB_PASSWORD', db.user as string, paths.passwordFile],
      ['REHEARSAL_FAULT_DB_READER_PASSWORD', db.readerUser as string, paths.readerPasswordFile],
    ] as const) {
      const password = required(key!);
      requireRelease(
        password.length <= 4096 && !/[\r\n\0]/.test(password),
        'INVALID_REHEARSAL_CREDENTIAL_MATERIAL',
      );
      await writeFile(
        path!,
        `${db.host}:${db.port}:${db.database}:${user}:${escapePass(password)}\n`,
        { mode: 0o600, flag: 'wx' },
      );
    }
    const harness = await createHostedFaultHarness(
      artifact,
      verification,
      buildFaultTarget(process.env, artifact, paths),
    );
    for (const mode of modes) {
      try {
        results.push(await harness.run(mode));
      } catch (error) {
        failedMode = mode;
        failure = error instanceof ReleaseError ? error.code : 'FAULT_FAILED_RECONCILE';
        break;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const report = faultReport(artifact, db.storeId as string, results, failedMode, failure);
  await writeFile(join(PUBLIC, 'fault-results.json'), canonical(report), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(PUBLIC, 'fault-heads.json'),
    canonical(results.map((r) => ({ mode: r.mode, storeId: r.storeId, head: r.head }))),
    { mode: 0o600, flag: 'wx' },
  );
  const summary = {
    ...inspectFaultReport(artifact, report),
    status: failure ? 'FAIL' : 'PASS',
    artifactId: artifact.artifactId,
    rehearsalId: artifact.rehearsalId,
    storeId: db.storeId,
    failure,
  };
  await writeFile(join(PUBLIC, 'fault-summary.json'), canonical(summary), {
    mode: 0o600,
    flag: 'wx',
  });
  await output(
    Object.fromEntries(
      Object.entries(report.checks).map(([key, value]) => [
        key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()),
        value,
      ]),
    ),
  );
  console.log(canonical(summary).trim());
  if (failure) process.exitCode = 1;
}
async function verifyFaultFile(bundlePath?: string, offline?: { files: Buffer[] }) {
  let artifact,
    reportBytes: Buffer,
    rootBytes: Buffer,
    expected: RehearsalExpectation,
    pins: AttestationPolicy;
  if (offline) {
    const [a, b, r, p, e, f] = offline.files;
    expected = JSON.parse(e!.toString());
    pins = JSON.parse(p!.toString());
    rootBytes = r!;
    reportBytes = f!;
    await verifyRehearsal(a!, b!, rootBytes, pins, expected);
    artifact = parseArtifact(JSON.parse(a!.toString()));
  } else {
    ({ artifact } = await verified(join(PUBLIC, 'bundle.json')));
    reportBytes = await readAttestationInput(join(PUBLIC, 'fault-results.json'));
    rootBytes = Buffer.from(required('REHEARSAL_ROOTS_BASE64'), 'base64');
    expected = runtimeExpectation(process.env, required('REHEARSAL_UUID'));
    pins = policy(expected, reportBytes);
  }
  const report = JSON.parse(reportBytes.toString()),
    checked = inspectFaultReport(artifact, report);
  requireRelease(Buffer.from(canonical(report)).equals(reportBytes), 'NONCANONICAL_FAULT_REPORT');
  requireRelease(
    checked.complete && report.results.every((r: FaultResult) => r.scope === 'github-rehearsal'),
    'INCOMPLETE_OR_FIXTURE_FAULT_REPORT',
  );
  if (bundlePath) {
    const bundle = await readAttestationInput(bundlePath);
    await verifyAttestation(reportBytes, bundle, rootBytes, {
      ...pins,
      artifactSha256: bytesHash(reportBytes),
    });
    if (!offline)
      await writeFile(join(PUBLIC, 'fault-bundle.json'), bundle, { mode: 0o600, flag: 'wx' });
    console.log(
      canonical({
        ...checked,
        status: 'SIGNATURE_VERIFIED — RELEASE AUTHORIZATION NOT ESTABLISHED',
        signatureVerified: true,
        authorizationVerified: false,
      }).trim(),
    );
  } else
    console.log(
      canonical({
        ...checked,
        status: 'INTEGRITY_ONLY — AWAITING_FAULT_ATTESTATION',
        signatureVerified: false,
      }).trim(),
    );
}
const [command, ...args] = process.argv.slice(2);
try {
  assertNoDeployCredentials(process.env);
  if (command === 'check-config' && !args.length) {
    const report = checkConfiguration(process.env);
    console.log(canonical(report).trim());
    if (report.status !== 'READY_FOR_HOSTED_REHEARSAL') process.exitCode = 1;
  } else if (command === 'fault-test' && args.length === 1) {
    await runFaults(args[0]!);
  } else if (command === 'inspect-fault-results' && !args.length) {
    await verifyFaultFile();
  } else if (command === 'verify-produced-faults' && args.length === 1) {
    await verifyFaultFile(args[0]!);
  } else if (command === 'verify-faults' && args.length === 7) {
    const files = await Promise.all(args.slice(0, 6).map(readAttestationInput));
    await verifyFaultFile(args[6]!, { files });
  } else if (command === 'preflight' && !args.length) {
    const checked = await inspectEnvironment(process.env);
    await output({ 'environment-name': checked.environmentName });
    console.log(canonical(checked).trim());
  } else if (command === 'prepare' && !args.length) {
    const rehearsalId = randomUUID(),
      expected = runtimeExpectation(process.env, rehearsalId);
    const digest = process.env.REHEARSAL_PREPARED_MANIFEST_SHA256 || null;
    requireRelease(digest === null || HASH.test(digest), 'INVALID_PREPARED_MANIFEST_DIGEST');
    const artifact = createArtifact(
      {
        repositoryId: expected.repositoryId,
        ownerId: expected.ownerId,
        environment: expected.environment,
        sourceCommit: expected.sourceCommit,
        sourceRef: expected.sourceRef,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        preparedManifestSha256: digest,
      },
      new Date().toISOString(),
      rehearsalId,
    );
    await mkdir(PUBLIC, { mode: 0o700 });
    await writeFile(join(PUBLIC, 'rehearsal.json'), canonical(artifact), {
      mode: 0o600,
      flag: 'wx',
    });
    await output({
      'rehearsal-id': rehearsalId,
      'artifact-id': artifact.artifactId,
      'artifact-sha256': bytesHash(canonical(artifact)),
    });
  } else if (command === 'verify-produced' && args.length === 1) {
    const { verification, bundle } = await verified(args[0]!);
    await writeFile(join(PUBLIC, 'bundle.json'), bundle, { mode: 0o600, flag: 'wx' });
    console.log(
      canonical({
        status: 'SIGNATURE_VERIFIED — RELEASE AUTHORIZATION NOT ESTABLISHED',
        ...verification,
      }).trim(),
    );
  } else if (command === 'store' && !args.length) {
    await store();
  } else if (command === 'verify-files' && args.length === 5) {
    const files = await Promise.all(args.map((path) => readAttestationInput(path)));
    const result = await verifyRehearsal(
      files[0]!,
      files[1]!,
      files[2]!,
      JSON.parse(files[3]!.toString()),
      JSON.parse(files[4]!.toString()),
    );
    console.log(
      canonical({
        status: 'SIGNATURE_VERIFIED — RELEASE AUTHORIZATION NOT ESTABLISHED',
        ...result,
      }).trim(),
    );
  } else if (command === 'history' && args.length === 3) {
    const files = await Promise.all(args.map((path) => readAttestationInput(path)));
    const a = parseArtifact(JSON.parse(files[0]!.toString()));
    const result = inspectHistory(
      a,
      JSON.parse(files[1]!.toString()),
      JSON.parse(files[2]!.toString()),
    );
    console.log(
      canonical({
        status: 'INTEGRITY_ONLY — INDEPENDENT WITNESS NOT ESTABLISHED',
        integrityVerified: result.integrityVerified,
        complete: result.complete,
        independentWitnessVerified: false,
        authorizationVerified: false,
        publicationEnabled: false,
        acceptanceEnabled: false,
        productionApproved: false,
      }).trim(),
    );
    process.exitCode = 1;
  } else throw new ReleaseError('REHEARSAL_COMMAND_NOT_ALLOWED');
} catch (error) {
  console.log(
    canonical({
      status: 'REHEARSAL_INCOMPLETE — RELEASE AUTHORIZATION NOT ESTABLISHED',
      reason: error instanceof ReleaseError ? error.code : 'REHEARSAL_FAILED_RECONCILE',
      publicationEnabled: false,
      acceptanceEnabled: false,
      productionApproved: false,
    }).trim(),
  );
  process.exitCode = 1;
}
