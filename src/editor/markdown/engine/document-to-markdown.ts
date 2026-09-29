/**
 * ProseMirror → mdast for the visual engine's serializer. Style attributes
 * travel on `data.lattice` so the literal serializer can write each node the
 * way it was authored.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Mark as PmMark, Node as PmNode } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import type { LatticeNodeStyle } from "./markdown-syntax";
import { displayMathTex, imageKey, SINGLE_LINE_DISPLAY } from "./markdown-to-document";
import { writeOpenTag, type ComponentProp } from "./mdx-components";
import { semanticKey } from "./semantic-key";
import { inferPaperSpans, sameSpans, writeLayoutMarker, type Span } from "./table-spans";

/** A minimal mdast node shape; see the note on `Positioned` in markdown-to-document. */
export type MdNode = { type: string; children?: MdNode[]; value?: string; data?: { lattice?: LatticeNodeStyle }; [key: string]: unknown };

export type SerializeOptions = { paperSpans?: boolean };

const styled = (node: MdNode, style: LatticeNodeStyle): MdNode => ({ ...node, data: { lattice: style } });

/** A developer-facing refusal: malformed spans are never written (R-FMT-11). */
// eslint-disable-next-line lingui/no-unlocalized-strings -- an exception message, not interface copy
const MALFORMED_SPANS = "Cannot serialize malformed table spans";

/** Top-level nodes as an mdast root. Empty paragraphs have no Markdown and are dropped. */
export function documentToMarkdownTree(nodes: readonly PmNode[], options: SerializeOptions = {}): MdNode {
  return { type: "root", children: blocks(nodes, options) };
}

function blocks(nodes: readonly PmNode[], options: SerializeOptions): MdNode[] {
  return nodes.filter((node) => !(node.type.name === "paragraph" && node.childCount === 0)).map((node) => block(node, options));
}

function block(node: PmNode, options: SerializeOptions): MdNode {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "paragraph": {
      // A whole-paragraph `\[…\]` formula whose edit no longer fits one line stays display math.
      const only = node.childCount === 1 ? node.firstChild! : null;
      if (only?.type.name === "latticeMath" && SINGLE_LINE_DISPLAY.test(String(only.attrs.source)) && formulaSource(only.attrs, String(only.attrs.tex ?? "")) === undefined) {
        return { type: "math", meta: null, value: String(only.attrs.tex ?? "") };
      }
      return { type: "paragraph", children: phrasing(node) };
    }
    case "heading":
      return styled({ type: "heading", depth: attrs.level, children: phrasing(node) }, { setext: Boolean(attrs.setext) });
    case "blockquote":
      return { type: "blockquote", children: blocks(node.children, options) };
    case "bulletList":
    case "taskList":
      return styled(
        { type: "list", ordered: false, start: null, spread: Boolean(attrs.spread), children: node.children.map((item) => listItem(item, options)) },
        { bullet: String(attrs.bullet ?? "-") },
      );
    case "orderedList":
      return styled(
        { type: "list", ordered: true, start: attrs.start ?? 1, spread: Boolean(attrs.spread), children: node.children.map((item) => listItem(item, options)) },
        { delimiter: String(attrs.delimiter ?? "."), incrementListMarker: attrs.incrementListMarker !== false },
      );
    case "codeBlock":
      return styled(
        { type: "code", lang: attrs.language || null, meta: attrs.meta || null, value: node.textContent },
        { fence: (attrs.fence as string | null) ?? undefined, closeFence: (attrs.closeFence as string | null) ?? undefined, indented: Boolean(attrs.indented) },
      );
    case "horizontalRule":
      return styled({ type: "thematicBreak" }, { markup: (attrs.markup as string | null) ?? undefined });
    case "table":
      return table(node, options);
    case "latticeMathBlock": {
      const tex = String(attrs.tex ?? "");
      return styled({ type: "math", meta: attrs.meta || null, value: tex }, { source: formulaSource(attrs, tex) });
    }
    case "latticeComponent":
      return component(node, options);
    case "latticeFootnote": {
      const label = String(attrs.label ?? "");
      return { type: "footnoteDefinition", identifier: label.toLowerCase(), label, children: blocks(node.children, options) };
    }
    default:
      // Raw blocks, and defensively anything unknown: its text is its Markdown.
      return { type: "html", value: node.textContent };
  }
}

function listItem(node: PmNode, options: SerializeOptions): MdNode {
  const children = blocks(node.children, options);
  const checked = node.type.name === "taskItem" ? Boolean(node.attrs.checked) : null;
  return { type: "listItem", spread: Boolean(node.attrs.spread), checked, children };
}

/** Whether a formula's authored source (with its delimiters) still spells `tex`. */
export function mathSourceMatches(source: string, tex: string): boolean {
  const match = source.match(/^(\$+)([\s\S]*)\1$/) ?? source.match(/^\\\(([\s\S]*)\\\)$/) ?? source.match(/^\\\[([\s\S]*)\\\]$/);
  if (!match) return false;
  const body = match.length === 3 ? match[2]! : match[1]!;
  return body === tex || body.replace(/^\n/, "").replace(/\n$/, "") === tex || body.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "") === tex;
}

/**
 * The source to write a formula with: its authored source while it still
 * spells `tex`; after an edit, a display formula written with `\[`/`\]` keeps
 * those delimiters when the new TeX still reads back there. Otherwise nothing,
 * so the stock form is written: `$…$` inline, `$$…$$` display (R-FMT-12).
 */
function formulaSource(attrs: Record<string, unknown>, tex: string): string | undefined {
  const source = attrs.source;
  if (typeof source !== "string") return undefined;
  if (mathSourceMatches(source, tex)) return source;
  if (SINGLE_LINE_DISPLAY.test(source)) {
    const edited = `\\[${tex}\\]`;
    return SINGLE_LINE_DISPLAY.exec(edited)?.[1] === tex ? edited : undefined;
  }
  if (!/^ {0,3}\\\[[ \t]*\n/.test(source)) return undefined;
  const edited = `\\[\n${tex}\n\\]`;
  return displayMathTex(edited) === tex ? edited : undefined;
}

/**
 * A component as one flow node for the `latticeComponent` handler: the exact
 * opening tag while its properties are unchanged, the exact body while its
 * meaning is unchanged, and the exact legacy fence while nothing changed.
 */
function component(node: PmNode, options: SerializeOptions): MdNode {
  const attrs = node.attrs as Record<string, unknown>;
  const name = String(attrs.name);
  const props = (attrs.props ?? []) as ComponentProp[];
  const propsUnchanged = attrs.propsKey === JSON.stringify(props);
  const bodyUnchanged = attrs.bodyKey != null && attrs.bodyKey === semanticKey(node.children);
  if (propsUnchanged && bodyUnchanged && typeof attrs.legacy === "string") return { type: "latticeRaw", value: attrs.legacy, flow: true };
  const openTag = propsUnchanged && typeof attrs.openTag === "string" ? attrs.openTag : writeOpenTag(name, props);
  const closeTag = typeof attrs.closeTag === "string" ? attrs.closeTag : `</${name}>`;
  const inner = typeof attrs.inner === "string" ? attrs.inner : null;
  if (bodyUnchanged && inner != null) return { type: "latticeComponent", open: openTag, close: closeTag, inner };
  const lead = inner?.match(/^[ \t]*\n(?:[ \t]*\n)?/)?.[0] ?? "\n\n";
  const trail = inner?.match(/\n(?:[ \t]*\n)?[ \t]*$/)?.[0] ?? "\n\n";
  return { type: "latticeComponent", open: openTag, close: closeTag, lead, trail, children: blocks(node.children, options) };
}

/**
 * A table with its merged cells written out: every grid slot a span covers
 * repeats the origin cell, and the spans go into a layout comment above the
 * table unless they are exactly what paper inference would read back
 * (R-FMT-10, R-FMT-13).
 */
function table(node: PmNode, options: SerializeOptions): MdNode {
  let map: TableMap;
  try {
    map = TableMap.get(node);
  } catch {
    throw new Error(MALFORMED_SPANS);
  }
  if (map.problems?.length) throw new Error(MALFORMED_SPANS);
  const spans: Span[] = [];
  const slots: PmNode[][] = [];
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row += 1) {
    const cells: PmNode[] = [];
    for (let col = 0; col < map.width; col += 1) {
      const position = map.map[row * map.width + col]!;
      const cell = node.nodeAt(position)!;
      cells.push(cell);
      if (seen.has(position)) continue;
      seen.add(position);
      const rowspan = Number(cell.attrs.rowspan ?? 1);
      const colspan = Number(cell.attrs.colspan ?? 1);
      if (rowspan > 1 || colspan > 1) spans.push([row, col, rowspan, colspan]);
    }
    slots.push(cells);
  }
  const keys = slots.map((cells) => cells.map((cell) => (cell.firstChild?.childCount ? semanticKey([cell.firstChild]) : "")));
  const inferred = options.paperSpans ? inferPaperSpans(keys) : [];
  const layout = node.attrs.layout as string | null;
  let marker: string | undefined;
  if (spans.length) {
    if (layout === "explicit" || !options.paperSpans || !sameSpans(inferred, spans)) marker = writeLayoutMarker(spans);
  } else if (layout === "explicit" || inferred.length) {
    marker = writeLayoutMarker([]);
  }
  return styled({
    type: "table",
    align: node.attrs.align ?? null,
    children: slots.map((cells) => ({
      type: "tableRow",
      children: cells.map((cell) => ({ type: "tableCell", children: cell.firstChild ? phrasing(cell.firstChild) : [] })),
    })),
  }, { layoutMarker: marker });
}

/** One inline node flattened: its mdast form, its formatting marks, and its authored-source mark. */
type Leaf = { node: MdNode; marks: readonly PmMark[]; source?: PmMark };

/** Inline content: flatten to leaves carrying their marks, then nest marks back into mdast parents. */
function phrasing(parent: PmNode): MdNode[] {
  return nest(collapseSourceRuns(leaves(parent)), []);
}

const FORMAT_MARKS = new Set(["bold", "italic", "strike", "link"]);

function leaves(parent: PmNode): Leaf[] {
  const result: Leaf[] = [];
  parent.forEach((child) => {
    const marks = child.marks.filter((mark) => FORMAT_MARKS.has(mark.type.name));
    const source = child.marks.find((mark) => mark.type.name === "latticeSource");
    const attrs = child.attrs as Record<string, unknown>;
    let node: MdNode;
    switch (child.type.name) {
      case "text":
        node = child.marks.some((mark) => mark.type.name === "code")
          ? { type: "inlineCode", value: child.text ?? "" }
          : { type: "text", value: child.text ?? "", data: { lattice: { pieces: [{ value: child.text ?? "" }] } } };
        break;
      case "latticeSoftBreak":
        node = { type: "text", value: "\n", data: { lattice: { pieces: [{ value: "\n" }] } } };
        break;
      case "hardBreak":
        node = styled({ type: "break" }, { markup: (attrs.markup as string | null) ?? undefined });
        break;
      case "image":
        node = image(attrs);
        break;
      case "latticeMath": {
        const tex = String(attrs.tex ?? "");
        node = styled({ type: "inlineMath", value: tex }, { source: formulaSource(attrs, tex) });
        break;
      }
      case "latticeFootnoteReference": {
        const label = String(attrs.label ?? "");
        node = { type: "footnoteReference", identifier: label.toLowerCase(), label };
        break;
      }
      default:
        node = { type: "latticeRaw", value: String(attrs.source ?? child.textContent) };
    }
    result.push({ node, marks, source: node.type === "text" ? source : undefined });
  });
  return result;
}

/**
 * An image: its authored source while it still reads the same, else an HTML
 * `<img>` once it has a width or alignment (or was written as HTML), else a
 * Markdown image.
 */
function image(attrs: Record<string, unknown>): MdNode {
  if (typeof attrs.source === "string" && attrs.sourceKey === imageKey(attrs)) return { type: "latticeRaw", value: attrs.source };
  const width = typeof attrs.width === "number" && attrs.width > 0 ? Math.round(attrs.width) : null;
  if (!attrs.html && width == null && !attrs.align) {
    return { type: "image", url: attrs.src ?? "", alt: attrs.alt ?? "", title: attrs.title ?? null };
  }
  const props: ComponentProp[] = [{ name: "src", kind: "string", value: String(attrs.src ?? "") }];
  if (attrs.alt) props.push({ name: "alt", kind: "string", value: String(attrs.alt) });
  if (attrs.title) props.push({ name: "title", kind: "string", value: String(attrs.title) });
  if (width != null) props.push({ name: "width", kind: "number", value: width });
  if (attrs.align) props.push({ name: "align", kind: "string", value: String(attrs.align) });
  return { type: "latticeRaw", value: writeOpenTag("img", props, true) };
}

/**
 * A `latticeSource` mark still describes its run only when the run's text is
 * exactly the value it was parsed from and the run sits under one set of
 * formatting marks; otherwise the run is written from its text.
 */
function collapseSourceRuns(input: Leaf[]): Leaf[] {
  const output: Leaf[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const leaf = input[index]!;
    const mark = leaf.source;
    if (!mark) {
      output.push(leaf);
      continue;
    }
    let last = index;
    while (last + 1 < input.length && input[last + 1]!.source?.eq(mark)) last += 1;
    const run = input.slice(index, last + 1);
    const value = run.map((item) => item.node.value).join("");
    const uniform = run.every((item) => PmMarkSet.same(item.marks, leaf.marks));
    if (uniform && value === mark.attrs.value) {
      output.push({ node: { type: "text", value, data: { lattice: { pieces: [{ value, source: String(mark.attrs.source) }] } } }, marks: leaf.marks });
    } else {
      output.push(...run);
    }
    index = last;
  }
  return output;
}

const PmMarkSet = {
  same: (left: readonly PmMark[], right: readonly PmMark[]) => left.length === right.length && left.every((mark, index) => mark.eq(right[index]!)),
  has: (marks: readonly PmMark[], mark: PmMark) => marks.some((candidate) => candidate.eq(mark)),
};

function wrapper(mark: PmMark, children: MdNode[]): MdNode {
  const attrs = mark.attrs as Record<string, unknown>;
  switch (mark.type.name) {
    case "bold": return styled({ type: "strong", children }, { marker: String(attrs.marker ?? "**") });
    case "italic": return styled({ type: "emphasis", children }, { marker: String(attrs.marker ?? "*") });
    case "strike": return styled({ type: "delete", children }, { marker: String(attrs.marker ?? "~~") });
    default:
      return styled(
        { type: "link", url: String(attrs.href ?? ""), title: (attrs.title as string | null) || null, children },
        { autolink: (attrs.autolink as LatticeNodeStyle["autolink"]) ?? undefined },
      );
  }
}

/** Nest leaves under their marks, opening the mark that spans the longest run first. */
function nest(input: Leaf[], open: readonly PmMark[]): MdNode[] {
  const result: MdNode[] = [];
  let index = 0;
  while (index < input.length) {
    const leaf = input[index]!;
    const candidates = leaf.marks.filter((mark) => !PmMarkSet.has(open, mark));
    if (!candidates.length) {
      append(result, leaf.node);
      index += 1;
      continue;
    }
    const spanOf = (mark: PmMark) => {
      let span = 1;
      while (index + span < input.length && PmMarkSet.has(input[index + span]!.marks, mark)) span += 1;
      return span;
    };
    let best = candidates[0]!;
    let bestSpan = spanOf(best);
    for (const mark of candidates.slice(1)) {
      const span = spanOf(mark);
      if (span > bestSpan) {
        best = mark;
        bestSpan = span;
      }
    }
    result.push(wrapper(best, nest(input.slice(index, index + bestSpan), [...open, best])));
    index += bestSpan;
  }
  return result;
}

/** Adjacent text leaves are one mdast text node; adjacent code leaves one inline code span. */
function append(siblings: MdNode[], node: MdNode) {
  const previous = siblings[siblings.length - 1];
  if (previous?.type === "text" && node.type === "text") {
    previous.value = `${previous.value ?? ""}${node.value ?? ""}`;
    previous.data = { lattice: { pieces: [...(previous.data?.lattice?.pieces ?? []), ...(node.data?.lattice?.pieces ?? [])] } };
    return;
  }
  if (previous?.type === "inlineCode" && node.type === "inlineCode") {
    previous.value = `${previous.value ?? ""}${node.value ?? ""}`;
    return;
  }
  siblings.push(node);
}
