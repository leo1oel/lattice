/**
 * Formatting for the Markdown source editor's selection toolbar: the same
 * inline formats and block types the visual editor's toolbar offers
 * (engine/chrome/selection-toolbar.tsx), written as the Markdown syntax the
 * visual editor itself writes. Every command toggles: a selection already in
 * the format loses it.
 *
 * Inline formats work line by line, so a selection over several paragraphs
 * wraps each one rather than opening a marker no paragraph closes, and keep
 * the selection's edge whitespace outside the markers (`** bold**` is not
 * bold).
 */
import { ChangeSet, type ChangeSpec, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";

export type MarkdownInlineFormat = "bold" | "italic" | "underline" | "strike" | "code" | "highlight" | "math" | "link";

export type MarkdownBlockType =
  | "text" | "heading-1" | "heading-2" | "heading-3" | "heading-4" | "heading-5" | "heading-6"
  | "bullet-list" | "ordered-list" | "task-list" | "quote" | "code-block";

/** What the selection already is, for the toolbar's pressed buttons and ticked block type. */
export type MarkdownSelectionFormat = {
  inline: ReadonlySet<MarkdownInlineFormat>;
  block: MarkdownBlockType;
  /** Inside a fenced code block, where inline formats mean nothing. */
  inCode: boolean;
};

const WRAPS: Record<Exclude<MarkdownInlineFormat, "bold" | "italic" | "link">, readonly [string, string]> = {
  underline: ["<u>", "</u>"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
  highlight: ["==", "=="],
  math: ["$", "$"],
};

type Segment = { from: number; to: number };
/** The ranges a format's markers take around a segment, deleted to remove it. */
type Markers = readonly [Segment, Segment];

/** The non-blank part of each line the selection touches. */
function segments(doc: Text, from: number, to: number): Segment[] {
  const result: Segment[] = [];
  for (let number = doc.lineAt(from).number, last = doc.lineAt(to).number; number <= last; number += 1) {
    const line = doc.line(number);
    const start = Math.max(from, line.from);
    const end = Math.min(to, line.to);
    const text = doc.sliceString(start, end);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    if (start + lead < end - trail) result.push({ from: start + lead, to: end - trail });
  }
  return result;
}

/** How many `char`s run backwards from `at` (exclusive) or forwards from it. */
function run(doc: Text, at: number, char: string, backwards: boolean): number {
  let count = 0;
  while (backwards ? at - count > 0 && doc.sliceString(at - count - 1, at - count) === char
    : at + count < doc.length && doc.sliceString(at + count, at + count + 1) === char) count += 1;
  return count;
}

/**
 * Emphasis markers around [from, to): `*` runs (or `_` runs) on both sides.
 * Bold takes two of them and italic one; a run of three is both, so `***x***`
 * is bold and italic, and a run of two is bold but not italic.
 */
function emphasisMarkers(doc: Text, from: number, to: number, bold: boolean): Markers | null {
  const width = bold ? 2 : 1;
  const holds = (depth: number) => bold ? depth >= 2 : depth === 1 || depth === 3;
  const text = doc.sliceString(from, to);
  for (const char of ["*", "_"]) {
    const before = run(doc, from, char, true);
    const after = run(doc, to, char, false);
    if (before || after) {
      if (holds(Math.min(before, after))) return [{ from: from - width, to: from }, { from: to, to: to + width }];
      continue;
    }
    // Selected with its markers.
    const lead = text.length - text.replace(new RegExp(`^\\${char}+`), "").length;
    const trail = text.length - text.replace(new RegExp(`\\${char}+$`), "").length;
    if (lead + trail < text.length && holds(Math.min(lead, trail))) {
      return [{ from: from + lead - width, to: from + lead }, { from: to - trail, to: to - trail + width }];
    }
  }
  return null;
}

function wrapMarkers(doc: Text, from: number, to: number, [open, close]: readonly [string, string]): Markers | null {
  if (doc.sliceString(from - open.length, from) === open && doc.sliceString(to, to + close.length) === close) {
    return [{ from: from - open.length, to: from }, { from: to, to: to + close.length }];
  }
  const text = doc.sliceString(from, to);
  if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
    return [{ from, to: from + open.length }, { from: to - close.length, to }];
  }
  return null;
}

/** `[text](url)` around the selection (or selected whole): the markers are `[` and `](url)`. */
function linkMarkers(doc: Text, from: number, to: number): Markers | null {
  const line = doc.lineAt(from);
  const destination = /^\]\([^()\s]*(?:\s+"[^"]*")?\)/.exec(doc.sliceString(to, line.to));
  if (doc.sliceString(from - 1, from) === "[" && destination) {
    return [{ from: from - 1, to: from }, { from: to, to: to + destination[0].length }];
  }
  const whole = /^\[([^\]]*)\]\([^()\s]*(?:\s+"[^"]*")?\)$/.exec(doc.sliceString(from, to));
  return whole ? [{ from, to: from + 1 }, { from: from + 1 + whole[1]!.length, to }] : null;
}

function markers(doc: Text, segment: Segment, format: MarkdownInlineFormat): Markers | null {
  if (format === "bold" || format === "italic") return emphasisMarkers(doc, segment.from, segment.to, format === "bold");
  if (format === "link") return linkMarkers(doc, segment.from, segment.to);
  return wrapMarkers(doc, segment.from, segment.to, WRAPS[format]);
}

/** Toggle `format` on the main selection; null when it has nothing to format. */
export function toggleMarkdownInline(state: EditorState, format: MarkdownInlineFormat): TransactionSpec | null {
  const range = state.selection.main;
  const parts = segments(state.doc, range.from, range.to);
  if (!parts.length) return null;
  const found = parts.map((segment) => markers(state.doc, segment, format));
  if (found.every(Boolean)) {
    const changes = state.changes(found.flatMap((pair) => pair!.map(({ from, to }) => ({ from, to }))));
    const first = found[0]![0];
    const last = found[found.length - 1]![1];
    // Selected with its markers, the text alone stays selected.
    return { changes, selection: { anchor: changes.mapPos(Math.max(range.from, first.to), 1), head: changes.mapPos(Math.min(range.to, last.from), -1) } };
  }
  if (format === "link") {
    // The destination is typed next: the caret waits between the parentheses.
    const { from, to } = { from: parts[0]!.from, to: parts[parts.length - 1]!.to };
    const changes = state.changes([{ from, insert: "[" }, { from: to, insert: "]()" }]);
    return { changes, selection: { anchor: changes.mapPos(to, 1) - 1 } };
  }
  const [open, close] = format === "bold" ? ["**", "**"] : format === "italic" ? ["*", "*"] : WRAPS[format];
  const inserts: ChangeSpec[] = parts.flatMap((segment, index) => found[index] ? [] : [
    { from: segment.from, insert: open }, { from: segment.to, insert: close },
  ]);
  const changes = state.changes(inserts);
  return { changes, selection: { anchor: changes.mapPos(parts[0]!.from, 1), head: changes.mapPos(parts[parts.length - 1]!.to, -1) } };
}

/* --- Block types ---------------------------------------------------------------- */

/** A line's leading syntax: indent, `>` quote markers, then a heading or list marker. */
const LINE_PREFIX = /^(\s*)((?:>[ \t]?)*)(#{1,6}[ \t]+|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)?/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

type LinePrefix = { indent: string; quote: string; marker: string; length: number };

function linePrefix(text: string): LinePrefix {
  const match = LINE_PREFIX.exec(text)!;
  const marker = match[3] ?? "";
  return { indent: match[1]!, quote: match[2]!, marker, length: match[0].length };
}

function markerType(marker: string): MarkdownBlockType | null {
  if (!marker) return null;
  if (marker.startsWith("#")) return `heading-${marker.trimEnd().length}` as MarkdownBlockType;
  if (/^[-*+][ \t]+\[/.test(marker)) return "task-list";
  return /^\d/.test(marker) ? "ordered-list" : "bullet-list";
}

/** The fenced code block holding line `number`, as its fence lines; the close is null for an unclosed one. */
function fenceAround(doc: Text, number: number): { open: number; close: number | null } | null {
  let open: { line: number; fence: string } | null = null;
  for (let current = 1; current <= doc.lines; current += 1) {
    const text = doc.line(current).text;
    const fence = FENCE.exec(text)?.[1];
    if (!open) {
      if (current > number) return null;
      if (fence) open = { line: current, fence };
    } else if (fence && fence[0] === open.fence[0] && fence.length >= open.fence.length && !text.slice(text.indexOf(fence) + fence.length).trim()) {
      if (current >= number) return { open: open.line, close: current };
      open = null;
    }
  }
  return open ? { open: open.line, close: null } : null;
}

function blockOfLine(text: string): MarkdownBlockType {
  const prefix = linePrefix(text);
  return markerType(prefix.marker) ?? (prefix.quote ? "quote" : "text");
}

/** The selection's inline formats (every line has them) and the block type of its first line. */
export function markdownSelectionFormat(state: EditorState): MarkdownSelectionFormat {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  if (fenceAround(state.doc, first.number)) return { inline: new Set(), block: "code-block", inCode: true };
  const parts = segments(state.doc, range.from, range.to);
  const inline = new Set<MarkdownInlineFormat>();
  if (parts.length) {
    for (const format of ["bold", "italic", "underline", "strike", "code", "highlight", "math", "link"] as const) {
      if (parts.every((segment) => markers(state.doc, segment, format))) inline.add(format);
    }
  }
  return { inline, block: blockOfLine(first.text), inCode: false };
}

function markerFor(type: MarkdownBlockType, index: number): string {
  if (type.startsWith("heading-")) return `${"#".repeat(Number(type.slice(-1)))} `;
  if (type === "bullet-list") return "- ";
  if (type === "task-list") return "- [ ] ";
  return type === "ordered-list" ? `${index + 1}. ` : "";
}

/**
 * Make the lines the selection touches `type`. A list or quote the lines
 * already all are turns back into text, as the visual editor's list and
 * quote toggles do; a heading is set, not toggled. Text clears headings,
 * lists and quotes alike, and leaves a fenced code block.
 */
export function setMarkdownBlock(state: EditorState, type: MarkdownBlockType): TransactionSpec | null {
  const { doc } = state;
  const range = state.selection.main;
  const firstLine = doc.lineAt(range.from).number;
  // A selection ending at a line's very start leaves that line out, as the visual editor does.
  const lastLine = Math.max(firstLine, doc.lineAt(range.to > range.from && doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to).number);
  const fence = fenceAround(doc, firstLine);
  const changes: ChangeSpec[] = [];
  let contentFirst = firstLine;
  let contentLast = lastLine;
  if (fence) {
    // Leaving a code block takes off its fences, whatever the block becomes.
    const close = fence.close ?? doc.lines + 1;
    contentFirst = fence.open + 1;
    contentLast = close - 1;
    const open = doc.line(fence.open);
    changes.push({ from: open.from, to: Math.min(doc.length, open.to + 1) });
    if (fence.close) {
      const end = doc.line(fence.close);
      changes.push({ from: Math.max(0, end.from - 1), to: end.to });
    }
    if (type === "code-block" || type === "text") return withMappedSelection(state, changes);
  } else if (type === "code-block") {
    const start = doc.line(firstLine);
    const end = doc.line(lastLine);
    changes.push({ from: start.from, insert: "```\n" }, { from: end.to, insert: "\n```" });
    return withMappedSelection(state, changes);
  }
  const lines: { from: number; prefix: LinePrefix }[] = [];
  for (let number = contentFirst; number <= contentLast; number += 1) {
    const line = doc.line(number);
    if (line.text.trim()) lines.push({ from: line.from, prefix: linePrefix(line.text) });
  }
  if (!lines.length) return changes.length ? withMappedSelection(state, changes) : null;
  const all = (test: (prefix: LinePrefix) => boolean) => lines.every(({ prefix }) => test(prefix));
  const toggledOff = type === "quote" ? all((prefix) => Boolean(prefix.quote))
    : (type === "bullet-list" || type === "ordered-list" || type === "task-list") && all((prefix) => markerType(prefix.marker) === type);
  lines.forEach(({ from, prefix }, index) => {
    let quote = prefix.quote;
    let marker = prefix.marker;
    if (type === "quote") quote = toggledOff ? quote.replace(/^>[ \t]?/, "") : quote || "> ";
    else if (type === "text") {
      quote = "";
      marker = "";
    } else marker = toggledOff ? "" : markerFor(type, index);
    const next = prefix.indent + quote + marker;
    if (next !== doc.sliceString(from, from + prefix.length)) changes.push({ from, to: from + prefix.length, insert: next });
  });
  return changes.length ? withMappedSelection(state, changes) : null;
}

/** `changes` with the selection carried across them, never swallowing the syntax put in front of it. */
function withMappedSelection(state: EditorState, spec: ChangeSpec[]): TransactionSpec {
  const changes = ChangeSet.of(spec, state.doc.length);
  const range = state.selection.main;
  return { changes, selection: { anchor: changes.mapPos(range.from, 1), head: changes.mapPos(range.to, range.empty ? 1 : -1) } };
}
