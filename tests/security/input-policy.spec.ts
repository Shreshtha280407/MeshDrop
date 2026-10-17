import { expect, it } from 'vitest';
import { distinctFilePaths, manifestSchema, safeRelativePath } from '@meshdrop/protocol';
import { exportNames } from '../../apps/web/src/security/safeFilePath';
import { namedExportFile } from '../../packages/storage/src/IosExportAdapter';
import { browserHeaders } from '../../apps/web/security-headers';

it.each([
  '../a',
  '/root',
  'a/../b',
  'C:/a',
  'a\\b',
  'a//b',
  'a/.',
  'CON',
  'CON .txt',
  'COM¹.txt',
  'LPT²',
  'ＮＵＬ.txt',
  'a/．．/b',
  'a／b',
  'a\u202etxt',
  'a\u200ftxt',
  'a\u061ctxt',
  'a\u200b.txt',
  'a\u0000',
  'a\ud800',
  'a.',
  ' a',
  'a:stream',
])('rejects unsafe portable path %j', (path) => {
  expect(safeRelativePath(path)).toBe(false);
});
it.each(['photo/猫😀.png', 'Résumé.txt', 'CONSOLE.txt', 'component10.txt', 'a.b/c.txt'])(
  'accepts a portable NFC label %j',
  (path) => {
    expect(safeRelativePath(path)).toBe(true);
  },
);
it('rejects portable Unicode collisions and file/directory conflicts', () => {
  for (const paths of [
    ['a.txt', 'Ａ.txt'],
    ['Straße', 'STRASSE'],
    ['folder', 'FOLDER/a'],
    ['same', 'SAME'],
  ])
    expect(distinctFilePaths(paths)).toBe(false);
  expect(distinctFilePaths(['one/a.txt', 'two/a.txt'])).toBe(true);
  const files = ['one/a.txt', 'two/A.txt', 'a (2).txt', 'three/a.txt'].map((path, i) => ({
    fileId: String(i),
    path,
  }));
  expect([...exportNames(files).values()]).toEqual([
    'a.txt',
    'A (3).txt',
    'a (2).txt',
    'a (4).txt',
  ]);
});
it('keeps long generated export names bounded, stable and safe', () => {
  for (const path of ['猫'.repeat(78) + '.txt', 'a.' + 'b'.repeat(238)]) {
    const files = [
      { fileId: '1', path: `x/${path.slice(0, -2)}` },
      { fileId: '2', path: `y/${path.slice(0, -2)}` },
    ];
    const names = [...exportNames(files).values()];
    expect(new Set(names).size).toBe(2);
    expect(names.every(safeRelativePath)).toBe(true);
    expect([...exportNames(files).values()]).toEqual(names);
  }
});
it('ignores source MIME claims and never gives HTML or SVG an active preview type', () => {
  const file = new File(['<script>throw 1</script>'], 'opaque', { type: 'text/html' });
  expect(namedExportFile(file, 'notes.txt').type).toBe('text/plain');
  for (const path of [
    'page.html',
    'image.svg',
    'unknown.bin',
    'file.constructor',
    'file.__proto__',
  ])
    expect(namedExportFile(file, path).type).toBe('application/octet-stream');
});
it('rejects MIME/metadata extensions instead of trusting a peer hint', () => {
  const file = { fileId: crypto.randomUUID(), path: 'notes.txt', size: 0, sha256: '0'.repeat(64) };
  const manifest = {
    version: 1,
    transferId: crypto.randomUUID(),
    revision: 1,
    blockBytes: 1024 ** 2,
    files: [file],
    totalBytes: 0,
  };
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(manifestSchema.safeParse({ ...manifest, mime: 'image/png' }).success).toBe(false);
  expect(
    manifestSchema.safeParse({ ...manifest, files: [{ ...file, mime: 'text/html' }] }).success,
  ).toBe(false);
});
it('production headers deny inline scripts, embedding and referrer disclosure', () => {
  const headers = browserHeaders();
  expect(headers['Content-Security-Policy']).not.toContain('unsafe-');
  expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  expect(headers['Referrer-Policy']).toBe('no-referrer');
});
