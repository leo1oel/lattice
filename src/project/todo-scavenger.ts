export type TodoHit = {
  path: string;
  line: number;
  kind: string;
  preview: string;
};

const COMMENT_MARKERS = ["FIXME", "XXX", "TODO"];

/** A marker in a `%` comment (first match in priority order), else a `\todo` command. */
export function todoKindInLine(line: string): string | null {
  const trimmed = line.trimStart();
  const upper = trimmed.toUpperCase();
  const marker = trimmed.startsWith("%") && COMMENT_MARKERS.find((kind) => upper.includes(kind));
  if (marker) return marker;
  return /\\todo(?:[{[]|\*\{)/i.test(trimmed) ? "todo" : null;
}

export function todosInText(path: string, content: string): TodoHit[] {
  const hits: TodoHit[] = [];
  // The open file is rescanned on every keystroke. Every marker line contains
  // one of these words in some letter case, so a single search over the text
  // finds the few candidate lines instead of splitting and lowercasing every
  // line of the document.
  let line = 1;
  let counted = 0;
  let previousStart = -1;
  for (const match of content.matchAll(/todo|fixme|xxx/gi)) {
    const start = content.lastIndexOf("\n", match.index - 1) + 1;
    if (start === previousStart) continue;
    previousStart = start;
    for (let newline = content.indexOf("\n", counted); newline !== -1 && newline < start; newline = content.indexOf("\n", newline + 1)) {
      line += 1;
    }
    counted = start;
    const end = content.indexOf("\n", start);
    const text = content.slice(start, end === -1 ? content.length : end).replace(/\r$/, "");
    const kind = todoKindInLine(text);
    if (!kind) continue;
    const trimmed = text.trim();
    const clipped = trimmed.slice(0, 160);
    hits.push({
      path: path.replace(/\\/g, "/"),
      line,
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
