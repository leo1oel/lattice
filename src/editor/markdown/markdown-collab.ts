export type TextPatch = {
  from: number;
  to: number;
  insert: string;
};

export function minimalMarkdownPatch(base: string, draft: string): TextPatch {
  let from = 0;
  while (from < base.length && from < draft.length && base[from] === draft[from]) from += 1;
  let suffix = 0;
  while (
    suffix < base.length - from
    && suffix < draft.length - from
    && base[base.length - suffix - 1] === draft[draft.length - suffix - 1]
  ) suffix += 1;
  return {
    from,
    to: base.length - suffix,
    insert: draft.slice(from, draft.length - suffix),
  };
}

/** Rebase one visual edit over one canonical edit, refusing ambiguous touching ranges. */
export function rebaseMarkdownDraft(base: string, draft: string, canonical: string): string | null {
  if (canonical === base) return draft;
  if (draft === base) return canonical;
  const local = minimalMarkdownPatch(base, draft);
  const remote = minimalMarkdownPatch(base, canonical);
  if (local.from === local.to && local.insert === "") return canonical;
  if (remote.from === remote.to && remote.insert === "") return draft;

  if (remote.to < local.from || (remote.to === local.from && remote.from !== remote.to)) {
    const delta = remote.insert.length - (remote.to - remote.from);
    return `${canonical.slice(0, local.from + delta)}${local.insert}${canonical.slice(local.to + delta)}`;
  }
  if (local.to < remote.from || (local.to === remote.from && local.from !== local.to)) {
    return `${canonical.slice(0, local.from)}${local.insert}${canonical.slice(local.to)}`;
  }
  return null;
}

export function preserveMarkdownEnvelope(serialized: string, original: string): string {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? original.slice(1) : original;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const converted = eol === "\r\n" ? serialized.replace(/\r?\n/g, "\r\n") : serialized;
  const ending = body.match(/(?:\r?\n)+$/)?.[0] ?? "";
  return `${bom}${converted.replace(/(?:\r?\n)+$/, "")}${ending}`;
}

function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of body) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * A GFM table header row must contain an unescaped pipe. Without this check a
 * setext level-2 heading (`Title` + `---`) or a `---` thematic break following
 * a one-line paragraph looks exactly like a one-column table.
 */
function hasUnescapedPipe(line: string): boolean {
  let escaped = false;
  for (const character of line) {
    if (character === "|" && !escaped) return true;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return false;
}

/**
 * Replace valid GFM tables with their represented semantics. Tiptap is allowed
 * to pad cells and canonicalize delimiter widths, but no syntax outside those
 * tables is forgiven by the visual-editing safety check.
 */
export function canonicalizeSupportedMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index] ?? "";
    const header = tableCells(headerLine);
    const delimiters = index + 1 < lines.length ? tableCells(lines[index + 1] ?? "") : [];
    const alignments = delimiters.map((cell) => {
      const compact = cell.replace(/\s/g, "");
      if (!/^:?-{3,}:?$/.test(compact)) return null;
      return compact.startsWith(":") && compact.endsWith(":") ? "center"
        : compact.startsWith(":") ? "left"
          : compact.endsWith(":") ? "right"
            : null;
    });
    if (hasUnescapedPipe(headerLine) && header.length > 0 && header.length === delimiters.length && alignments.every((value, cell) => (
      value !== null || /^\s*-{3,}\s*$/.test(delimiters[cell] ?? "")
    ))) {
      const rows: string[][] = [];
      let next = index + 2;
      while (next < lines.length && lines[next]!.includes("|")) {
        const row = tableCells(lines[next]!);
        if (row.length !== header.length) break;
        rows.push(row);
        next += 1;
      }
      result.push(`@@GFM_TABLE:${JSON.stringify({ header, alignments, rows })}@@`);
      index = next - 1;
    } else {
      result.push(lines[index]!);
    }
  }
  // Tiptap's table serializer emits a structural leading newline for a table
  // at the document start; it does not represent an authored blank block.
  if (result[0] === "" && result[1]?.startsWith("@@GFM_TABLE:")) result.shift();
  // CommonMark permits a backslash before punctuation and removes it when
  // rendering. The serializer may add that harmless escape in prose.
  return result.join("\n").replace(/\\\./g, ".");
}
