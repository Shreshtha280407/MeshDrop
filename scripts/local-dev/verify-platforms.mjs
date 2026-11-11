// Opt-in Free device tests of an isolated build, never the deployed application.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const cases = {
  'iphone-normal': ['iphone', 8, false, false],
  'iphone-recovery': ['iphone', 8, true, false],
  'iphone-reverse': ['iphone', 2, false, true],
  'ipad-recovery': ['ipad', 2, true, false],
  'ipad-reverse': ['ipad', 2, false, true],
  'windows-normal': ['windows-chrome', 2, false, false],
  'windows-recovery': ['windows-chrome', 2, true, false],
  'windows-reverse': ['windows-chrome', 2, false, true],
  'windows-sender-engine': ['windows-chrome', 2, false, true],
  'macos-normal': ['macos-safari', 2, false, false],
  'macos-recovery': ['macos-safari', 2, true, false],
  'macos-reverse': ['macos-safari', 2, false, true],
};
const selected = process.argv.slice(2);
if (!selected.length || selected.some((name) => !Object.hasOwn(cases, name)))
  throw Error(`Choose explicit cases: ${Object.keys(cases).join(', ')}`);
if (
  !process.env.MESHDROP_DEVICE_TEST_IDENTITY ||
  !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(process.env.MESHDROP_TEST_URL ?? '')
)
  throw Error('Explicit disposable HTTPS origin and current-build identity file required.');
const directory = resolve('.meshdrop-artifacts/device-cloud/task13', randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const results = [];
// Two sessions at most, independent device rooms and browser profiles. Each child rechecks Free.
async function run(name) {
  const [profile, size, recovery, reverse] = cases[name];
  const path = resolve(directory, `${name}.log`),
    stream = createWriteStream(path, { mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/local-dev/verify-ios.mjs'], {
    env: {
      ...process.env,
      MESHDROP_CLOUD_PROFILE: profile,
      MESHDROP_CLOUD_FIXTURE_MIB: String(size),
      MESHDROP_IOS_RECOVERY: String(recovery),
      MESHDROP_IOS_DIRECTION: reverse ? 'iphone-to-laptop' : 'laptop-to-iphone',
      MESHDROP_CLOUD_PEER: name === 'windows-sender-engine' ? 'cloud' : 'laptop',
      MESHDROP_CLOUD_SENDER_ENGINE: String(name === 'windows-sender-engine'),
      MESHDROP_CLOUD_RELAY_ONLY: 'false',
      MESHDROP_IOS_OS_INTERRUPTION: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const exit = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await new Promise((resolve) => stream.end(resolve));
  let evidence;
  try {
    evidence = JSON.parse((await readFile(path, 'utf8')).trim().split('\n').at(-1));
  } catch {
    evidence = {
      pass: false,
      error: 'PROVIDER_PREFLIGHT_OR_RUNNER_UNAVAILABLE',
      transferVerified: false,
      nativeExportVerified: false,
    };
  }
  results.push({ case: name, exit, ...evidence });
  console.log(
    JSON.stringify({
      case: name,
      pass: evidence.pass,
      transferVerified: evidence.transferVerified ?? false,
      nativeExportVerified: evidence.nativeExportVerified,
      error: evidence.error,
    }),
  );
}
for (let i = 0; i < selected.length; i += 2) await Promise.all(selected.slice(i, i + 2).map(run));
await writeFile(
  resolve(directory, 'summary.json'),
  JSON.stringify(
    { scope: 'Free cloud devices against disposable current build; no production access', results },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(`Sanitized case evidence: ${resolve(directory, 'summary.json')}`);
process.exitCode = results.every((result) => result.pass) ? 0 : 1;
