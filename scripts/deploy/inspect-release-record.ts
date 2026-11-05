import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, parseRecord } from './release-record';

try {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error();
  const manifest = parseManifest(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
  );
  const record = parseRecord(
    JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')),
    manifest,
  );
  console.log(
    JSON.stringify({
      manifestId: manifest.id,
      state: record.state,
      scope: record.scope,
      providerConfirmationClaimed: record.provider.confirmed,
      acceptanceRecorded: record.acceptance !== null,
      recordIntegrityOnly: true,
      providerProvenanceVerified: false,
      productionApproved: false,
    }),
  );
  // Inspection validates structure/integrity only, and never approves a release.
} catch {
  console.error('INVALID_OR_INCOMPLETE_RELEASE_RECORD');
  process.exitCode = 1;
}
