import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyPreparedArtifacts } from '../deploy/release-preparation';
import { canonical, initialRecord, parseManifest, requireRelease } from '../deploy/release-record';
import type { Manifest } from '../deploy/release-record';

/** Exact whitelist shared by private Wrangler copies and exported archives. */
export function packageFiles(manifest: Manifest) {
  parseManifest(manifest);
  return [
    'manifest.json',
    'worker.json',
    'wrangler.json',
    'release.json',
    ...Object.keys(manifest.files).map((n) => 'web/' + n),
    ...Object.keys(manifest.workerFiles).map((n) => 'worker/' + n),
  ];
}
export async function verifyPackage(directory: string, manifest: Manifest) {
  for (const path of packageFiles(manifest)) {
    const s = await lstat(join(directory, path));
    requireRelease(s.isFile() && !s.isSymbolicLink(), 'PREVIEW_NONREGULAR_PACKAGE_FILE');
  }
  await verifyPreparedArtifacts(directory, manifest);
  requireRelease(
    canonical(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))) ===
      canonical(initialRecord(manifest)),
    'PREVIEW_PACKAGE_STATE_CHANGED',
  );
}
export async function copyPackage(source: string, destination: string, manifest: Manifest) {
  await verifyPackage(source, manifest);
  for (const path of packageFiles(manifest)) {
    const to = join(destination, path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(join(source, path), to);
  }
  await verifyPackage(destination, manifest);
}
