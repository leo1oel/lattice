/**
 * Where the visual engine's content sits in its Markdown (spec R-SRC-1–5,
 * R-SRC-11–13): positions in the editor and offsets, or (row, column), in the
 * host's text, both ways.
 *
 * The map is built from the baseline: each top-level node the editor still
 * shows unchanged has its block's exact source and place in the text. Inside
 * a block, the node's inline content is aligned with the block's source in
 * order: every text run and atom is found in the source after the previous
 * one, so the Markdown syntax around them (markers, delimiters, escapes,
 * container prefixes) is skipped rather than modelled. Anything that cannot
 * be aligned is left out, so a lookup there yields null: a position is
 * omitted, never misplaced (R-SRC-3). A lookup costs one block, never the
 * document (R-SRC-13).
 *
 * Tables are aligned by grid instead: a source row and cell index name a
 * visual cell. The delimiter row anchors in its header cell, and a cell an
 * explicit layout merges maps to the merged cell's origin (R-SRC-4).
 *
 * Offsets are in the host's text: after a byte-order mark, and with CRLF line
 * endings when the file has them. Rows and columns count lines of that text,
 * without the byte-order mark.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Mark, Node as PmNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { MarkdownBaseline } from "./markdown-document";

/** How an offset that falls between aligned content resolves: only exactly, or to the next or previous aligned position. */
export type Snap = "exact" | "forward" | "backward";

/** At a position where formatting changes: the next run's side, or the previous run's. */
export type Bias = "after" | "before";

/**
 * One aligned piece of a block: editor positions `[pmFrom, pmTo]` against
 * source offsets `[from, to]`, block-relative. An exact piece maps every
 * position; `offsets`, when present, gives the source offset of each position
 * of a run written with escapes; otherwise only the two ends map.
 */
type Segment = { pmFrom: number; pmTo: number; from: number; to: number; exact: boolean; offsets?: number[] };

type Block = {
  /** Index of the top-level node. */
  child: number;
  /** Document position before the node. */
  pos: number;
  node: PmNode;
  source: string;
  /** Offset of the block in the body (LF, no byte-order mark). */
  bodyFrom: number;
  /** Offset of the block in the host's text. */
  textFrom: number;
  textTo: number;
  /** Row of the block's first line, and the column it starts at. */
  row: number;
  column: number;
};

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_OPEN = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const FOOTNOTE_OPEN = /^ {0,3}\[\^[^\]\n]*\]:[ \t]*/;

const countNewlines = (text: string, from = 0, to = text.length) => {
  let count = 0;
  for (let index = text.indexOf("\n", from); index >= 0 && index < to; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
};

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

const segmentCache = new WeakMap<PmNode, { source: string; paperSpans: boolean; segments: Segment[] }>();

export type Placement = Pick<Block, "bodyFrom" | "textFrom" | "textTo" | "row" | "column">;
const placementCache = new WeakMap<MarkdownBaseline, Placement[]>();

/** Where each baseline block sits in the text; computed once per baseline, so edits in between cost nothing. */
export function placements(baseline: MarkdownBaseline): Placement[] {
  const cached = placementCache.get(baseline);
  if (cached) return cached;
  const bom = baseline.envelope.bom ? 1 : 0;
  const { crlf } = baseline.envelope;
  const result: Placement[] = [];
  let body = 0;
  let row = 0;
  let column = 0;
  for (const entry of baseline.entries) {
    const gapLines = countNewlines(entry.gapBefore);
    row += gapLines;
    column = gapLines ? entry.gapBefore.length - entry.gapBefore.lastIndexOf("\n") - 1 : column + entry.gapBefore.length;
    body += entry.gapBefore.length;
    const lines = countNewlines(entry.source);
    const textFrom = bom + body + (crlf ? row : 0);
    result.push({ bodyFrom: body, textFrom, textTo: textFrom + entry.source.length + (crlf ? lines : 0), row, column });
    body += entry.source.length;
    column = lines ? entry.source.length - entry.source.lastIndexOf("\n") - 1 : column + entry.source.length;
    row += lines;
  }
  placementCache.set(baseline, result);
  return result;
}

export class SourceMap {
  private readonly blocks: Block[];
  private readonly byChild = new Map<number, Block>();
  private readonly crlf: boolean;

  constructor(readonly doc: PmNode, readonly baseline: MarkdownBaseline, readonly text: string) {
    this.crlf = baseline.envelope.crlf;
    this.blocks = this.pair();
    for (const block of this.blocks) this.byChild.set(block.child, block);
  }

  /** Pair each top-level node with the baseline block it still equals; place those blocks in the text. */
  private pair(): Block[] {
    const { entries } = this.baseline;
    const places = placements(this.baseline);
    const identity = new Map<PmNode, number>();
    entries.forEach((entry, index) => identity.set(entry.node, index));
    const blocks: Block[] = [];
    let next = 0;
    this.doc.forEach((child, offset, index) => {
      let found = identity.get(child) ?? -1;
      if (found < next) found = next < entries.length && child.eq(entries[next]!.node) ? next : -1;
      if (found < next) return;
      next = found + 1;
      const place = places[found]!;
      blocks.push({ child: index, pos: offset, node: child, source: entries[found]!.source, ...place });
    });
    return blocks;
  }

  /** The block holding document position `pos`, when that top-level node is mapped. */
  private blockAtPosition(pos: number): Block | null {
    if (pos < 0 || pos > this.doc.content.size) return null;
    const $pos = this.doc.resolve(pos);
    if ($pos.depth > 0) return this.byChild.get($pos.index(0)) ?? null;
    // Between top-level nodes: the start of the next one, else the end of the previous one.
    return this.byChild.get($pos.index(0)) ?? this.byChild.get($pos.index(0) - 1) ?? null;
  }

  /** The block whose text range holds `offset` (end-inclusive). */
  private blockAtOffset(offset: number): Block | null {
    let low = 0;
    let high = this.blocks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const block = this.blocks[middle]!;
      if (offset < block.textFrom) high = middle - 1;
      else if (offset > block.textTo) low = middle + 1;
      else return block;
    }
    return null;
  }

  /** The block holding source row `row`. */
  private blockAtRow(row: number): Block | null {
    let low = 0;
    let high = this.blocks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const block = this.blocks[middle]!;
      const lastRow = block.row + countNewlines(block.source);
      if (row < block.row) high = middle - 1;
      else if (row > lastRow) low = middle + 1;
      else return block;
    }
    return null;
  }

  private segments(block: Block): Segment[] {
    const paperSpans = Boolean(this.baseline.options.paperSpans);
    const cached = segmentCache.get(block.node);
    if (cached && cached.source === block.source && cached.paperSpans === paperSpans) return cached.segments;
    const segments = block.node.type.spec.tableRole === "table" ? [] : alignBlock(block.node, block.source);
    segmentCache.set(block.node, { source: block.source, paperSpans, segments });
    return segments;
  }

  /** A body offset inside `block` as an offset of the host's text. */
  private textOffset(block: Block, relative: number): number {
    return block.textFrom + relative + (this.crlf ? countNewlines(block.source, 0, relative) : 0);
  }

  /** A text offset inside `block` as an offset into its source; mid-CRLF resolves to the line end. */
  private relativeOffset(block: Block, offset: number): number {
    const delta = offset - block.textFrom;
    if (!this.crlf) return delta;
    let text = 0;
    let relative = 0;
    while (text < delta && relative < block.source.length) {
      text += block.source.charCodeAt(relative) === 10 ? 2 : 1;
      if (text > delta) break;
      relative += 1;
    }
    return relative;
  }

  /**
   * The text offset of document position `pos`, or null where it has no
   * exact place in the Markdown. Where formatting changes at `pos`, the offset
   * is before the next run's markup (`after`, for a caret or a range start)
   * or after the previous run's text (`before`, for a range end).
   */
  positionToOffset(pos: number, bias: Bias = "after"): number | null {
    const block = this.blockAtPosition(pos);
    if (!block) return null;
    const relative = pos - block.pos;
    if (relative === 0) return block.textFrom;
    if (relative === block.node.nodeSize) return block.textTo;
    const source = block.node.type.spec.tableRole === "table"
      ? tablePositionToSource(block.node, block.source, relative)
      : positionInSegments(this.segments(block), relative, bias);
    return source == null ? null : this.textOffset(block, source);
  }

  /** The (row, column) of document position `pos`, or null where it has none. */
  positionToRowColumn(pos: number): [number, number] | null {
    const block = this.blockAtPosition(pos);
    if (!block) return null;
    const relative = pos - block.pos;
    const source = relative === 0 ? 0
      : relative === block.node.nodeSize ? block.source.length
        : block.node.type.spec.tableRole === "table" ? tablePositionToSource(block.node, block.source, relative)
          : positionInSegments(this.segments(block), relative);
    if (source == null) return null;
    const lineStart = block.source.lastIndexOf("\n", source - 1);
    const row = block.row + countNewlines(block.source, 0, source);
    return [row, lineStart >= 0 ? source - lineStart - 1 : block.column + source];
  }

  /** The document position at text offset `offset`, or null where nothing shown sits there. */
  offsetToPosition(offset: number, snap: Snap = "exact"): number | null {
    const block = this.blockAtOffset(offset);
    if (!block) return null;
    return this.relativeToPosition(block, this.relativeOffset(block, offset), snap);
  }

  /** The document position at source (row, column), or null where nothing shown sits there. */
  rowColumnToPosition(row: number, column: number): number | null {
    const block = this.blockAtRow(row);
    if (!block) return null;
    let lineStart = 0;
    for (let line = block.row; line < row; line += 1) lineStart = block.source.indexOf("\n", lineStart) + 1;
    const relative = lineStart + column - (row === block.row ? block.column : 0);
    const lineEnd = block.source.indexOf("\n", lineStart);
    if (relative < lineStart || relative > (lineEnd < 0 ? block.source.length : lineEnd)) return null;
    return this.relativeToPosition(block, relative, "exact");
  }

  private relativeToPosition(block: Block, relative: number, snap: Snap): number | null {
    // Never between the halves of a surrogate pair.
    const safe = relative > 0 && isHighSurrogate(block.source.charCodeAt(relative - 1)) ? relative - 1 : relative;
    const inside = block.node.type.spec.tableRole === "table"
      ? tableSourceToPosition(block.node, block.source, safe, block.node.attrs.layout === "explicit", snap)
      : sourceInSegments(this.segments(block), safe, snap);
    return inside == null ? null : block.pos + inside;
  }

  /** The text range of the top-level node at `child`, when it is mapped. */
  blockRange(child: number): { from: number; to: number; row: number } | null {
    const block = this.byChild.get(child);
    return block ? { from: block.textFrom, to: block.textTo, row: block.row } : null;
  }

  /** Every mapped top-level node, with its 1-based source line and text range (R-SRC-11). */
  labels(): { pos: number; line: number; from: number; to: number }[] {
    return this.blocks.map((block) => ({ pos: block.pos, line: block.row + 1, from: block.textFrom, to: block.textTo }));
  }
}

/** Where each inline piece of `node` sits in `source`, block-relative on both sides. */
function alignBlock(node: PmNode, source: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = startCursor(node, source);
  const find = (piece: string, pmFrom: number, pmTo: number, exact: boolean) => {
    if (!piece) return;
    const at = source.indexOf(piece, cursor);
    if (at < 0) {
      // Inline code wrapped across lines reads its line breaks as spaces.
      if (exact && piece.includes(" ")) {
        const flexible = wrappedOffsets(piece, source, cursor);
        if (flexible) {
          segments.push({ pmFrom, pmTo, from: flexible[0]!, to: flexible[flexible.length - 1]!, exact: false, offsets: flexible });
          cursor = flexible[flexible.length - 1]!;
        }
      }
      return;
    }
    segments.push({ pmFrom, pmTo, from: at, to: at + piece.length, exact });
    cursor = at + piece.length;
  };
  // The link the previous piece was in: its closing syntax comes before the next piece outside it.
  let link: Mark | null = null;
  const visit = (parent: PmNode, base: number) => {
    parent.forEach((child, offset) => {
      const pos = base + offset;
      const inLink = child.marks.find((mark) => mark.type.name === "link") ?? null;
      if (link && !(inLink && link.eq(inLink))) cursor = linkEnd(source, cursor, link.attrs.autolink);
      link = inLink;
      if (child.isText) {
        const text = child.text ?? "";
        const authored = child.marks.find((mark) => mark.type.name === "latticeSource")?.attrs.source as string | undefined;
        if (authored != null && authored !== text) {
          const before = segments.length;
          find(authored, pos, pos + text.length, false);
          const segment = segments.length > before ? segments[segments.length - 1]! : null;
          if (segment) segment.offsets = escapedOffsets(text, authored)?.map((offset) => segment.from + offset);
        } else if (text.includes("\n")) {
          // Code and raw source: line by line, so indentation and container prefixes between lines are skipped.
          let lineStart = 0;
          for (const line of text.split("\n")) {
            find(line, pos + lineStart, pos + lineStart + line.length, true);
            lineStart += line.length + 1;
          }
        } else {
          find(text, pos, pos + text.length, true);
        }
        return;
      }
      if (child.isLeaf || child.isAtom) {
        const piece = leafSource(child);
        if (piece != null) find(piece, pos, pos + child.nodeSize, false);
        return;
      }
      // A nested block: its own syntax comes first.
      if (child.isBlock) cursor = Math.max(cursor, nestedStart(child, source, cursor));
      visit(child, pos + 1);
    });
  };
  visit(node, 1);
  return segments;
}

/**
 * Where a link's source ends, from `cursor` after its text: past `>` for an
 * angle autolink, nowhere further for a literal one, and past
 * `](destination "title")` for an inline link. The end of `source` when that
 * syntax cannot be read, so nothing after it is misplaced.
 */
function linkEnd(source: string, cursor: number, autolink: unknown): number {
  if (autolink === "literal") return cursor;
  if (autolink === "angle") {
    const close = source.indexOf(">", cursor);
    return close < 0 ? source.length : close + 1;
  }
  const open = source.indexOf("](", cursor);
  if (open < 0) return source.length;
  let at = open + 2;
  // Spaces, and a line break with the container prefix of the next line.
  const skipSpace = () => {
    while (at < source.length && /[ \t\n]/.test(source[at]!)) {
      at += 1;
      if (source[at - 1] === "\n") while (at < source.length && /[ \t>]/.test(source[at]!)) at += 1;
    }
  };
  // Up to `close`, stepping over backslash escapes.
  const skipTo = (close: string) => {
    while (at < source.length && source[at] !== close) at += source[at] === "\\" ? 2 : 1;
    at += 1;
  };
  skipSpace();
  if (source[at] === "<") {
    at += 1;
    skipTo(">");
  } else {
    for (let depth = 0; at < source.length; at += 1) {
      const char = source[at]!;
      if (char === "\\") at += 1;
      else if (/\s/.test(char) || (char === ")" && depth === 0)) break;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    }
  }
  skipSpace();
  const closer = ({ '"': '"', "'": "'", "(": ")" } as Record<string, string>)[source[at] ?? ""];
  if (closer) {
    at += 1;
    skipTo(closer);
    skipSpace();
  }
  return source[at] === ")" ? at + 1 : source.length;
}

/**
 * For a text run and the source it was written as (backslash escapes and
 * character references), the source offset of each position of the text;
 * null when the two do not line up that way.
 */
function escapedOffsets(text: string, source: string): number[] | null {
  const offsets: number[] = [];
  let at = 0;
  for (let index = 0; index < text.length;) {
    offsets.push(at);
    const char = text[index]!;
    const reference = source[at] === "&" ? referenceAt(source, at) : null;
    if (reference && text.startsWith(reference.value, index)) {
      // A reference stands for its characters; positions inside them have no source of their own.
      for (let extra = 1; extra < reference.value.length; extra += 1) offsets.push(at);
      index += reference.value.length;
      at = reference.end;
    } else if (source[at] === char) {
      index += 1;
      at += 1;
    } else if (source[at] === "\\" && source[at + 1] === char) {
      index += 1;
      at += 2;
    } else {
      return null;
    }
  }
  offsets.push(at);
  return at === source.length ? offsets : null;
}

/**
 * For text whose spaces the source may write as a line break and indentation
 * (a wrapped code span), the source offset of each position of the text,
 * found from `cursor`; null when it is not there that way.
 */
function wrappedOffsets(text: string, source: string, cursor: number): number[] | null {
  const pattern = text.split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const match = new RegExp(pattern, "g");
  match.lastIndex = cursor;
  const found = match.exec(source);
  if (!found) return null;
  const offsets: number[] = [];
  let at = found.index;
  for (const char of text) {
    for (let unit = 0; unit < char.length; unit += 1) offsets.push(at + unit);
    if (char === " ") while (/\s/.test(source[at + 1] ?? "") && at + 1 < found.index + found[0].length) at += 1;
    at += char.length;
  }
  offsets.push(at);
  return offsets;
}

/** The character reference (`&amp;`, `&#35;`, `&#x1F600;`) starting at `at`, with what it stands for. */
function referenceAt(source: string, at: number): { value: string; end: number } | null {
  const match = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/.exec(source.slice(at, at + 40));
  if (!match) return null;
  const [whole, decimal, hex, name] = match;
  let value: string | false;
  if (name) {
    value = decodeNamedCharacterReference(name);
  } else {
    const code = decimal ? Number(decimal) : Number.parseInt(hex!, 16);
    value = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
  }
  return value ? { value, end: at + whole.length } : null;
}

/** Where a top-level block's content can start in its source: after its own opening syntax. */
function startCursor(node: PmNode, source: string): number {
  switch (node.type.name) {
    case "heading":
      return node.attrs.setext ? 0 : (ATX_OPEN.exec(source)?.[0].length ?? 0);
    case "codeBlock":
      return CODE_FENCE.test(source) ? source.indexOf("\n") + 1 || source.length : 0;
    case "latticeComponent":
      return typeof node.attrs.openTag === "string" && source.startsWith(node.attrs.openTag) ? node.attrs.openTag.length : 0;
    case "latticeFootnote":
      return FOOTNOTE_OPEN.exec(source)?.[0].length ?? 0;
    default:
      return 0;
  }
}

/** A nested block's content start, searching from `cursor`. */
function nestedStart(node: PmNode, source: string, cursor: number): number {
  if (node.type.name === "codeBlock") {
    const fence = /(^|\n)[ \t>]*(`{3,}|~{3,})[^\n]*\n/g;
    fence.lastIndex = cursor;
    const match = fence.exec(source);
    return match && source.slice(cursor, match.index).trim() === "" ? match.index + match[0].length : cursor;
  }
  if (node.type.name === "heading" && !node.attrs.setext) {
    const marker = /#{1,6}(?:[ \t]+|$)/g;
    marker.lastIndex = cursor;
    const match = marker.exec(source);
    return match ? match.index + match[0].length : cursor;
  }
  if (node.type.name === "latticeComponent" && typeof node.attrs.openTag === "string") {
    const at = source.indexOf(node.attrs.openTag, cursor);
    return at >= 0 ? at + node.attrs.openTag.length : cursor;
  }
  return cursor;
}

/** The Markdown an inline atom was written as, when the engine knows it. */
function leafSource(node: PmNode): string | null {
  const attrs = node.attrs as Record<string, unknown>;
  if (typeof attrs.source === "string" && attrs.source) return attrs.source;
  switch (node.type.name) {
    case "latticeSoftBreak":
      return "\n";
    case "hardBreak":
      return typeof attrs.markup === "string" && attrs.markup.includes("\\") ? "\\\n" : "\n";
    case "latticeMath":
      return `$${String(attrs.tex ?? "")}$`;
    case "latticeWikiLink":
      return `[[${String(attrs.target ?? "")}]]`;
    case "latticeFootnoteReference":
      return `[^${String(attrs.label ?? "")}]`;
    default:
      return null;
  }
}

/**
 * A block-relative document position as a block-relative source offset. At a
 * boundary between two pieces (where formatting changes), the position is the
 * start of the next piece, so it sits on the character after it.
 */
function positionInSegments(segments: readonly Segment[], relative: number, bias: Bias = "after"): number | null {
  let ending: Segment | null = null;
  for (const segment of segments) {
    if (relative < segment.pmFrom) break;
    if (relative > segment.pmTo) continue;
    if (relative === segment.pmTo && segment.pmTo > segment.pmFrom) {
      if (bias === "before") return offsetInSegment(segment, relative);
      ending = segment;
      continue;
    }
    return offsetInSegment(segment, relative);
  }
  return ending ? offsetInSegment(ending, relative) : null;
}

function offsetInSegment(segment: Segment, relative: number): number | null {
  if (segment.exact) return segment.from + (relative - segment.pmFrom);
  if (segment.offsets) {
    const offset = segment.offsets[relative - segment.pmFrom]!;
    // Inside a surrogate pair written as one reference there is no place.
    return relative > segment.pmFrom && offset === segment.offsets[relative - segment.pmFrom - 1] ? null : offset;
  }
  if (relative === segment.pmFrom) return segment.from;
  if (relative === segment.pmTo) return segment.to;
  return null;
}

/** A block-relative source offset as a block-relative document position. */
function sourceInSegments(segments: readonly Segment[], offset: number, snap: Snap): number | null {
  let previous: Segment | null = null;
  for (const [index, segment] of segments.entries()) {
    if (offset < segment.from) return snap === "forward" ? segment.pmFrom : snap === "backward" && previous ? previous.pmTo : null;
    // Where two pieces touch, the offset belongs to the start of the next one (as positions do).
    if (offset === segment.to && segments[index + 1]?.from === offset) {
      previous = segment;
      continue;
    }
    if (offset <= segment.to) {
      if (segment.exact) return segment.pmFrom + (offset - segment.from);
      const index = segment.offsets?.indexOf(offset) ?? -1;
      if (index >= 0) return segment.pmFrom + index;
      if (segment.offsets) {
        // Inside an escape or a reference: the character it writes.
        const after = segment.offsets.findIndex((candidate) => candidate > offset);
        return snap === "forward" ? segment.pmFrom + after : snap === "backward" ? segment.pmFrom + after - 1 : null;
      }
      if (offset === segment.from) return segment.pmFrom;
      if (offset === segment.to) return segment.pmTo;
      return snap === "forward" ? segment.pmTo : snap === "backward" ? segment.pmFrom : null;
    }
    previous = segment;
  }
  return snap === "backward" && previous ? previous.pmTo : null;
}

/** The table's source rows (header, delimiter, body…) with each cell's content range, block-relative. */
function tableRows(source: string, rowCount: number): { cells: { from: number; to: number }[] }[] | null {
  const lines: { from: number; text: string }[] = [];
  let from = 0;
  for (const text of source.split("\n")) {
    lines.push({ from, text });
    from += text.length + 1;
  }
  // The table is the block's last rows; a layout comment may come before it.
  const tableLines = lines.filter((line) => line.text.trim() !== "").slice(-(rowCount + 1));
  if (tableLines.length !== rowCount + 1) return null;
  return tableLines.map(({ from: lineFrom, text }) => {
    const cells: { from: number; to: number }[] = [];
    const leading = /^\s*\|/.exec(text);
    let start = leading ? leading[0].length : 0;
    let index = start;
    while (index <= text.length) {
      const char = text[index];
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "|" || index === text.length) {
        const cell = { from: lineFrom + start, to: lineFrom + index };
        if (!(index === text.length && text.slice(start).trim() === "" && cells.length)) cells.push(cell);
        start = index + 1;
      }
      index += 1;
    }
    return { cells };
  });
}

/** The table cell at grid (row, column): the cell, its table-relative position, and whether a span covers it. */
function tableCell(table: PmNode, map: TableMap, row: number, column: number) {
  const cellOffset = map.map[row * map.width + column];
  if (cellOffset == null) return null;
  const cell = table.nodeAt(cellOffset);
  if (!cell) return null;
  const rect = map.findCell(cellOffset);
  return { cell, pos: 1 + cellOffset, covered: rect.left !== column || rect.top !== row };
}

function tablePositionToSource(table: PmNode, source: string, relative: number): number | null {
  const map = TableMap.get(table);
  const rows = tableRows(source, map.height);
  if (!rows) return null;
  const $pos = table.resolve(relative - 1);
  let depth = $pos.depth;
  while (depth > 0 && !String($pos.node(depth).type.spec.tableRole ?? "").includes("cell")) depth -= 1;
  if (depth <= 0) return null;
  const cellOffset = $pos.before(depth);
  const rect = map.findCell(cellOffset);
  const sourceRow = rows[rect.top === 0 ? 0 : rect.top + 1];
  const range = sourceRow?.cells[rect.left];
  if (!range) return null;
  const cell = $pos.node(depth);
  const segments = alignBlock(cell, source.slice(range.from, range.to));
  const inside = positionInSegments(segments, relative - 1 - cellOffset);
  return inside == null ? null : range.from + inside;
}

function tableSourceToPosition(table: PmNode, source: string, offset: number, explicit: boolean, snap: Snap): number | null {
  const map = TableMap.get(table);
  const rows = tableRows(source, map.height);
  if (!rows) return null;
  for (const [sourceRow, row] of rows.entries()) {
    const index = row.cells.findIndex((cell) => offset >= cell.from - 1 && offset <= cell.to);
    if (index < 0) continue;
    const range = row.cells[index]!;
    if (index >= map.width) return null;
    // The delimiter row anchors in its header cell.
    const target = tableCell(table, map, sourceRow <= 1 ? 0 : sourceRow - 1, index);
    if (!target) return null;
    // Inside the cell's paragraph: past the cell's and the paragraph's openings.
    const start = target.pos + 2;
    if (sourceRow === 1) return start;
    // A cell merged away: its origin for an authored layout; omitted for an inferred one.
    if (target.covered) return explicit ? start : null;
    const segments = alignBlock(target.cell, source.slice(range.from, range.to));
    const inside = sourceInSegments(segments, Math.max(0, offset - range.from), snap);
    return inside == null ? (snap === "exact" ? null : start) : target.pos + inside;
  }
  return null;
}
