export type TodoHit = {
  path: string;
  line: number;
  kind: string;
  preview: string;
};

export function todoKindInLine(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("%")) {
    const upper = trimmed.toUpperCase();
    if (upper.includes("FIXME")) return "FIXME";
    if (upper.includes("XXX")) return "XXX";
    if (upper.includes("TODO")) return "TODO";
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("\\todo{") || lower.includes("\\todo[") || lower.includes("\\todo*{")) {
    return "todo";
  }
  return null;
}

export function todosInText(path: string, content: string): TodoHit[] {
  const hits: TodoHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const kind = todoKindInLine(line);
    if (!kind) continue;
    const trimmed = line.trim();
    const clipped = trimmed.slice(0, 160);
    hits.push({
      path: path.replace(/\\/g, "/"),
      line: index + 1,
      kind,
      preview: trimmed.length > 160 ? `${clipped}…` : clipped,
    });
  }
  return hits;
}

/** Replace disk hits for the dirty active file with an in-memory rescan. */
export function mergeTodosWithBuffer(
  diskHits: TodoHit[],
  activeFile: string | null | undefined,
  source: string | null | undefined,
): TodoHit[] {
  if (!activeFile || source == null) return diskHits;
  if (!/\.(tex|md)$/i.test(activeFile)) return diskHits;
  const others = diskHits.filter((hit) => hit.path !== activeFile);
  return [...others, ...todosInText(activeFile, source)].sort((left, right) => (
    left.path.localeCompare(right.path) || left.line - right.line
  ));
}
