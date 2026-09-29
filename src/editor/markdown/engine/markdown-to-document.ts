/**
 * mdast → ProseMirror JSON for the visual engine. Every construct is either
 * modelled completely (its content and the style it was written in) or kept as
 * verbatim source: a block the engine cannot model becomes a raw block, an
 * inline construct a raw inline atom. Nothing is approximated.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { JSONContent } from "@tiptap/core";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { List, ListItem, PhrasingContent, RootContent, Table } from "mdast";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";
import { ANCHOR_SOURCE, type RawBlockKind } from "./engine-schema";

/** Thrown inside a block the engine cannot model; the block is kept raw. */
class Unmodelled extends Error {}

type Mark = NonNullable<JSONContent["marks"]>[number];

type Context = {
  /** The Markdown body the mdast positions index into. */
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

function sliceOf(node: Positioned, context: Context): string {
  const from = start(node);
  const to = end(node);
  if (from == null || to == null) throw new Unmodelled();
  return context.source.slice(from, to);
}

export const rawBlock = (kind: RawBlockKind, source: string): JSONContent => (
  source ? { type: "latticeRawBlock", attrs: { kind }, content: [{ type: "text", text: source }] } : { type: "latticeRawBlock", attrs: { kind } }
);

/** One top-level block as a node; anything it cannot model becomes raw source. */
export function blockToDocument(node: RootContent, source: string): JSONContent {
  const context: Context = { source, nested: false };
  // A converter anchor line is inline HTML, so CommonMark reads it as a paragraph.
  if (node.type === "paragraph" && ANCHOR_SOURCE.test(sliceOf(node, context))) return rawBlock("anchor", sliceOf(node, context));
  const kind = rawKind(node);
  if (kind) {
    const source = sliceOf(node, context);
    if (kind !== "html") return rawBlock(kind, source);
    return rawBlock(ANCHOR_SOURCE.test(source) ? "anchor" : /^<[A-Z]/.test(source) ? "component" : "html", source);
  }
  try {
    return block(node, context);
  } catch (error) {
    if (!(error instanceof Unmodelled)) throw error;
    return rawBlock("unsupported", sliceOf(node, context));
  }
}

function rawKind(node: RootContent): RawBlockKind | null {
  switch (node.type) {
    case "html": return "html";
    case "definition": return "definition";
    case "footnoteDefinition": return "footnote";
    case "yaml": return "frontmatter";
    default: return null;
  }
}

function block(node: RootContent, context: Context): JSONContent {
  switch (node.type) {
    case "paragraph":
      return withContent({ type: "paragraph" }, inline(node.children, [], context));
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
      return { type: "blockquote", content: node.children.map((child) => block(child, { ...context, nested: true })) };
    case "list":
      return list(node, context);
    case "code": {
      const opening = sliceOf(node, context).match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
      return withContent(
        { type: "codeBlock", attrs: { language: node.lang ?? null, meta: node.meta ?? null, fence: opening, indented: opening == null } },
        node.value ? [{ type: "text", text: node.value }] : [],
      );
    }
    case "math":
      return withContent({ type: "latticeMathBlock", attrs: { meta: node.meta ?? null } }, node.value ? [{ type: "text", text: node.value }] : []);
    case "table":
      return table(node, context);
    default: {
      const kind = rawKind(node);
      // Nested HTML or definitions cannot sit inside a modelled container.
      if (kind) throw new Unmodelled();
      throw new Unmodelled();
    }
  }
}

const withContent = (node: JSONContent, content: JSONContent[]): JSONContent => (content.length ? { ...node, content } : node);

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
  const content = head ? [block(head, context), ...rest.map((child) => block(child, context))] : [{ type: "paragraph" }];
  const attrs = task ? { checked: Boolean(item.checked), spread: Boolean(item.spread) } : { spread: Boolean(item.spread) };
  return { type: task ? "taskItem" : "listItem", attrs, content };
}

function table(node: Table, context: Context): JSONContent {
  const columns = Math.max(...node.children.map((row) => row.children.length));
  const nested = { ...context, nested: true };
  return {
    type: "table",
    attrs: { align: node.align ?? null },
    content: node.children.map((row, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: columns }, (_, column) => {
        const cell = row.children[column];
        return {
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [withContent({ type: "paragraph" }, cell ? inline(cell.children, [], nested) : [])],
        };
      }),
    })),
  };
}

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
    case "image":
      return [marked({ type: "image", attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null } }, marks)];
    case "inlineMath":
      return [marked({ type: "latticeMath", attrs: { tex: node.value, source: sliceOf(node, context) } }, marks)];
    case "break": {
      const markup = sliceOf(node, context).replace(/\n$/, "");
      return [marked({ type: "hardBreak", attrs: { markup: markup === "\\" || /^[ ]{2,}$/.test(markup) ? markup : null } }, marks)];
    }
    case "html":
      return rawInline(node, marks, context, node.value);
    default:
      // Footnote and reference links, and anything else inline: kept verbatim.
      return rawInline(node, marks, context);
  }
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
