/**
 * ProseMirror → mdast for the visual engine's serializer. Style attributes
 * travel on `data.lattice` so the literal serializer can write each node the
 * way it was authored.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Mark as PmMark, Node as PmNode } from "@tiptap/pm/model";
import type { LatticeNodeStyle } from "./markdown-syntax";

/** A minimal mdast node shape; see the note on `Positioned` in markdown-to-document. */
export type MdNode = { type: string; children?: MdNode[]; value?: string; data?: { lattice?: LatticeNodeStyle }; [key: string]: unknown };

const styled = (node: MdNode, style: LatticeNodeStyle): MdNode => ({ ...node, data: { lattice: style } });

/** Top-level nodes as an mdast root. Empty paragraphs have no Markdown and are dropped. */
export function documentToMarkdownTree(nodes: readonly PmNode[]): MdNode {
  return { type: "root", children: blocks(nodes) };
}

function blocks(nodes: readonly PmNode[]): MdNode[] {
  return nodes.filter((node) => !(node.type.name === "paragraph" && node.childCount === 0)).map(block);
}

function block(node: PmNode): MdNode {
  const attrs = node.attrs as Record<string, unknown>;
  switch (node.type.name) {
    case "paragraph":
      return { type: "paragraph", children: phrasing(node) };
    case "heading":
      return styled({ type: "heading", depth: attrs.level, children: phrasing(node) }, { setext: Boolean(attrs.setext) });
    case "blockquote":
      return { type: "blockquote", children: blocks(node.children) };
    case "bulletList":
    case "taskList":
      return styled(
        { type: "list", ordered: false, start: null, spread: Boolean(attrs.spread), children: node.children.map(listItem) },
        { bullet: String(attrs.bullet ?? "-") },
      );
    case "orderedList":
      return styled(
        { type: "list", ordered: true, start: attrs.start ?? 1, spread: Boolean(attrs.spread), children: node.children.map(listItem) },
        { delimiter: String(attrs.delimiter ?? "."), incrementListMarker: attrs.incrementListMarker !== false },
      );
    case "codeBlock":
      return styled(
        { type: "code", lang: attrs.language || null, meta: attrs.meta || null, value: node.textContent },
        { fence: (attrs.fence as string | null) ?? undefined, indented: Boolean(attrs.indented) },
      );
    case "horizontalRule":
      return styled({ type: "thematicBreak" }, { markup: (attrs.markup as string | null) ?? undefined });
    case "table":
      return {
        type: "table",
        align: attrs.align ?? null,
        children: node.children.map((row) => ({
          type: "tableRow",
          children: row.children.map((cell) => ({ type: "tableCell", children: cell.firstChild ? phrasing(cell.firstChild) : [] })),
        })),
      };
    case "latticeMathBlock":
      return { type: "math", meta: attrs.meta || null, value: node.textContent };
    default:
      // Raw blocks, and defensively anything unknown: its text is its Markdown.
      return { type: "html", value: node.textContent };
  }
}

function listItem(node: PmNode): MdNode {
  const children = blocks(node.children);
  const checked = node.type.name === "taskItem" ? Boolean(node.attrs.checked) : null;
  return { type: "listItem", spread: Boolean(node.attrs.spread), checked, children };
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
        node = { type: "image", url: attrs.src ?? "", alt: attrs.alt ?? "", title: attrs.title ?? null };
        break;
      case "latticeMath": {
        const tex = String(attrs.tex ?? "");
        const source = typeof attrs.source === "string" && attrs.source.replace(/^\$+|\$+$/g, "") === tex ? attrs.source : undefined;
        node = styled({ type: "inlineMath", value: tex }, { source });
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
