import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

// Read-only repository checks, not a general Markdown parser or external-link crawler.
// Covers this repository's inline/reference links, HTML media and heading anchors.
const root = realpathSync(resolve(process.argv[2] ?? '.'));
const names = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const documents = names.filter((name) => /\.md$/i.test(name) && existsSync(resolve(root, name)));
const publicFiles = new Set(names);
const scripts = new Set(
  Object.keys(JSON.parse(readFileSync(resolve(root, 'package.json'))).scripts),
);
const builtins = new Set([
  'add',
  'audit',
  'dlx',
  'exec',
  'fetch',
  'install',
  'list',
  'outdated',
  'remove',
  'store',
  'update',
  'why',
]);
const failures = [];
let links = 0;
let anchors = 0;
let commands = 0;
const cache = new Map();
function headings(path) {
  if (cache.has(path)) return cache.get(path);
  const text = readFileSync(path, 'utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  const result = new Set();
  const duplicates = new Map();
  for (const match of text.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*$/gm)) {
    const slug = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
      .replaceAll(' ', '-');
    const count = duplicates.get(slug) ?? 0;
    duplicates.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  cache.set(path, result);
  return result;
}
for (const name of documents.sort()) {
  const source = readFileSync(resolve(root, name), 'utf8');
  const code = [];
  const prose = source.replace(
    /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[^\n]*$/gm,
    (all, _fence, body) => {
      code.push(body);
      return all.replace(/[^\n]/g, ' ');
    },
  );
  const lineAt = (index) => prose.slice(0, index).split('\n').length;
  const label = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const definitions = new Map();
  const targets = [];
  for (const match of prose.matchAll(/^ {0,3}\[([^\]^]+)\]:[ \t]*(<[^>]+>|\S+)/gm)) {
    definitions.set(label(match[1]), match[2]);
    targets.push({ url: match[2], line: lineAt(match.index) });
  }
  for (const match of prose.matchAll(
    /!?\[[^\]\n]*\]\([ \t]*(<[^>]+>|[^\s)]*)(?:[ \t]+["'][^\n]*["'])?[ \t]*\)/g,
  ))
    targets.push({ url: match[1], line: lineAt(match.index) });
  for (const match of prose.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const url = definitions.get(label(match[2] || match[1]));
    if (!url)
      failures.push({ file: name, line: lineAt(match.index), code: 'UNDEFINED_LINK_REFERENCE' });
  }
  for (const match of prose.matchAll(/\b(?:href|src|poster)=["']([^"']+)["']/g))
    targets.push({ url: match[1], line: lineAt(match.index) });
  for (const match of prose.matchAll(/\bsrcset=["']([^"']+)["']/g))
    for (const item of match[1].split(','))
      targets.push({ url: item.trim().split(/\s+/)[0], line: lineAt(match.index) });
  for (const { url, line } of targets) {
    const value = url.replace(/^<|>$/g, '').replaceAll('&amp;', '&');
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
    links++;
    let path, fragment;
    try {
      const hash = value.indexOf('#');
      path = decodeURIComponent((hash < 0 ? value : value.slice(0, hash)).split('?')[0]);
      fragment = hash < 0 ? '' : decodeURIComponent(value.slice(hash + 1));
    } catch {
      failures.push({ file: name, line, code: 'INVALID_LINK_ENCODING' });
      continue;
    }
    const target = path ? resolve(dirname(resolve(root, name)), path) : resolve(root, name);
    const inside = (p) => p === root || p.startsWith(root + sep);
    if (!inside(target) || !existsSync(target) || !inside(realpathSync(target))) {
      failures.push({
        file: name,
        line,
        code: 'MISSING_OR_EXTERNAL_FILE',
        target: relative(root, target),
      });
      continue;
    }
    const targetName = relative(root, target).split(sep).join('/');
    const isDirectory = statSync(target).isDirectory();
    const isPublic = isDirectory
      ? names.some((name) => !targetName || name.startsWith(targetName + '/'))
      : publicFiles.has(targetName);
    if (!isPublic) {
      failures.push({ file: name, line, code: 'NON_PUBLIC_TARGET', target: targetName });
      continue;
    }
    if (fragment && /\.md$/i.test(target) && statSync(target).isFile()) {
      anchors++;
      if (!headings(target).has(fragment))
        failures.push({
          file: name,
          line,
          code: 'MISSING_HEADING',
          target: relative(root, target),
          anchor: fragment,
        });
    }
  }
  // Validate commands in code spans/blocks, not prose mentioning pnpm. Workspace
  // filter/recursive CLI options are reviewed separately; no command is executed.
  for (const match of prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) code.push(match[1]);
  for (const sample of code)
    for (const match of sample.matchAll(/\bpnpm[ \t]+(?:run[ \t]+)?([a-z][\w:-]*)/g)) {
      const command = match[1];
      commands++;
      if (!scripts.has(command) && !builtins.has(command))
        failures.push({ file: name, code: 'UNKNOWN_PNPM_COMMAND', command });
    }
}
console.log(
  JSON.stringify(
    {
      status: failures.length ? 'FAIL' : 'PASS',
      documents: documents.length,
      internalLinks: links,
      headingLinks: anchors,
      documentedCommands: commands,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
