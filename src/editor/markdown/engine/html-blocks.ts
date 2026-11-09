/**
 * HTML that spans several CommonMark blocks, read as one raw HTML block so the
 * editor can show it as one rendered preview (R-BLK-16).
 *
 * CommonMark ends an HTML block at the first blank line, so a figure written
 *
 *     <div>
 *
 *     <svg …>…</svg>
 *
 *     </div>
 *
 * arrives as three siblings, and a one-line `<svg>…</svg>` (not a block tag)
 * arrives as a paragraph of inline HTML. Rendered apart, none of the pieces is
 * the drawing. An element whose closing tag ends a later sibling is therefore
 * taken whole — but only when every sibling in between is itself HTML, so
 * Markdown between the tags (which CommonMark renders as Markdown) stays
 * editable prose. The bytes are the source slice, so the file is unchanged.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { RootContent } from "mdast";

/** Elements with no closing tag; they never open a nesting level. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** A tag, a comment, or a CDATA section; attribute values may hold `>`. */
const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;

/** How many siblings one element may span before it is left as separate blocks. */
const MAX_SPAN = 400;

type Positioned = { position?: { start: { offset?: number }; end: { offset?: number } } };

/** The first element's lowercase name when `source` opens with a start tag, else null. */
function openingElement(source: string): string | null {
  const match = /^<([a-z][\w:-]*)(?=[\s/>])/.exec(source);
  return match && !VOID_ELEMENTS.has(match[1]!) ? match[1]! : null;
}

/**
 * The nesting depth of `name` after `source`, starting from `depth`, and the
 * offset where it first returns to zero (null while it stays open).
 */
function trackDepth(source: string, name: string, depth: number): { depth: number; closedAt: number | null } {
  TAG.lastIndex = 0;
  for (const match of source.matchAll(TAG)) {
    if (match[2]?.toLowerCase() !== name) continue;
    if (match[1]) depth -= 1;
    else if (!match[4]) depth += 1;
    if (depth === 0) return { depth, closedAt: match.index + match[0].length };
  }
  return { depth, closedAt: null };
}

const sliceOf = (node: Positioned, source: string) => source.slice(node.position!.start.offset!, node.position!.end.offset!);

/**
 * A paragraph that is nothing but HTML: CommonMark read inline tags and the
 * text between them (an SVG's `<text>` labels) but no Markdown.
 */
function htmlParagraph(node: RootContent, source: string): boolean {
  if (node.type !== "paragraph" || !node.children.length) return false;
  return node.children[0]!.type === "html"
    && node.children.every((child) => child.type === "html" || child.type === "text" || child.type === "break")
    && sliceOf(node, source).trimEnd().endsWith(">");
}

/**
 * A paragraph holding exactly one `<svg>` element, from its start tag to the
 * closing tag that ends the paragraph: a drawing, not prose.
 */
export function svgParagraph(node: RootContent, source: string): boolean {
  if (!htmlParagraph(node, source)) return false;
  const text = sliceOf(node, source).trimEnd();
  if (openingElement(text) !== "svg") return false;
  return trackDepth(text, "svg", 0).closedAt === text.length;
}

/**
 * The HTML element opened by `children[index]` (an HTML block) and closed by a
 * later sibling, with only HTML between: the index of the sibling that closes
 * it and where that sibling ends. Null when the block closes itself, the
 * closing tag does not end its sibling, or Markdown sits in between.
 */
export function htmlElementRange(children: readonly RootContent[], index: number, source: string): { last: number; to: number } | null {
  const first = children[index]!;
  if (first.type !== "html") return null;
  const name = openingElement(sliceOf(first, source));
  if (!name) return null;
  let { depth, closedAt } = trackDepth(sliceOf(first, source), name, 0);
  if (closedAt != null) return null;
  for (let last = index + 1; last < children.length && last <= index + MAX_SPAN; last += 1) {
    const sibling = children[last]!;
    if (sibling.type !== "html" && !htmlParagraph(sibling, source)) return null;
    const text = sliceOf(sibling, source);
    ({ depth, closedAt } = trackDepth(text, name, depth));
    if (closedAt == null) continue;
    return text.slice(closedAt).trim() ? null : { last, to: sibling.position!.end.offset! };
  }
  return null;
}
