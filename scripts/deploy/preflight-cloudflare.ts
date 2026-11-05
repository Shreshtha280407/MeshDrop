import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { CloudflareReadOnly, parseReadOnlyExpectation } from './cloudflare-readonly';
import type { ReadOnlyExpectation } from './cloudflare-readonly';
import { bindings, migrations } from './rollback-compatibility';
import { requireRelease, ReleaseError, sameContent } from './release-record';

/** Compare the operator's pins with actual local architecture, without loading private .env. */
export function verifyExpectedArchitecture(expected: ReadOnlyExpectation, configuration: unknown) {
  requireRelease(
    configuration && typeof configuration === 'object',
    'LOCAL_ARCHITECTURE_UNVERIFIED',
  );
  const config = configuration as {
    durable_objects?: { bindings?: unknown };
    migrations?: unknown;
  };
  const required = bindings(config.durable_objects?.bindings);
  const history = migrations(config.migrations);
  requireRelease(
    sameContent(
      required,
      Object.entries(expected.durableObjects)
        .map(([name, item]) => ({ name, class_name: item.className }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ) && history.at(-1)?.tag === expected.migrationTag,
    'EXPECTED_ARCHITECTURE_MISMATCH',
  );
}
export async function runReadOnlyPreflight(
  args: string[],
  token: string | undefined,
  root: string,
  create: (expected: ReadOnlyExpectation, credential: string) => CloudflareReadOnly = (
    expected,
    credential,
  ) => new CloudflareReadOnly(expected, credential),
) {
  try {
    const [flag, environment, path, ...extra] = args;
    requireRelease(
      flag === '--read-only' &&
        (environment === 'preview' || environment === 'production') &&
        path &&
        !extra.length,
      'EXPLICIT_READ_ONLY_SCOPE_REQUIRED',
    );
    // Missing credentials is a local diagnostic, never an OAuth or .env fallback.
    requireRelease(token, 'READ_ONLY_CREDENTIAL_REQUIRED');
    const file = await lstat(resolve(root, path));
    requireRelease(
      file.isFile() && !file.isSymbolicLink() && file.size <= 65536,
      'INVALID_EXPECTATION_FILE',
    );
    const expected = parseReadOnlyExpectation(
      JSON.parse(await readFile(resolve(root, path), 'utf8')),
    );
    requireRelease(expected.environment === environment, 'PREFLIGHT_ENVIRONMENT_MISMATCH');
    const source = await readFile(resolve(root, 'apps/signaling/wrangler.jsonc'), 'utf8');
    const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', source);
    requireRelease(!parsed.error, 'LOCAL_ARCHITECTURE_UNVERIFIED');
    verifyExpectedArchitecture(expected, parsed.config);
    const observation = await create(expected, token).observe();
    return {
      exitCode: observation.providerConfirmed ? 0 : 1,
      report: {
        status: observation.providerConfirmed ? 'VERIFIED_READBACK' : 'UNVERIFIED',
        observation,
      },
    };
  } catch (error) {
    return {
      exitCode: 1,
      report: {
        status: 'UNVERIFIED',
        code: error instanceof ReleaseError ? error.code : 'PREFLIGHT_INPUT_OR_READ_FAILED',
        providerConfirmed: false,
        releaseAccepted: false,
        productionApproved: false,
        publicationEnabled: false,
      },
    };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runReadOnlyPreflight(
    process.argv.slice(2),
    process.env.MESHDROP_CLOUDFLARE_READ_TOKEN,
    process.cwd(),
  );
  console.log(JSON.stringify(result.report));
  process.exitCode = result.exitCode;
}
