/** Conservative portable comparison; labels remain NFC and are never filesystem storage keys. */
export function portablePathKey(value: string): string {
  return value.normalize('NFKC').toUpperCase();
}
export function safeRelativePath(value: string): boolean {
  if (
    !value ||
    value !== value.normalize('NFC') ||
    new TextEncoder().encode(value).length > 240 ||
    /[\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff\uD800-\uDFFF:<>"|?*]/u.test(
      value,
    ) ||
    Array.from(value).some((char) => {
      const point = char.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159);
    })
  )
    return false;
  const parts = value.split('/');
  return (
    parts.length <= 8 &&
    parts.every((part) => {
      const portable = portablePathKey(part);
      const stem = portable.split('.')[0]!.trimEnd();
      return (
        part.length > 0 &&
        part === part.trim() &&
        portable !== '.' &&
        portable !== '..' &&
        !/[\\/:<>"|?*]/.test(portable) &&
        !/[. ]$/.test(portable) &&
        !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
      );
    })
  );
}
/** Also reject file/directory ancestor conflicts after portable Unicode/case comparison. */
export function distinctFilePaths(paths: readonly string[]): boolean {
  const keys = paths.map(portablePathKey),
    all = new Set(keys);
  return (
    all.size === keys.length &&
    keys.every((key) => {
      const parts = key.split('/');
      for (let count = 1; count < parts.length; count++)
        if (all.has(parts.slice(0, count).join('/'))) return false;
      return true;
    })
  );
}
