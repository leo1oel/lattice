/** Locate the first `\appendix` switch in project sources (line is 1-based). */
export function findAppendixMarker(
  sources: Record<string, string>,
): { path: string; line: number } | null {
  for (const [path, source] of Object.entries(sources)) {
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const code = (lines[index] ?? "").split("%")[0] ?? "";
      if (/(^|[^\\])\\appendix\b/.test(` ${code}`)) {
        return { path, line: index + 1 };
      }
    }
  }
  return null;
}
