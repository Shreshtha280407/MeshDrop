import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sizes = process.env.MESHDROP_BENCH_BYTES?.split(',').map(Number) ?? [
  100 * 1024 ** 2,
  1024 ** 3,
  2 * 1024 ** 3,
];
if (
  sizes.some((size) => !Number.isSafeInteger(size) || size < 8 * 1024 ** 2 || size > 2 * 1024 ** 3)
)
  throw new Error('Use whole byte counts from 8 MiB through 2 GiB.');
const reports = [];
const directory = resolve('.meshdrop-artifacts/phase-9-benchmarks');
await mkdir(directory, { recursive: true });
for (const size of sizes) {
  for (const scenario of ['normal', 'disconnect']) {
    const startedAt = Date.now();
    const code = await new Promise((accept, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/local-dev/verify-streaming.mjs'],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            MESHDROP_BENCH_PHASE: 'P9',
            MESHDROP_BENCH_SCENARIO: scenario,
            MESHDROP_BENCH_BYTES: String(size),
          },
        },
      );
      child.once('error', reject);
      child.once('exit', accept);
    });
    let report;
    try {
      report = JSON.parse(await readFile(resolve(directory, 'latest.json'), 'utf8'));
    } catch {
      report = null;
    }
    if (
      !report ||
      Date.parse(report.startedAt) < startedAt ||
      report.requestedBytes?.[0] !== size ||
      report.scenario !== (scenario === 'disconnect' ? 'controlled-disconnect' : 'normal')
    )
      report = {
        phase: 'P9',
        pass: false,
        bytes: size,
        scenario,
        error: 'Child did not produce matching evidence.',
      };
    reports.push(report);
    await writeFile(
      resolve(directory, 'matrix.json'),
      JSON.stringify(
        {
          phase: 'P9',
          pass: reports.length === sizes.length * 2 && reports.every((report) => report.pass),
          fullSizeMatrix:
            sizes.includes(100 * 1024 ** 2) &&
            sizes.includes(1024 ** 3) &&
            sizes.includes(2 * 1024 ** 3) &&
            reports.length === sizes.length * 2 &&
            reports.every((report) => report.pass),
          physicalDeviceCoverage: false,
          reports,
        },
        null,
        2,
      ),
    );
    if (code !== 0 || !report.pass) process.exit(1);
  }
}
