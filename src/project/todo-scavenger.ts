export type TodoHit = {
  path: string;
  line: number;
  kind: string;
  preview: string;
};

// eslint-disable-next-line lingui/no-unlocalized-strings -- markers matched in LaTeX comments, not interface copy
const COMMENT_MARKERS = ["FIXME", "XXX", "TODO"];
/** A marker as a word of its own: "% Mastodon dataset" is not a TODO. */
const MARKER_WORDS = COMMENT_MARKERS.map((kind) => [kind, new RegExp(`(?<![a-z0-9])${kind}s?(?![a-z0-9])`, "i")] as const);

/**
 * The `%` comment on a line, including one after text ("Results. % TODO
 * cite"); a `\%` is a percent sign, not a comment (but `\\%` is a line
 * break, then one). Kept in step with `comment_in_line` in project/search.rs.
 */
function commentInLine(line: string): string | null {
  let backslashes = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "%" && backslashes % 2 === 0) return line.slice(index + 1);
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  return null;
}

/**
 * A marker in a `%` comment (first match in priority order), else a `\todo`
 * command. Outside LaTeX a `%` is text ("50% done"), so only a line that
 * starts with one counts there.
 */
export function todoKindInLine(line: string, latex = true): string | null {
  const trimmed = line.trimStart();
  const comment = latex ? commentInLine(trimmed) : trimmed.startsWith("%") ? trimmed.slice(1) : null;
  const marker = comment !== null && MARKER_WORDS.find(([, word]) => word.test(comment));
  if (marker) return marker[0];
  return /\\todo(?:[{[]|\*\{)/i.test(trimmed) ? "todo" : null;
}

export function todosInText(path: string, content: string): TodoHit[] {
  const hits: TodoHit[] = [];
  const latex = /\.tex$/i.test(path);
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
    const kind = todoKindInLine(text, latex);
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
