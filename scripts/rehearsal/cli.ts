import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { bytesHash, canonical, requireRelease, ReleaseError } from '../deploy/release-record';
import { readAttestationInput } from '../deploy/github-attestation';
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
const [command, ...args] = process.argv.slice(2);
try {
  assertNoDeployCredentials(process.env);
  if (command === 'preflight' && !args.length) {
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
