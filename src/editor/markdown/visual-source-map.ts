/**
 * Mapping between Markdown source offsets and ProseMirror positions.
 *
 * Every overlay the visual editor paints from source coordinates (peer carets,
 * tracked changes, comments, source-scroll labels) and every caret it reports
 * back goes through here. The approach is the same in both directions: plant a
 * sentinel string on one side, round-trip through the parser or serializer, and
 * find where the sentinel landed on the other side.
 */
import type { Editor } from "@tiptap/react";
import { stripFrontmatter } from "../../open-knowledge-core/extensions/frontmatter";
import { parseTableSpanLayoutMarker } from "../../open-knowledge-core/extensions/table-fidelity";
import { preserveMarkdownEnvelope } from "./markdown-collab";
import { LARGE_MARKDOWN_PREVIEW_THRESHOLD } from "./markdown-preview-sync-policy";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";

type PmDoc = Editor["state"]["doc"];
export type VisualSourceRange = { from: number; to: number };
export type MappedSourceOffset = { markdown: string; offset: number };

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const withoutCr = (line: string) => line.replace(/\r$/, "");

// Three-slot MRU parse memo. A single publication legitimately parses up to
// three distinct strings — the canonical text, the freshly serialized draft
// (restoreUnchangedBlocks compares both), and the caret-report snapshot — and
// a one-slot memo thrashed between them. Anything larger would only hold dead
// document generations alive.
const MDAST_CACHE_SLOTS = 3;
type MdastChildren = ReturnType<ReturnType<typeof getMarkdownManager>["parseToEditorMdast"]>["children"];
const mdastCache: { text: string; children: MdastChildren; sourceOffsetBase: number }[] = [];

function parseEditorMdastChildrenCached(text: string) {
  const hit = mdastCache.findIndex((entry) => entry.text === text);
  if (hit !== -1) {
    const [entry] = mdastCache.splice(hit, 1);
    mdastCache.unshift(entry!);
    return entry!;
  }
  const bomLength = text.startsWith("\uFEFF") ? 1 : 0;
  const { frontmatter, body } = stripFrontmatter(text.slice(bomLength));
  let children: MdastChildren = [];
  try {
    // Frontmatter is document envelope, not an editor root. Parse only the
    // body so its non-emitting YAML node cannot shift every source/root pair.
    children = getMarkdownManager().parseToEditorMdast(body).children;
  } catch {
    // The document itself opens through parse-with-fallback, but this probe
    // uses the raw parser — a PDF text-layer paper with an unclosed `{` throws
    // here. Empty children degrade every consumer to its no-position path,
    // and the cache keeps one broken paper from re-throwing on every caret move.
  }
  const entry = { text, children, sourceOffsetBase: bomLength + frontmatter.length };
  mdastCache.unshift(entry);
  mdastCache.length = Math.min(mdastCache.length, MDAST_CACHE_SLOTS);
  return entry;
}

function sourceNodeRanges(text: string): (VisualSourceRange | null)[] {
  const { children, sourceOffsetBase } = parseEditorMdastChildrenCached(text);
  return children.map(({ position }) => {
    const from = position?.start.offset;
    const to = position?.end.offset;
    return typeof from === "number" && typeof to === "number"
      ? { from: from + sourceOffsetBase, to: to + sourceOffsetBase }
      : null;
  });
}

// How many ProseMirror roots a block's source renders depends only on that
// source, so it is memoized per block. Checking a document's ranges parses
// every block on its own (about a thousand parses for a 400 KB file), and the
// caret report and each publication used to repeat all of them after every
// keystroke; now only the blocks an edit changed are parsed again.
const ROOT_COUNT_CACHE_ENTRIES = 20_000;
const ROOT_COUNT_CACHE_CHARACTERS = 8_000_000;
const rootCounts = new Map<string, number>();
let rootCountCharacters = 0;

function renderedRootCount(source: string): number {
  const cached = rootCounts.get(source);
  if (cached !== undefined) {
    rootCounts.delete(source);
    rootCounts.set(source, cached);
    return cached;
  }
  const count = parseVisualMarkdown(source).content?.length ?? 0;
  // A slice keeps its whole document alive in both V8 and JavaScriptCore, and
  // every keystroke publishes a new document; a JSON round trip stores a
  // detached copy of just the block.
  rootCounts.set(JSON.parse(JSON.stringify(source)) as string, count);
  rootCountCharacters += source.length;
  while (rootCounts.size > ROOT_COUNT_CACHE_ENTRIES || rootCountCharacters > ROOT_COUNT_CACHE_CHARACTERS) {
    const oldest = rootCounts.keys().next().value!;
    rootCounts.delete(oldest);
    rootCountCharacters -= oldest.length;
  }
  return count;
}

/** Best-effort, monotonic source range per rendered top-level block (for navigation). */
export function visualSourceRanges(text: string, blockCount: number): VisualSourceRange[] {
  const direct = sourceNodeRanges(text).filter((range) => range !== null);
  if (direct.length === blockCount) return direct;
  // A mixed inline/block paragraph can produce several ProseMirror roots, so
  // ordinal pairing shifts every later anchor. Expand only on that uncommon
  // mismatch by counting the roots each original source slice renders.
  const expanded = direct.flatMap((range) => Array.from(
    { length: Math.max(1, renderedRootCount(text.slice(range.from, range.to))) },
    () => range,
  ));
  if (expanded.length === blockCount) return expanded;
  // Reusing the nearest known range is safer than jumping to offset zero.
  return Array.from({ length: blockCount }, (_, index) => (
    expanded[Math.min(index, expanded.length - 1)] ?? { from: 0, to: 0 }
  ));
}

/**
 * Top-level block ranges only when the source→block mapping is certain: one
 * mdast child per rendered block, in document order, non-overlapping.
 *
 * Splicing source bytes back into the document cannot use the best-effort
 * guess above — a duplicated range would emit a block twice — so this variant
 * reports failure instead and its callers fall back.
 */
export function exactVisualSourceRanges(text: string, blockCount: number): VisualSourceRange[] | null {
  const ranges = exactSourceRanges(text);
  return ranges?.length === blockCount ? ranges : null;
}

// The same text is checked repeatedly: the caret report runs against the last
// published Markdown after every pause in typing, and each publication checks
// both the previous and the new text. Same slot count as the mdast memo.
const exactRangesCache: { text: string; ranges: readonly VisualSourceRange[] | null }[] = [];

function exactSourceRanges(text: string): VisualSourceRange[] | null {
  const hit = exactRangesCache.findIndex((entry) => entry.text === text);
  if (hit !== -1) {
    const [entry] = exactRangesCache.splice(hit, 1);
    exactRangesCache.unshift(entry!);
    return entry!.ranges as VisualSourceRange[] | null;
  }
  const ranges = sourceNodeRanges(text);
  let exact: VisualSourceRange[] | null = ranges as VisualSourceRange[];
  let previousEnd = 0;
  for (const range of ranges) {
    // Equal total counts do not prove ordinal ownership: an ignored YAML,
    // definition, or footnote node (zero PM roots) can cancel a mixed
    // paragraph that expands into two roots.
    if (!range || range.from < previousEnd || range.to < range.from || renderedRootCount(text.slice(range.from, range.to)) !== 1) {
      exact = null;
      break;
    }
    previousEnd = range.to;
  }
  exactRangesCache.unshift({ text, ranges: exact });
  exactRangesCache.length = Math.min(exactRangesCache.length, MDAST_CACHE_SLOTS);
  return exact;
}

export function sourceOffsetForRowColumn(text: string, row: number, column: number): number {
  const lines = text.split("\n");
  const lineIndex = clamp(row, 0, Math.max(lines.length - 1, 0));
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += lines[index]!.length + 1;
  return offset + clamp(column, 0, lines[lineIndex]?.length ?? 0);
}

export function rowColumnForSourceOffset(text: string, sourceOffset: number): { row: number; column: number } {
  const before = text.slice(0, clamp(sourceOffset, 0, text.length));
  return { row: before.split("\n").length - 1, column: before.length - before.lastIndexOf("\n") - 1 };
}

function tableCellRanges(line: string): VisualSourceRange[] {
  const pipes = [-1];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) escapes += 1;
    if (escapes % 2 === 0) pipes.push(index);
  }
  if (pipes.length === 1) return [];
  pipes.push(line.length);
  const ranges = pipes.slice(0, -1).map((pipe, index) => ({ from: pipe + 1, to: pipes[index + 1]! }));
  if (pipes[1] === 0) ranges.shift();
  if (pipes[pipes.length - 2] === line.length - 1) ranges.pop();
  return ranges;
}

function isTableDelimiterLine(line: string): boolean {
  const cells = tableCellRanges(line);
  return cells.length > 0 && cells.every(({ from, to }) => /^:?-+:?$/.test(line.slice(from, to).trim()));
}

const lineStartBefore = (text: string, offset: number) => text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;

/** A GFM delimiter row has no PM node; anchor it in the corresponding header cell. */
function visualizableTableSourceOffset(text: string, sourceOffset: number): number {
  const lineStart = lineStartBefore(text, sourceOffset);
  const lineEnd = text.indexOf("\n", sourceOffset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  if (!isTableDelimiterLine(line) || lineStart === 0) return sourceOffset;
  const delimiterCells = tableCellRanges(line);
  const previousLineEnd = lineStart - 1;
  const previousLineStart = lineStartBefore(text, previousLineEnd);
  const header = text.slice(previousLineStart, previousLineEnd);
  const headerCells = tableCellRanges(header);
  if (headerCells.length !== delimiterCells.length) return sourceOffset;
  // A dash-only body row has the same local shape. If this contiguous table
  // already has a delimiter above it, leave the body-row caret where it is.
  for (let scanEnd = previousLineEnd; scanEnd >= 0;) {
    const scanStart = lineStartBefore(text, scanEnd);
    const scanLine = text.slice(scanStart, scanEnd);
    if (!tableCellRanges(scanLine).length) break;
    if (isTableDelimiterLine(scanLine)) return sourceOffset;
    scanEnd = scanStart - 1;
  }
  const column = Math.max(0, sourceOffset - lineStart);
  const cellIndex = delimiterCells.findIndex(({ from, to }) => column >= from && column <= to);
  const headerCell = headerCells[Math.max(0, cellIndex)];
  if (!headerCell) return sourceOffset;
  const rawHeader = header.slice(headerCell.from, headerCell.to);
  return previousLineStart + headerCell.from + rawHeader.length - rawHeader.trimStart().length + rawHeader.trim().length;
}

function cursorSentinel(text: string): string {
  let sentinel = "\uE000\uE001\uE002";
  while (text.includes(sentinel)) sentinel += "\uE003";
  return sentinel;
}

const leadingSpace = (raw: string) => raw.length - raw.trimStart().length;

/**
 * Keep an explicit span valid while probing one of its rectangular source
 * coordinates. Every repeated coordinate receives the same sentinel at the
 * same content-relative offset, so strict metadata validation still applies
 * and the visual parser collapses the probes back into their one origin cell.
 */
function markExplicitTableSpanSource(text: string, sourceOffset: number, sentinel: string): string | null {
  const rawLines = text.split("\n");
  const lines = rawLines.map(withoutCr);
  const starts: number[] = [];
  let cursor = 0;
  for (const line of rawLines) {
    starts.push(cursor);
    cursor += line.length + 1;
  }
  let lineIndex = 0;
  for (let index = 1; index < starts.length && starts[index]! <= sourceOffset; index++) lineIndex = index;
  const isTableLine = (index: number) => tableCellRanges(lines[index]!).length > 0;
  if (!isTableLine(lineIndex)) return null;
  let tableStart = lineIndex;
  while (tableStart > 0 && isTableLine(tableStart - 1)) tableStart -= 1;
  let tableEnd = lineIndex;
  while (tableEnd + 1 < lines.length && isTableLine(tableEnd + 1)) tableEnd += 1;
  let delimiterLine = tableStart;
  while (delimiterLine <= tableEnd && !isTableDelimiterLine(lines[delimiterLine]!)) delimiterLine += 1;
  if (delimiterLine > tableEnd || delimiterLine <= tableStart) return null;
  const headerLine = delimiterLine - 1;
  const logicalRow = lineIndex === headerLine ? 0 : lineIndex > delimiterLine ? lineIndex - delimiterLine : -1;
  if (logicalRow < 0) return null;

  const markerPrefix = text.slice(0, starts[headerLine]);
  const markerStart = markerPrefix.lastIndexOf("<!--");
  if (markerStart < 0) return null;
  const marker = markerPrefix.slice(markerStart).match(/^<!--\s*([\s\S]*?)\s*-->\s*$/);
  const layout = marker ? parseTableSpanLayoutMarker(marker[1]!.trim()) : null;
  if (layout === null) return null;

  const sourceLine = lines[lineIndex]!;
  const sourceColumn = sourceOffset - starts[lineIndex]!;
  const sourceRanges = tableCellRanges(sourceLine);
  const logicalColumn = sourceRanges.findIndex(({ from, to }, index) => (
    sourceColumn >= from && (sourceColumn < to || (index === sourceRanges.length - 1 && sourceColumn <= to))
  ));
  if (logicalColumn < 0) return null;
  const span = layout.find(([row, column, rowspan, colspan]) => (
    logicalRow >= row && logicalRow < row + rowspan && logicalColumn >= column && logicalColumn < column + colspan
  ));
  if (!span) return null;

  const sourceCell = sourceRanges[logicalColumn]!;
  const sourceRaw = sourceLine.slice(sourceCell.from, sourceCell.to);
  const sourceContent = sourceRaw.trim();
  const relativeOffset = clamp(sourceColumn - sourceCell.from - leadingSpace(sourceRaw), 0, sourceContent.length);
  const insertionPoints = new Set<number>();
  const [spanRow, spanColumn, rowspan, colspan] = span;
  for (let row = spanRow; row < spanRow + rowspan; row++) {
    const targetLineIndex = row === 0 ? headerLine : delimiterLine + row;
    const targetLine = lines[targetLineIndex];
    if (targetLine === undefined) return null;
    for (let column = spanColumn; column < spanColumn + colspan; column++) {
      const cell = tableCellRanges(targetLine)[column];
      if (!cell) return null;
      const raw = targetLine.slice(cell.from, cell.to);
      if (raw.trim() !== sourceContent) return null;
      insertionPoints.add(starts[targetLineIndex]! + cell.from + leadingSpace(raw) + relativeOffset);
    }
  }
  let marked = text;
  for (const point of [...insertionPoints].sort((left, right) => right - left)) {
    marked = `${marked.slice(0, point)}${sentinel}${marked.slice(point)}`;
  }
  return marked;
}

function tableGeometrySignature(doc: PmDoc): string {
  const tables: unknown[] = [];
  doc.descendants((node) => {
    if (node.type.name !== "table") return;
    tables.push(node.children.map((row) => row.children.map((cell) => [
      cell.type.name,
      Number(cell.attrs.colspan ?? 1),
      Number(cell.attrs.rowspan ?? 1),
    ])));
    return false;
  });
  return JSON.stringify(tables);
}

/** Fence punctuation has no visual text position; do not parse it as prose. */
function sourceOffsetIsOnCodeFence(text: string, sourceOffset: number): boolean {
  const targetLine = text.slice(0, sourceOffset).split("\n").length - 1;
  let openChar = "";
  let openLength = 0;
  for (const [index, rawLine] of text.split("\n").entries()) {
    const match = withoutCr(rawLine).match(/^ {0,3}([`~])(\1{2,})(.*)$/);
    if (!match) continue;
    const char = match[1]!;
    const length = 1 + match[2]!.length;
    if (!openChar) {
      if (index === targetLine) return true;
      openChar = char;
      openLength = length;
    } else if (char === openChar && length >= openLength && !match[3]!.trim()) {
      if (index === targetLine) return true;
      openChar = "";
      openLength = 0;
    }
  }
  return false;
}

/** Parse a temporary marker at the source caret and find where it lands in PM. */
export function proseMirrorPositionForSourceOffset(
  doc: PmDoc,
  text: string,
  sourceOffset: number,
  sourcePath?: string,
): number | null {
  let offset = visualizableTableSourceOffset(text, clamp(sourceOffset, 0, text.length));
  if (sourceOffsetIsOnCodeFence(text, offset)) return null;
  // Overleaf and ProseMirror both count UTF-16 code units. If a stale presence
  // update points between a surrogate pair, keep the marker beside the
  // character rather than splitting it into invalid source.
  if (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)) {
    offset += 1;
  }
  const sentinel = cursorSentinel(text);
  try {
    const marked = markExplicitTableSpanSource(text, offset, sentinel)
      ?? `${text.slice(0, offset)}${sentinel}${text.slice(offset)}`;
    const parsed = doc.type.schema.nodeFromJSON(parseVisualMarkdown(marked, sourcePath));
    // A marker inside a coordinate covered by an inferred paper span changes
    // the evidence used to infer that span. An omitted overlay is safer than
    // an action painted over another cell.
    if (tableGeometrySignature(parsed) !== tableGeometrySignature(doc)) return null;
    let position: number | null = null;
    parsed.descendants((node, nodePosition) => {
      if (!node.isText || position !== null) return;
      const index = node.text?.indexOf(sentinel) ?? -1;
      if (index >= 0) position = nodePosition + index;
    });
    return position === null ? null : clamp(position, 0, doc.content.size);
  } catch {
    return null;
  }
}

/** Resolve a source range into a non-empty PM range, or null when either end does not map. */
export function proseMirrorRangeForSource(
  doc: PmDoc,
  text: string,
  range: VisualSourceRange,
  sourcePath: string,
): VisualSourceRange | null {
  const from = proseMirrorPositionForSourceOffset(doc, text, range.from, sourcePath);
  const to = from === null ? null : proseMirrorPositionForSourceOffset(doc, text, range.to, sourcePath);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

/**
 * The document with `sentinel` typed at `position`. Pristine MDX serializes
 * from sourceRaw, so the temporary containing components are marked dirty to
 * make the sentinel in their body visible without touching the live document.
 */
function docWithSentinel(editor: Editor, position: number, sentinel: string): PmDoc {
  const transaction = editor.state.tr;
  const resolved = transaction.doc.resolve(position);
  for (let depth = 1; depth <= resolved.depth; depth += 1) {
    if (resolved.node(depth).type.name === "jsxComponent") {
      transaction.setNodeAttribute(resolved.before(depth), "sourceDirty", true);
    }
  }
  return transaction.insertText(sentinel, position).doc;
}

/**
 * Resolve against the original block, not a reserialized whole document:
 * unrelated tight block gaps can normalize without changing this selection.
 * Only return an exact offset when the marked block round-trips losslessly;
 * clamping a normalized offset could attach a comment to the wrong text.
 */
export function blockSourceOffsetForPosition(
  editor: Editor,
  position: number,
  expectedMarkdown: string,
): MappedSourceOffset | null {
  const doc = editor.state.doc;
  const ranges = exactVisualSourceRanges(expectedMarkdown, doc.childCount);
  if (!ranges) return null;
  const at = clamp(position, 0, doc.content.size);
  const resolved = doc.resolve(at);
  const blockIndex = Math.min(resolved.index(0), doc.childCount - 1);
  const range = ranges[blockIndex];
  if (!range) return null;
  // A caret between blocks, or on a non-text block (a horizontal rule, a
  // selected figure), has no character-precise source position to recover.
  if (resolved.depth === 0 || !resolved.parent.isTextblock) {
    return { markdown: expectedMarkdown, offset: at === doc.content.size ? expectedMarkdown.length : range.from };
  }
  try {
    const sentinel = cursorSentinel(expectedMarkdown);
    const marked = docWithSentinel(editor, at, sentinel);
    if (marked.childCount !== doc.childCount) return null;
    const originalBlock = expectedMarkdown.slice(range.from, range.to);
    const enveloped = preserveMarkdownEnvelope(
      getMarkdownManager().serialize({ type: "doc", content: [marked.child(blockIndex).toJSON()] }),
      originalBlock,
    );
    const index = enveloped.indexOf(sentinel);
    if (index < 0 || enveloped.replace(sentinel, "") !== originalBlock) return null;
    return { markdown: expectedMarkdown, offset: range.from + index };
  } catch {
    return null;
  }
}

/** Serialize a temporary PM marker to obtain the exact canonical source caret. */
export function sourceOffsetForProseMirrorPosition(
  editor: Editor,
  position: number,
  expectedMarkdown: string,
): MappedSourceOffset | null {
  if (expectedMarkdown.length >= LARGE_MARKDOWN_PREVIEW_THRESHOLD) {
    const blockScoped = blockSourceOffsetForPosition(editor, position, expectedMarkdown);
    if (blockScoped) return blockScoped;
  }
  const doc = editor.state.doc;
  const sentinel = cursorSentinel(`${expectedMarkdown}\n${JSON.stringify(doc.toJSON())}`);
  try {
    const marked = docWithSentinel(editor, clamp(position, 0, doc.content.size), sentinel);
    const enveloped = preserveMarkdownEnvelope(getMarkdownManager().serialize(marked.toJSON()), expectedMarkdown);
    const offset = enveloped.indexOf(sentinel);
    return offset < 0 ? null : { markdown: enveloped.replace(sentinel, ""), offset };
  } catch {
    return null;
  }
}
