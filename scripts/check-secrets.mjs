import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const candidates = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);
const failures = [];
const secretFile = (path) =>
  (/^\.env(?:\..+)?$/.test(basename(path)) && basename(path) !== '.env.example') ||
  /^\.dev\.vars(?:\..+)?$/.test(basename(path));
for (const path of tracked)
  if (secretFile(path)) failures.push(`${path}: environment file is tracked`);
for (const path of new Set(candidates)) {
  if (secretFile(path)) {
    failures.push(`${path}: environment file is not ignored`);
    continue;
  }
  if (!statSync(path).isFile() || !/\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|md|txt|example)$/.test(path))
    continue;
  const text = readFileSync(path, 'utf8');
  if (
    /(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36,}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(
      text,
    )
  )
    failures.push(`${path}: possible embedded secret`);
  if (
    basename(path) === '.env.example' &&
    /^[ \t]*[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*[ \t]*=[ \t]*[^\s#]+/m.test(
      text,
    )
  )
    failures.push(`${path}: secret example must be empty`);
}
for (const path of [
  '.env',
  '.env.local',
  'apps/signaling/.env',
  'apps/signaling/.env.production',
  'apps/signaling/.dev.vars.staging',
  'apps/web/.env.production',
]) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', path]);
  } catch {
    failures.push(`${path}: missing ignore coverage`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    'Secret checks passed: environment files are ignored; no matching embedded credentials found.',
  );
