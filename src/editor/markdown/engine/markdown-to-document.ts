/**
 * mdast → ProseMirror JSON for the visual engine. Every construct is either
 * modelled completely (its content and the style it was written in) or kept as
 * verbatim source: a block the engine cannot model becomes a raw block, an
 * inline construct a raw inline atom. Nothing is approximated.
 *
 * Some Markdown only shows its shape across several mdast nodes, so a list of
 * sibling blocks is first grouped into ranges (`documentBlocks`): an MDX
 * component with everything up to its closing tag, a table-layout comment with
 * the table it describes, and a `\[ … \]` display formula that CommonMark
 * reads as a paragraph (or, with a lone `=` line, as a setext heading).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { JSONContent } from "@tiptap/core";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { Code, List, ListItem, PhrasingContent, RootContent, Table } from "mdast";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { ANCHOR_SOURCE, type RawBlockKind } from "./engine-schema";
import {
  CALLOUT, COMPONENTS_WITH_BODY, MODELLED_COMPONENTS, findClosingTag, readOpenTag, type ComponentProp,
} from "./mdx-components";
import { inferPaperSpans, looksLikeLayoutMarker, readLayoutMarker, spansFit, type Span } from "./table-spans";

/** Thrown inside a block the engine cannot model; the block is kept raw. */
class Unmodelled extends Error {}

type Mark = NonNullable<JSONContent["marks"]>[number];

export type ParseOptions = {
  /** Infer merged cells from repeated labels (paper reading mode, R-BLK-11). */
  paperSpans: boolean;
  /** Parse a component's body, a nested run of blocks, into node JSON. */
  parseBody: (body: string) => JSONContent[];
  /** The meaning of a table cell's content, to compare cells for spans. */
  cellKey: (paragraph: JSONContent) => string;
};

type Context = ParseOptions & {
  /** The Markdown the mdast positions index into. */
  source: string;
  /** Inside a blockquote or list, where source lines carry container prefixes. */
  nested: boolean;
};

/**
 * Only the position is read structurally. (Typed loosely on purpose: other
 * code in the project augments mdast's node unions with its own node types.)
 */
type Positioned = { position?: { start: { offset?: number }; end: { offset?: number } } };

const start = (node: Positioned) => node.position?.start.offset;
const end = (node: Positioned) => node.position?.end.offset;

function sliceOf(node: Positioned, context: { source: string }): string {
  const from = start(node);
  const to = end(node);
  if (from == null || to == null) throw new Unmodelled();
  return context.source.slice(from, to);
}

export const rawBlock = (kind: RawBlockKind, source: string): JSONContent => (
  source ? { type: "latticeRawBlock", attrs: { kind }, content: [{ type: "text", text: source }] } : { type: "latticeRawBlock", attrs: { kind } }
);

/** A top-level (or component-body) block: where it sits in the source, and its node. */
export type BlockRange = { from: number; to: number; json: JSONContent };

/**
 * Group sibling mdast blocks into ranges, one node each. `source` is what the
 * positions index into; `limit` is where the real text ends (anything after it
 * was appended only as parsing context).
 */
export function documentBlocks(children: RootContent[], source: string, limit: number, options: ParseOptions): BlockRange[] {
  const context: Context = { ...options, source, nested: false };
  const ranges: BlockRange[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const from = start(child);
    const to = end(child);
    // Every parsed block carries a position; one that does not fails the open.
    if (from == null || to == null) throw new Error();
    if (from >= limit) break;
    const component = componentRange(children, index, context);
    if (component) {
      ranges.push({ from, to: component.to, json: component.json });
      index = component.last;
      continue;
    }
    const table = layoutTableRange(children, index, context);
    if (table) {
      ranges.push({ from, to: table.to, json: table.json });
      index += 1;
      continue;
    }
    const display = displayMathRange(children, index, context);
    if (display) {
      ranges.push({ from, to: display.to, json: display.json });
      index = display.last;
      continue;
    }
    ranges.push({ from, to, json: blockToDocument(child, context) });
  }
  return ranges;
}

/** One block as a node; anything it cannot model becomes raw source. */
function blockToDocument(node: RootContent, context: Context): JSONContent {
  const source = sliceOf(node, context);
  // A converter anchor line is inline HTML, so CommonMark reads it as a paragraph.
  if (node.type === "paragraph" && ANCHOR_SOURCE.test(source)) return rawBlock("anchor", source);
  if (node.type === "html") {
    const image = htmlImage(source);
    if (image) return { type: "paragraph", content: [image] };
    return rawBlock(ANCHOR_SOURCE.test(source) ? "anchor" : /^<[A-Z]/.test(source) ? "component" : "html", source);
  }
  if (node.type === "definition") return rawBlock("definition", source);
  if (node.type === "yaml") return rawBlock("frontmatter", source);
  try {
    return block(node, context);
  } catch (error) {
    if (!(error instanceof Unmodelled)) throw error;
    return rawBlock("unsupported", source);
  }
}

// --- Grouped ranges ---------------------------------------------------------

type GroupedRange = { to: number; last: number; json: JSONContent };

/**
 * An MDX component starting at `children[index]`: its opening tag, and (unless
 * self-closing) everything up to the closing tag that ends one of the
 * following siblings. Modelled components become component nodes whose body
 * is parsed as Markdown; any other component is kept as its source.
 */
function componentRange(children: RootContent[], index: number, context: Context): GroupedRange | null {
  const child = children[index]!;
  if (child.type !== "html" && child.type !== "paragraph") return null;
  const from = start(child)!;
  if (!/^<[A-Z]/.test(context.source.slice(from, from + 2))) return null;
  const open = readOpenTag(context.source, from);
  if (!open) return null;
  let to: number;
  let last = index;
  let inner: string | null = null;
  let closeTag: string | null = null;
  if (open.selfClosing) {
    to = open.end;
    if (context.source.slice(to, end(child)).trim()) return null;
    to = end(child)!;
  } else {
    const close = findClosingTag(context.source, open.name, open.end);
    if (!close) return null;
    while (last < children.length && end(children[last]!)! < close.end) last += 1;
    const owner = children[last];
    // The closing tag has to end a sibling: one that runs past it would be split.
    if (!owner || context.source.slice(close.end, end(owner)).trim()) return null;
    to = end(owner)!;
    inner = context.source.slice(open.end, close.start);
    closeTag = context.source.slice(close.start, to);
  }
  const source = context.source.slice(from, to);
  if (!MODELLED_COMPONENTS.has(open.name) || open.props.some((prop) => prop.kind === "expression")) {
    return { to, last, json: rawBlock("component", source) };
  }
  const openTag = context.source.slice(from, open.end);
  return { to, last, json: componentNode(open.name, open.props, { openTag, closeTag, inner }, context) };
}


function componentNode(
  name: string,
  props: ComponentProp[],
  style: { openTag: string | null; closeTag: string | null; inner: string | null; legacy?: string },
  context: Context,
): JSONContent {
  let content = style.inner ? context.parseBody(style.inner) : [];
  if (!content.length && COMPONENTS_WITH_BODY.has(name)) content = [{ type: "paragraph" }];
  return {
    type: "latticeComponent",
    attrs: {
      name,
      props,
      openTag: style.openTag,
      closeTag: style.closeTag,
      inner: style.inner,
      propsKey: JSON.stringify(props),
      legacy: style.legacy ?? null,
    },
    content,
  };
}

/**
 * A table-layout comment and the table right after it: one table with merged
 * cells. A marker whose spans do not fit the table is not taken; the comment
 * and the table then stay two blocks, the table unmerged (R-BLK-11).
 */
function layoutTableRange(children: RootContent[], index: number, context: Context): GroupedRange | null {
  const marker = children[index]!;
  const table = children[index + 1];
  if (marker.type !== "html" || table?.type !== "table" || !looksLikeLayoutMarker(marker.value)) return null;
  const spans = readLayoutMarker(marker.value);
  if (!spans) return null;
  const between = context.source.slice(end(marker), start(table));
  if (/\n[ \t>]*\n[ \t>]*\n/.test(between)) return null;
  const json = tableNode(table, context, spans);
  return json ? { to: end(table)!, last: index + 1, json } : null;
}

const DISPLAY_OPEN = /^ {0,3}\\\[[ \t]*$/;
/** A whole paragraph that is one `\[…\]` formula on one line: no `\]` inside it (R-RT-21). */
export const SINGLE_LINE_DISPLAY = /^\\\[((?:(?!\\\])[^\n])*)\\\]$/;
const DISPLAY_CLOSE = /(?:^|\n) {0,3}\\\][ \t]*$/;

/**
 * A multi-line `\[` … `\]` display formula (R-RT-21). CommonMark sees a
 * paragraph, or a setext heading when a line of the formula is a lone `=`;
 * the siblings are joined back up to the one ending in `\]`, as long as no
 * blank line intervenes (TeX math cannot hold one either).
 */
function displayMathRange(children: RootContent[], index: number, context: Context): GroupedRange | null {
  const first = children[index]!;
  if (first.type !== "paragraph" && first.type !== "heading") return null;
  const from = start(first)!;
  const firstLineEnd = context.source.indexOf("\n", from);
  if (firstLineEnd < 0 || !DISPLAY_OPEN.test(context.source.slice(from, firstLineEnd))) return null;
  for (let last = index; last < children.length; last += 1) {
    const node = children[last]!;
    if (last > index && /\n[ \t]*\n/.test(context.source.slice(end(children[last - 1]!), start(node)))) return null;
    if (node.type !== "paragraph" && node.type !== "heading") return null;
    const to = end(node)!;
    const source = context.source.slice(from, to);
    if (!DISPLAY_CLOSE.test(source) || source.indexOf("\n") < 0) continue;
    const body = source.slice(source.indexOf("\n") + 1).replace(/\n? {0,3}\\\][ \t]*$/, "");
    return { to, last, json: { type: "latticeMathBlock", attrs: { tex: body, source } } };
  }
  return null;
}

// --- Blocks -----------------------------------------------------------------

function block(node: RootContent, context: Context): JSONContent {
  switch (node.type) {
    case "paragraph": {
      const source = sliceOf(node, context);
      // A whole-paragraph `\[…\]` on one line is a formula (R-RT-21).
      const single = source.match(SINGLE_LINE_DISPLAY);
      if (single) return { type: "paragraph", content: [{ type: "latticeMath", attrs: { tex: single[1], source } }] };
      return withContent({ type: "paragraph" }, inline(node.children, [], context));
    }
    case "heading": {
      const text = sliceOf(node, context);
      return withContent(
        { type: "heading", attrs: { level: node.depth, setext: !/^ {0,3}#/.test(text) } },
        inline(node.children, [], context),
      );
    }
    case "thematicBreak":
      return { type: "horizontalRule", attrs: { markup: sliceOf(node, context) } };
    case "blockquote":
      if (!node.children.length) throw new Unmodelled();
      return { type: "blockquote", content: nestedBlocks(node.children, { ...context, nested: true }) };
    case "list":
      return list(node, context);
    case "code":
      return code(node, context);
    case "math": {
      const source = sliceOf(node, context);
      return { type: "latticeMathBlock", attrs: { tex: node.value, meta: node.meta ?? null, source } };
    }
    case "table":
      return tableNode(node, context, null) ?? (() => { throw new Unmodelled(); })();
    case "footnoteDefinition":
      if (!node.children.length) throw new Unmodelled();
      return { type: "latticeFootnote", attrs: { label: node.label ?? node.identifier }, content: nestedBlocks(node.children, { ...context, nested: true }) };
    case "html": {
      const image = htmlImage(sliceOf(node, context));
      if (image) return { type: "paragraph", content: [image] };
      throw new Unmodelled();
    }
    default:
      // Nested HTML, definitions, and anything else cannot sit inside a modelled container.
      throw new Unmodelled();
  }
}

/** The blocks of a container, with table-layout comments joined to their tables. */
function nestedBlocks(children: RootContent[], context: Context): JSONContent[] {
  const result: JSONContent[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const table = layoutTableRange(children, index, context);
    if (table) {
      result.push(table.json);
      index += 1;
      continue;
    }
    result.push(block(children[index]!, context));
  }
  return result;
}

const withContent = (node: JSONContent, content: JSONContent[]): JSONContent => (content.length ? { ...node, content } : node);

function code(node: Code, context: Context): JSONContent {
  const source = sliceOf(node, context);
  const opening = source.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
  const closing = opening ? source.match(/\n[ \t>]*(`{3,}|~{3,})[ \t]*$/)?.[1] ?? null : null;
  const legacy = legacyCallout(node, source, context);
  if (legacy) return legacy;
  return withContent(
    { type: "codeBlock", attrs: { language: node.lang ?? null, meta: node.meta ?? null, fence: opening, closeFence: closing, indented: opening == null } },
    node.value ? [{ type: "text", text: node.value }] : [],
  );
}

/**
 * A legacy ` ```rw-component callout ` fence: a Callout whose properties and
 * Markdown body are a JSON object (R-FMT-6, §11.12). It keeps its bytes until
 * the Callout is edited, and is then written as MDX.
 */
function legacyCallout(node: Code, source: string, context: Context): JSONContent | null {
  if (node.lang !== "rw-component" || node.meta?.trim() !== "callout" || context.nested) return null;
  let value: unknown;
  try {
    value = JSON.parse(node.value);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const props: ComponentProp[] = [];
  let body = "";
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (name === "content") {
      if (typeof item !== "string") return null;
      body = item;
    } else if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      return null;
    } else if (typeof item === "string") {
      props.push({ name, kind: "string", value: item });
    } else if (typeof item === "boolean") {
      props.push({ name, kind: "boolean", value: item });
    } else if (typeof item === "number" && Number.isFinite(item)) {
      props.push({ name, kind: "number", value: item });
    } else {
      return null;
    }
  }
  const json = componentNode(CALLOUT, props, { openTag: null, closeTag: null, inner: body ? `\n\n${body}\n\n` : null, legacy: source }, context);
  return json;
}

function list(node: List, context: Context): JSONContent {
  const items = node.children;
  const checked = items.map((item) => item.checked);
  const task = checked.some((value) => value != null);
  if (task && (node.ordered || checked.some((value) => value == null))) throw new Unmodelled();
  const markers = items.map((item) => sliceOf(item, context).match(/^(\d{1,9})?([-+*.)])/));
  const first = markers[0];
  if (!first) throw new Unmodelled();
  const nested = { ...context, nested: true };
  const content = items.map((item) => listItem(item, task, nested));
  const spread = Boolean(node.spread);
  if (task) return { type: "taskList", attrs: { bullet: first[2], spread }, content };
  if (!node.ordered) return { type: "bulletList", attrs: { bullet: first[2], spread }, content };
  const second = markers[1]?.[1];
  return {
    type: "orderedList",
    attrs: {
      start: node.start ?? 1,
      delimiter: first[2],
      spread,
      incrementListMarker: second == null || Number(second) !== Number(first[1]),
    },
    content,
  };
}

function listItem(item: ListItem, task: boolean, context: Context): JSONContent {
  const [head, ...rest] = item.children;
  if (head && head.type !== "paragraph") throw new Unmodelled();
  const content = head ? [block(head, context), ...nestedBlocks(rest, context)] : [{ type: "paragraph" }];
  const attrs = task ? { checked: Boolean(item.checked), spread: Boolean(item.spread) } : { spread: Boolean(item.spread) };
  return { type: task ? "taskItem" : "listItem", attrs, content };
}

/**
 * A GFM table as a node, with merged cells from an explicit layout or (paper
 * mode) inferred from repeated labels. Returns null when an explicit layout
 * does not fit, so the caller keeps the comment and the table apart.
 */
function tableNode(node: Table, context: Context, layout: Span[] | null): JSONContent | null {
  const columns = Math.max(...node.children.map((row) => row.children.length));
  const nested = { ...context, nested: true };
  const grid = node.children.map((row) => Array.from({ length: columns }, (_, column) => {
    const cell = row.children[column];
    return withContent({ type: "paragraph" }, cell ? inline(cell.children, [], nested) : []);
  }));
  let spans: Span[] = [];
  let mode: "explicit" | "inferred" | null = null;
  if (layout || context.paperSpans) {
    const keys = grid.map((row) => row.map((paragraph) => context.cellKey(paragraph)));
    if (layout) {
      if (!spansFit(keys, layout)) return null;
      spans = layout;
      mode = "explicit";
    } else {
      spans = inferPaperSpans(keys);
      if (spans.length) mode = "inferred";
    }
  }
  const covered = new Set<string>();
  const origins = new Map<string, Span>();
  for (const span of spans) {
    origins.set(`${span[0]}:${span[1]}`, span);
    for (let row = span[0]; row < span[0] + span[2]; row += 1) {
      for (let column = span[1]; column < span[1] + span[3]; column += 1) {
        if (row !== span[0] || column !== span[1]) covered.add(`${row}:${column}`);
      }
    }
  }
  return {
    type: "table",
    attrs: { align: node.align ?? null, layout: mode },
    content: grid.map((cells, rowIndex) => ({
      type: "tableRow",
      content: cells.flatMap((paragraph, column) => {
        if (covered.has(`${rowIndex}:${column}`)) return [];
        const span = origins.get(`${rowIndex}:${column}`);
        const attrs = span ? { rowspan: span[2], colspan: span[3] } : undefined;
        return [{ type: rowIndex === 0 ? "tableHeader" : "tableCell", ...(attrs ? { attrs } : {}), content: [paragraph] }];
      }),
    })),
  };
}

// --- Inline -----------------------------------------------------------------

function inline(children: PhrasingContent[], marks: Mark[], context: Context): JSONContent[] {
  return children.flatMap((child) => phrasing(child, marks, context));
}

const marked = (node: JSONContent, marks: Mark[]): JSONContent => (marks.length ? { ...node, marks } : node);

function rawInline(node: Positioned, marks: Mark[], context: Context, source = sliceOf(node, context)): JSONContent[] {
  // A multi-line slice inside a container would carry that container's line
  // prefixes; written back inside the container, they would be doubled.
  if (context.nested && source.includes("\n")) throw new Unmodelled();
  return [marked({ type: "latticeRawInline", attrs: { source } }, marks)];
}

function phrasing(node: PhrasingContent, marks: Mark[], context: Context): JSONContent[] {
  switch (node.type) {
    case "text":
      return text(node.value, sliceOf(node, context), marks);
    case "emphasis":
      return inline(node.children, [...marks, { type: "italic", attrs: { marker: context.source.charAt(start(node)!) } }], context);
    case "strong":
      return inline(node.children, [...marks, { type: "bold", attrs: { marker: context.source.slice(start(node)!, start(node)! + 2) } }], context);
    case "delete": {
      const marker = context.source.startsWith("~~", start(node)!) ? "~~" : "~";
      return inline(node.children, [...marks, { type: "strike", attrs: { marker } }], context);
    }
    case "inlineCode":
      if (!node.value) return rawInline(node, marks, context);
      // A code span renders its line endings as spaces (CommonMark 6.1).
      return [{ type: "text", text: node.value.replace(/\r?\n/g, " "), marks: [...marks, { type: "code" }] }];
    case "link": {
      if (!node.children.length) return rawInline(node, marks, context);
      const source = sliceOf(node, context);
      const autolink = source.startsWith("<") ? "angle" : source.startsWith("[") ? null : "literal";
      return inline(node.children, [...marks, { type: "link", attrs: { href: node.url, title: node.title ?? null, autolink } }], context);
    }
    case "image": {
      const source = sliceOf(node, context);
      const attrs = { src: node.url, alt: node.alt ?? null, title: node.title ?? null, width: null, align: null };
      // Inside a container a multi-line source carries the container's line
      // prefixes; such an image is written canonically instead.
      const authored = context.nested && source.includes("\n") ? null : source;
      return [marked({ type: "image", attrs: { ...attrs, source: authored, sourceKey: imageKey(attrs), html: false } }, marks)];
    }
    case "inlineMath":
      return [marked({ type: "latticeMath", attrs: { tex: node.value, source: sliceOf(node, context) } }, marks)];
    case "break": {
      const markup = sliceOf(node, context).replace(/\n$/, "");
      return [marked({ type: "hardBreak", attrs: { markup: markup === "\\" || /^[ ]{2,}$/.test(markup) ? markup : null } }, marks)];
    }
    case "footnoteReference":
      return [marked({ type: "latticeFootnoteReference", attrs: { label: node.label ?? node.identifier } }, marks)];
    case "html": {
      const image = htmlImage(node.value);
      if (image) return [marked(image, marks)];
      return rawInline(node, marks, context, node.value);
    }
    default:
      // Reference links, and anything else inline: kept verbatim.
      return rawInline(node, marks, context);
  }
}

const IMAGE_PROPS = new Set(["src", "alt", "title", "width", "align"]);

/** The meaning of an image's attributes, to tell whether its authored source still describes it. */
export const imageKey = (attrs: { src?: unknown; alt?: unknown; title?: unknown; width?: unknown; align?: unknown }) => JSON.stringify([
  attrs.src ?? "", attrs.alt || null, attrs.title || null, attrs.width ?? null, attrs.align ?? null,
]);

/**
 * An HTML `<img>` with only the attributes Lattice writes (`src`, `alt`,
 * `title`, `width`, `align`) as an image node; any other tag, or an image with
 * other attributes, stays source (R-BLK-3, §11.5).
 */
function htmlImage(source: string): JSONContent | null {
  const trimmed = source.trim();
  if (!/^<img[\s/>]/i.test(trimmed)) return null;
  const tag = readOpenTag(trimmed, 0);
  if (!tag || tag.end !== trimmed.length || tag.name.toLowerCase() !== "img") return null;
  const values: Record<string, string | number | null> = {};
  for (const prop of tag.props) {
    if (!IMAGE_PROPS.has(prop.name) || prop.name in values) return null;
    if (prop.kind === "string") values[prop.name] = prop.value;
    else if (prop.kind === "number" && prop.name === "width" && Number.isInteger(prop.value) && prop.value > 0) values.width = prop.value;
    else return null;
  }
  if (typeof values.width === "string") {
    if (!/^\d+$/.test(values.width)) return null;
    values.width = Number(values.width);
  }
  if (values.align != null && !["left", "center", "right"].includes(String(values.align))) return null;
  const attrs = {
    src: String(values.src ?? ""),
    alt: values.alt == null ? null : String(values.alt),
    title: values.title == null ? null : String(values.title),
    width: (values.width as number | undefined) ?? null,
    align: (values.align as string | undefined) ?? null,
  };
  return { type: "image", attrs: { ...attrs, source: trimmed, sourceKey: imageKey(attrs), html: true } };
}

/**
 * A text node as prose: one text run per source line, separated by soft
 * breaks. A line whose Markdown differs from its text (escapes, character
 * references) carries its authored spelling in a `latticeSource` mark.
 */
function text(value: string, source: string, marks: Mark[]): JSONContent[] {
  const lines = value.split("\n");
  const sources = alignTextSource(value, source);
  const result: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) result.push(marked({ type: "latticeSoftBreak" }, marks));
    if (!line) return;
    const authored = sources?.[index];
    const lineMarks = authored != null && authored !== line
      ? [...marks, { type: "latticeSource", attrs: { source: authored, value: line } }]
      : marks;
    result.push(marked({ type: "text", text: line }, lineMarks));
  });
  return result;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const CHARACTER_REFERENCE = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/;

/**
 * Map a text node's value back onto its source, line by line: which source
 * characters spelled each line of text. Container prefixes and the whitespace
 * a soft break swallows belong to no line. `null` when the two cannot be
 * aligned, in which case the text is written from its value.
 */
function alignTextSource(value: string, source: string): string[] | null {
  const lines: string[] = [];
  let lineStart = 0;
  let i = 0;
  let j = 0;
  while (j < value.length) {
    const expected = value[j]!;
    if (expected === "\n") {
      const lineEnd = i;
      while (source[i] === " " || source[i] === "\t") i += 1;
      if (source[i] !== "\n") return null;
      lines.push(source.slice(lineStart, lineEnd));
      i += 1;
      const next = value[j + 1];
      while ((source[i] === " " || source[i] === "\t" || source[i] === ">") && source[i] !== next) i += 1;
      lineStart = i;
      j += 1;
      continue;
    }
    const current = source[i];
    if (current === "\\" && ASCII_PUNCTUATION.test(source[i + 1] ?? "") && source[i + 1] === expected) {
      i += 2;
      j += 1;
      continue;
    }
    if (current === "&") {
      const reference = source.slice(i).match(CHARACTER_REFERENCE);
      const decoded = reference && (
        reference[1] ? decodeNumericCharacterReference(reference[1], 10)
          : reference[2] ? decodeNumericCharacterReference(reference[2], 16)
            : decodeNamedCharacterReference(reference[3]!)
      );
      if (reference && typeof decoded === "string" && decoded && value.startsWith(decoded, j)) {
        i += reference[0].length;
        j += decoded.length;
        continue;
      }
    }
    if (current !== expected) return null;
    i += 1;
    j += 1;
  }
  if (i !== source.length) return null;
  lines.push(source.slice(lineStart, i));
  return lines;
}
