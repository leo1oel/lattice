/**
 * The round-trip core of Lattice's visual Markdown engine.
 *
 * Opening splits a file into its envelope (BOM, line endings), top-level
 * blocks, and the exact bytes between them. Every block becomes one node, and
 * the baseline remembers which source bytes each node came from. Saving walks
 * the current document against that baseline: a node that still equals its
 * baseline node writes its original bytes, so an untouched file is reproduced
 * byte for byte and an edit changes only the blocks it touched. Changed runs of
 * blocks are serialized, then re-parsed and compared with what the editor
 * shows; a run whose authored-style output would read back differently is
 * written in the escaped `safe` style instead.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import type { RootContent } from "mdast";
import { markdownFrontmatterEnd } from "../../../app-utils";
import { documentToMarkdownTree } from "./document-to-markdown";
import { STYLE_ATTRIBUTES } from "./engine-schema";
import { parseMarkdownTree, stringifyMarkdownTree } from "./markdown-syntax";
import { blockToDocument, rawBlock } from "./markdown-to-document";

/** Beyond this many characters the engine declines a file; source mode handles it. */
export const ENGINE_TEXT_LIMIT = 4_000_000;

export type UnavailableReason = "mixed-line-endings" | "too-large" | "parse-failed";

type Envelope = { bom: boolean; crlf: boolean };

type BaselineEntry = {
  node: PmNode;
  /** The block's exact Markdown (LF line endings). */
  source: string;
  /** Exact bytes between the previous block (or the file start) and this one. */
  gapBefore: string;
};

/** What the last accepted Markdown looked like, block by block. */
export type MarkdownBaseline = {
  envelope: Envelope;
  entries: readonly BaselineEntry[];
  /** Bytes after the last block (or the whole body when there are no blocks). */
  trailing: string;
  /** Link and footnote labels defined anywhere in the file; references depend on them. */
  labels: { links: ReadonlySet<string>; footnotes: ReadonlySet<string> };
};

export type OpenedMarkdown = { doc: PmNode; baseline: MarkdownBaseline };

export type SerializedMarkdown = {
  text: string;
  baseline: MarkdownBaseline;
  /** False when a changed run could not be verified to read back as shown. */
  verified: boolean;
};

function openEnvelope(text: string): { envelope: Envelope; body: string } | null {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  if (!body.includes("\r")) return { envelope: { bom, crlf: false }, body };
  // Every line ending must be CRLF; anything mixed would be rewritten on save.
  if (/\r(?!\n)|(?<!\r)\n/.test(body)) return null;
  return { envelope: { bom, crlf: true }, body: body.replace(/\r\n/g, "\n") };
}

function closeEnvelope(body: string, envelope: Envelope): string {
  return `${envelope.bom ? "\uFEFF" : ""}${envelope.crlf ? body.replace(/\n/g, "\r\n") : body}`;
}

type Labels = { links: Set<string>; footnotes: Set<string> };

function collectLabels(node: { type: string; label?: string | null; children?: unknown[] }, labels: Labels) {
  if (node.type === "definition" && node.label) labels.links.add(node.label);
  if (node.type === "footnoteDefinition" && node.label) labels.footnotes.add(node.label);
  for (const child of (node.children ?? []) as (typeof node)[]) collectLabels(child, labels);
}

/**
 * Definitions appended after a run parsed on its own, so references inside it
 * resolve exactly as they do in the whole file.
 */
function definitionContext(labels: MarkdownBaseline["labels"]): string {
  const lines = [
    ...[...labels.links].map((label) => `[${label}]: #`),
    ...[...labels.footnotes].map((label) => `[^${label}]: .`),
  ];
  return lines.length ? `\n\n${lines.join("\n\n")}\n` : "";
}

const PASCAL_COMPONENT = /^<([A-Z][\w.]*)(?=[\s/>])/;
const TABLE_LAYOUT_MARKER = /^<!--\s*lattice-table-layout:v1\b/;

/** Top-level block ranges; an MDX component and everything up to its closing tag is one range. */
function blockRanges(children: RootContent[]): { from: number; to: number; node: RootContent | null }[] {
  const ranges: { from: number; to: number; node: RootContent | null }[] = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const from = child.position?.start.offset;
    const to = child.position?.end.offset;
    // Every parsed block carries a position; one that does not fails the open.
    if (from == null || to == null) throw new Error();
    const name = child.type === "html" ? child.value.match(PASCAL_COMPONENT)?.[1] : undefined;
    const close = name ? componentClose(children, index, name) : -1;
    if (close > index) {
      ranges.push({ from, to: children[close]!.position!.end.offset!, node: null });
      index = close;
      continue;
    }
    ranges.push({ from, to, node: child });
  }
  return ranges;
}

/** Index of the html block that closes the component opened at `index`, or -1. */
function componentClose(children: RootContent[], index: number, name: string): number {
  const escaped = name.replace(/\./g, "\\.");
  const opens = new RegExp(`<${escaped}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*?(/?)>`, "g");
  const closes = new RegExp(`</${escaped}\\s*>`, "g");
  let depth = 0;
  for (let cursor = index; cursor < children.length; cursor += 1) {
    const child = children[cursor]!;
    if (child.type !== "html") continue;
    for (const match of child.value.matchAll(opens)) if (!match[1]) depth += 1;
    depth -= [...child.value.matchAll(closes)].length;
    if (depth <= 0) return cursor === index ? -1 : cursor;
  }
  return -1;
}

type ParsedBlocks = { entries: BaselineEntry[]; trailing: string; labels: Labels };

/**
 * Parse `body` into baseline entries. `context` is appended for parsing only;
 * `frontmatter` allows a leading frontmatter block (only at the file start).
 */
function parseBlocks(body: string, schema: Schema, context: string, frontmatter: boolean): ParsedBlocks {
  const labels: Labels = { links: new Set(), footnotes: new Set() };
  const entries: BaselineEntry[] = [];
  let cursor = 0;
  const push = (from: number, to: number, json: JSONContent) => {
    entries.push({ node: nodeFromJSON(schema, json, body.slice(from, to)), source: body.slice(from, to), gapBefore: body.slice(cursor, from) });
    cursor = to;
  };
  const frontmatterEnd = frontmatter ? markdownFrontmatterEnd(body) : 0;
  if (frontmatterEnd > 0) {
    const end = body.charAt(frontmatterEnd - 1) === "\n" ? frontmatterEnd - 1 : frontmatterEnd;
    push(0, end, rawBlock("frontmatter", body.slice(0, end)));
  }
  const rest = body.slice(cursor);
  const offset = cursor;
  const tree = parseMarkdownTree(rest + context);
  collectLabels(tree, labels);
  for (const range of blockRanges(tree.children)) {
    if (range.from >= rest.length) break;
    const from = offset + range.from;
    const to = offset + Math.min(range.to, rest.length);
    const previous = entries[entries.length - 1];
    // A table under an explicit span layout is kept verbatim until the engine
    // models spans: editing its cells here could desynchronize the layout.
    const laidOut = range.node?.type === "table" && previous?.node.attrs.kind === "html" && TABLE_LAYOUT_MARKER.test(previous.source);
    const json = !range.node ? rawBlock("component", body.slice(from, to))
      : laidOut ? rawBlock("layout-table", body.slice(from, to))
        : blockToDocument(range.node, rest);
    push(from, to, json);
  }
  return { entries, trailing: body.slice(cursor), labels };
}

function nodeFromJSON(schema: Schema, json: JSONContent, source: string): PmNode {
  try {
    const node = schema.nodeFromJSON(json);
    node.check();
    return node;
  } catch {
    // A modelled block the schema still rejects (content it cannot hold) is kept verbatim.
    return schema.nodeFromJSON(rawBlock("unsupported", source));
  }
}

function emptyDocument(schema: Schema): PmNode {
  return schema.topNodeType.create(null, schema.nodes.paragraph!.create());
}

/** Open Markdown for visual editing, or say why the engine declines it. */
export function openMarkdown(text: string, schema: Schema): OpenedMarkdown | { unavailable: UnavailableReason } {
  if (text.length > ENGINE_TEXT_LIMIT) return { unavailable: "too-large" };
  const opened = openEnvelope(text);
  if (!opened) return { unavailable: "mixed-line-endings" };
  let parsed: ParsedBlocks;
  try {
    parsed = parseBlocks(opened.body, schema, "", true);
  } catch {
    return { unavailable: "parse-failed" };
  }
  const rebuilt = parsed.entries.map((entry) => entry.gapBefore + entry.source).join("") + parsed.trailing;
  if (rebuilt !== opened.body) return { unavailable: "parse-failed" };
  const nodes = parsed.entries.map((entry) => entry.node);
  return {
    doc: nodes.length ? schema.topNodeType.create(null, nodes) : emptyDocument(schema),
    baseline: { envelope: opened.envelope, entries: parsed.entries, trailing: parsed.trailing, labels: parsed.labels },
  };
}

/**
 * Pair each current top-level node with the baseline node it still equals,
 * in order. Common prefix and suffix first; in between, identity (ProseMirror
 * reuses untouched nodes) and then a short structural look-ahead.
 */
function alignBlocks(current: readonly PmNode[], baseline: readonly PmNode[]): number[] {
  const matches = new Array<number>(current.length).fill(-1);
  let prefix = 0;
  while (prefix < current.length && prefix < baseline.length && current[prefix]!.eq(baseline[prefix]!)) {
    matches[prefix] = prefix;
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix && suffix < baseline.length - prefix
    && current[current.length - 1 - suffix]!.eq(baseline[baseline.length - 1 - suffix]!)
  ) {
    matches[current.length - 1 - suffix] = baseline.length - 1 - suffix;
    suffix += 1;
  }
  const baseEnd = baseline.length - suffix;
  const identity = new Map<PmNode, number>();
  for (let index = prefix; index < baseEnd; index += 1) identity.set(baseline[index]!, index);
  let last = prefix - 1;
  for (let index = prefix; index < current.length - suffix; index += 1) {
    const node = current[index]!;
    let found = identity.get(node) ?? -1;
    if (found <= last) {
      found = -1;
      for (let candidate = last + 1; candidate < Math.min(baseEnd, last + 33); candidate += 1) {
        if (node.eq(baseline[candidate]!)) {
          found = candidate;
          break;
        }
      }
    }
    if (found > last) {
      matches[index] = found;
      last = found;
    }
  }
  return matches;
}

/** A separator next to changed content: the authored one when it already holds a blank line. */
const separatorNear = (authored: string | undefined) => (authored != null && /\n[ \t]*\n/.test(authored) ? authored : "\n\n");

/** The document as Markdown, with every block that still equals its baseline written from its original bytes. */
export function serializeMarkdown(doc: PmNode, baseline: MarkdownBaseline): SerializedMarkdown {
  const current = doc.children;
  const base = baseline.entries;
  const matches = alignBlocks(current, base.map((entry) => entry.node));
  const schema = doc.type.schema;
  const labels: Labels = { links: new Set(baseline.labels.links), footnotes: new Set(baseline.labels.footnotes) };
  const entries: BaselineEntry[] = [];
  let verified = true;
  let previousBase = -1;
  let previousWasBase = false;
  let index = 0;
  while (index < current.length) {
    const match = matches[index]!;
    const first = entries.length === 0;
    if (match >= 0) {
      const entry = base[match]!;
      const gapBefore = first ? (base[0]?.gapBefore ?? "") : previousWasBase && match === previousBase + 1 ? entry.gapBefore : separatorNear(entry.gapBefore);
      entries.push({ ...entry, gapBefore });
      previousBase = match;
      previousWasBase = true;
      index += 1;
      continue;
    }
    let end = index;
    while (end < current.length && matches[end]! < 0) end += 1;
    const nextBase = end < current.length ? matches[end]! : base.length;
    const run = serializeRun(current.slice(index, end), schema, baseline.labels, first);
    verified &&= run.verified;
    if (run.parsed.entries.length) {
      const replaced = previousBase + 1 < nextBase ? base[previousBase + 1]?.gapBefore : undefined;
      run.parsed.entries[0] = { ...run.parsed.entries[0]!, gapBefore: first ? (base[0]?.gapBefore ?? "") : separatorNear(replaced) };
      entries.push(...run.parsed.entries);
      for (const label of run.parsed.labels.links) labels.links.add(label);
      for (const label of run.parsed.labels.footnotes) labels.footnotes.add(label);
      previousWasBase = false;
    }
    previousBase = nextBase - 1;
    index = end;
  }
  const trailing = baseline.trailing;
  const body = entries.map((entry) => entry.gapBefore + entry.source).join("") + trailing;
  return {
    text: closeEnvelope(body, baseline.envelope),
    baseline: { envelope: baseline.envelope, entries, trailing, labels },
    verified,
  };
}

function serializeRun(nodes: readonly PmNode[], schema: Schema, labels: MarkdownBaseline["labels"], atStart: boolean) {
  const tree = documentToMarkdownTree(nodes) as unknown as Parameters<typeof stringifyMarkdownTree>[0];
  const expected = semanticKey(nodes);
  const context = definitionContext(labels);
  let fallback: { text: string; parsed: ParsedBlocks } | null = null;
  for (const mode of ["literal", "safe"] as const) {
    const text = stringifyMarkdownTree(tree, mode);
    const parsed = parseBlocks(text, schema, context, atStart);
    // The run's bytes are exactly its entries: no leading or trailing gap.
    parsed.entries.forEach((entry, position) => {
      if (position === 0) entry.gapBefore = "";
    });
    if (semanticKey(parsed.entries.map((entry) => entry.node)) === expected) return { parsed, verified: true };
    fallback = { text, parsed };
  }
  return { parsed: fallback!.parsed, verified: false };
}

/**
 * What a sequence of nodes means, ignoring how it was written: style
 * attributes, authored-source marks, text-node boundaries, and empty
 * paragraphs (which have no Markdown) are dropped.
 */
export function semanticKey(nodes: readonly PmNode[]): string {
  return JSON.stringify(nodes.map((node) => semanticJSON(node.toJSON() as JSONContent)).filter(Boolean));
}

function semanticJSON(node: JSONContent): unknown {
  if (node.type === "paragraph" && !node.content?.length) return null;
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {})
      .filter(([name]) => !STYLE_ATTRIBUTES.has(name))
      .map(([name, value]) => [name, value === "" ? null : value]),
  );
  const marks = (node.marks ?? [])
    .filter((mark) => mark.type !== "latticeSource")
    .map((mark) => [mark.type, Object.fromEntries(Object.entries(mark.attrs ?? {}).filter(([name]) => !STYLE_ATTRIBUTES.has(name)))]);
  if (node.type === "text") return { text: node.text, marks };
  const content: unknown[] = [];
  for (const child of node.content ?? []) {
    const value = semanticJSON(child) as { text?: string; marks?: unknown } | null;
    if (!value) continue;
    const previous = content[content.length - 1] as { text?: string; marks?: unknown } | undefined;
    if (value.text != null && previous?.text != null && JSON.stringify(previous.marks) === JSON.stringify(value.marks)) {
      content[content.length - 1] = { ...previous, text: previous.text + value.text };
    } else {
      content.push(value);
    }
  }
  return { type: node.type, attrs, marks, content };
}
