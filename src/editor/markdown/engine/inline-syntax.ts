/**
 * Inline syntax the visual engine reads on top of CommonMark and GFM (spec
 * R-FMT-1, R-INL-1, R-INL-6, R-INL-7):
 *
 * - `==highlight==`, as the selection toolbar writes it;
 * - `<u>underline</u>`, the HTML pair that renders as underline everywhere;
 * - `[[Page]]` and `[[Page#heading-slug]]` wiki links;
 * - links to a paper in the project library, which edit as citation chips.
 *
 * CommonMark reads the first three as text or inline HTML, so they are found
 * in the parsed phrasing afterwards, and only where the source spells them
 * literally: an escaped `\==` or `\[\[` stays text.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { PhrasingContent } from "mdast";

type Position = { start: { offset?: number }; end: { offset?: number } };
/** Phrasing as parsed, plus this module's own node kinds. */
export type Phrasing = { type: string; value?: string; children?: Phrasing[]; position?: Position; [key: string]: unknown };

const at = (start: number, end: number): Position => ({ start: { offset: start }, end: { offset: end } });
const startOf = (node: Phrasing) => node.position?.start.offset;
const endOf = (node: Phrasing) => node.position?.end.offset;

/** A library paper's reading file, as a citation links it (R-FMT-17, §11.10). */
export const PAPER_HREF = /^(?:\.\.\/)*\.research\/papers\/[^/\s]+\/(?:paper|blog)\.md$/;

/**
 * The phrasing of one parent, with highlight, underline and wiki links
 * recognized. Nested phrasing is extended when the reader reaches it.
 */
export function extendPhrasing(children: PhrasingContent[], source: string): PhrasingContent[] {
  let nodes = children as unknown as Phrasing[];
  nodes = underlines(nodes);
  nodes = wikiLinks(nodes, source);
  nodes = highlights(nodes, source);
  return nodes as unknown as PhrasingContent[];
}

/** A text node whose source is exactly its value: no escapes or references to misplace offsets. */
function literalText(node: Phrasing, source: string): boolean {
  const from = startOf(node);
  const to = endOf(node);
  return node.type === "text" && from != null && to != null && source.slice(from, to) === node.value;
}

const textPiece = (value: string, start: number): Phrasing => ({ type: "text", value, position: at(start, start + value.length) });

/** `<u>` … `</u>` among one parent's children becomes an underline around them. */
function underlines(nodes: Phrasing[]): Phrasing[] {
  const result: Phrasing[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.type === "html" && /^<u>$/i.test(node.value ?? "")) {
      const close = nodes.findIndex((candidate, position) => position > index && candidate.type === "html" && /^<\/u>$/i.test(candidate.value ?? ""));
      if (close > index + 1) {
        const from = startOf(node);
        const to = endOf(nodes[close]!);
        result.push({ type: "latticeUnderline", children: nodes.slice(index + 1, close), position: from != null && to != null ? at(from, to) : undefined });
        index = close;
        continue;
      }
    }
    result.push(node);
  }
  return result;
}

const WIKI = /\[\[([^[\]\n|]+)\]\]/g;

/** `[[Page]]` in literal text becomes a wiki link. */
function wikiLinks(nodes: Phrasing[], source: string): Phrasing[] {
  const result: Phrasing[] = [];
  for (const node of nodes) {
    if (!literalText(node, source) || !node.value!.includes("[[")) {
      result.push(node);
      continue;
    }
    const value = node.value!;
    const base = startOf(node)!;
    let cursor = 0;
    for (const match of value.matchAll(WIKI)) {
      const target = match[1]!.trim();
      if (!target) continue;
      if (match.index > cursor) result.push(textPiece(value.slice(cursor, match.index), base + cursor));
      result.push({ type: "latticeWiki", target, value: match[0], position: at(base + match.index, base + match.index + match[0].length) });
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) result.push(cursor ? textPiece(value.slice(cursor), base + cursor) : node);
  }
  return result;
}

type Token = { node: Phrasing } | { delimiter: number; before: string; after: string };

/**
 * `==text==` becomes a highlight: an opening `==` followed by a non-space, a
 * closing one after a non-space, neither part of a longer run of `=`.
 */
function highlights(nodes: Phrasing[], source: string): Phrasing[] {
  if (!nodes.some((node) => literalText(node, source) && node.value!.includes("=="))) return nodes;
  const tokens: Token[] = [];
  nodes.forEach((node, index) => {
    if (!literalText(node, source) || !node.value!.includes("==")) {
      tokens.push({ node });
      return;
    }
    const value = node.value!;
    const base = startOf(node)!;
    let cursor = 0;
    for (const match of value.matchAll(/=+/g)) {
      if (match[0].length !== 2) continue;
      if (match.index > cursor) tokens.push({ node: textPiece(value.slice(cursor, match.index), base + cursor) });
      const before = match.index > 0 ? value[match.index - 1]! : nodes[index - 1] ? "x" : "";
      const afterIndex = match.index + 2;
      const after = afterIndex < value.length ? value[afterIndex]! : nodes[index + 1] ? "x" : "";
      tokens.push({ delimiter: base + match.index, before, after });
      cursor = afterIndex;
    }
    if (cursor < value.length) tokens.push({ node: textPiece(value.slice(cursor), base + cursor) });
  });
  const result: Phrasing[] = [];
  let opener = -1;
  const flush = (upTo: number, from: number) => {
    for (let index = from; index < upTo; index += 1) {
      const token = tokens[index]!;
      result.push("node" in token ? token.node : textPiece("==", token.delimiter));
    }
  };
  let emitted = 0;
  tokens.forEach((token, index) => {
    if ("node" in token) return;
    const opens = token.after !== "" && !/\s/.test(token.after);
    const closes = token.before !== "" && !/\s/.test(token.before);
    if (opener >= 0 && closes && index > opener + 1) {
      flush(opener, emitted);
      const open = tokens[opener] as { delimiter: number };
      const inner: Phrasing[] = [];
      for (let position = opener + 1; position < index; position += 1) {
        const item = tokens[position]!;
        inner.push("node" in item ? item.node : textPiece("==", item.delimiter));
      }
      result.push({ type: "latticeHighlight", children: inner, position: at(open.delimiter, token.delimiter + 2) });
      emitted = index + 1;
      opener = -1;
    } else if (opens) {
      opener = index;
    }
  });
  flush(tokens.length, emitted);
  return mergeText(result);
}

/** Adjacent text pieces read as one text node, as the parser gives them. */
function mergeText(nodes: Phrasing[]): Phrasing[] {
  const result: Phrasing[] = [];
  for (const node of nodes) {
    const previous = result[result.length - 1];
    if (previous?.type === "text" && node.type === "text" && endOf(previous) === startOf(node)) {
      result[result.length - 1] = { ...previous, value: `${previous.value}${node.value}`, position: at(startOf(previous)!, endOf(node)!) };
    } else {
      result.push(node);
    }
  }
  return result;
}
