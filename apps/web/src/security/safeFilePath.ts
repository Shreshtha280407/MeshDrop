import { portablePathKey, relativePathSchema } from '@meshdrop/protocol';

/** Flat exports receive distinct names even when the labels contain directories. */
export function exportNames(
  files: readonly { fileId: string; path: string }[],
): Map<string, string> {
  const originals = files.map((file) => relativePathSchema.parse(file.path).split('/').at(-1)!);
  const reserved = new Set(originals.map(portablePathKey));
  const used = new Set<string>();
  return new Map(
    files.map((file, index) => {
      const original = originals[index]!;
      let name = original;
      for (
        let count = 2;
        used.has(portablePathKey(name)) ||
        (name !== original && reserved.has(portablePathKey(name)));
        count++
      ) {
        const dot = original.lastIndexOf('.');
        const extension =
          dot > 0 && new TextEncoder().encode(original.slice(dot)).length <= 32
            ? original.slice(dot)
            : '';
        const suffix = ` (${count})${extension}`;
        const stem = Array.from(extension ? original.slice(0, dot) : original);
        while (new TextEncoder().encode(stem.join('') + suffix).length > 240) stem.pop();
        name = stem.join('') + suffix;
      }
      // A generated name cannot steal an original name from a later file.
      used.add(portablePathKey(name));
      return [file.fileId, relativePathSchema.parse(name)];
    }),
  );
}
