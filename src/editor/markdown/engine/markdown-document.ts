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
import { Fragment, type Node as PmNode, type Schema } from "@tiptap/pm/model";
import { markdownFrontmatterEnd } from "../../../app-utils";
import { documentToMarkdownTree } from "./document-to-markdown";
import { parseMarkdownTree, stringifyMarkdownTree } from "./markdown-syntax";
import { documentBlocks, rawBlock, type ParseOptions } from "./markdown-to-document";
import { semanticKey } from "./semantic-key";

export { semanticKey } from "./semantic-key";

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

/** How a document is read; fixed for the life of its baseline. */
export type OpenOptions = {
  /** Paper reading mode: infer merged cells in converted tables (R-BLK-11). */
  paperSpans?: boolean;
};

/** What the last accepted Markdown looked like, block by block. */
export type MarkdownBaseline = {
  envelope: Envelope;
  options: OpenOptions;
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

type ParsedBlocks = { entries: BaselineEntry[]; trailing: string; labels: Labels };

/**
 * Parse `body` into baseline entries. `context` is appended for parsing only;
 * `frontmatter` allows a leading frontmatter block (only at the file start).
 */
function parseBlocks(body: string, schema: Schema, context: string, frontmatter: boolean, options: OpenOptions): ParsedBlocks {
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
  for (const range of parseRanges(rest, schema, context, options, labels)) {
    push(offset + range.from, offset + Math.min(range.to, rest.length), range.json);
  }
  return { entries, trailing: body.slice(cursor), labels };
}

/** Block ranges of `text` (positions index into `text`), collecting its labels into `labels`. */
function parseRanges(text: string, schema: Schema, context: string, options: OpenOptions, labels: Labels) {
  const source = text + context;
  const tree = parseMarkdownTree(source);
  collectLabels(tree, labels);
  const parseOptions: ParseOptions = {
    paperSpans: Boolean(options.paperSpans),
    // A component's body is read like a document of its own, against the same definitions.
    parseBody: (inner) => parseRanges(inner, schema, context, options, labels).map((range) => range.json),
    cellKey: (paragraph) => {
      try {
        return paragraph.content?.length ? semanticKey([schema.nodeFromJSON(paragraph)]) : "";
      } catch {
        return JSON.stringify(paragraph);
      }
    },
  };
  return documentBlocks(tree.children, source, text.length, parseOptions);
}

function nodeFromJSON(schema: Schema, json: JSONContent, source: string): PmNode {
  try {
    const node = schema.nodeFromJSON(json);
    node.check();
    return stampComponentBodies(node);
  } catch {
    // A modelled block the schema still rejects (content it cannot hold) is kept verbatim.
    return schema.nodeFromJSON(rawBlock("unsupported", source));
  }
}

/**
 * Record, on every component, what its body meant when it was read: a body
 * that still means the same is written back from its exact source.
 */
function stampComponentBodies(node: PmNode): PmNode {
  if (node.isTextblock || node.isLeaf) return node;
  let changed = false;
  const children: PmNode[] = [];
  node.forEach((child) => {
    const stamped = stampComponentBodies(child);
    changed ||= stamped !== child;
    children.push(stamped);
  });
  const current = changed ? node.copy(Fragment.fromArray(children)) : node;
  if (current.type.name !== "latticeComponent") return current;
  return current.type.create({ ...current.attrs, bodyKey: semanticKey(current.children) }, current.content, current.marks);
}

function emptyDocument(schema: Schema): PmNode {
  return schema.topNodeType.create(null, schema.nodes.paragraph!.create());
}

/** Open Markdown for visual editing, or say why the engine declines it. */
export function openMarkdown(text: string, schema: Schema, options: OpenOptions = {}): OpenedMarkdown | { unavailable: UnavailableReason } {
  if (text.length > ENGINE_TEXT_LIMIT) return { unavailable: "too-large" };
  const opened = openEnvelope(text);
  if (!opened) return { unavailable: "mixed-line-endings" };
  let parsed: ParsedBlocks;
  try {
    parsed = parseBlocks(opened.body, schema, "", true, options);
  } catch {
    return { unavailable: "parse-failed" };
  }
  const rebuilt = parsed.entries.map((entry) => entry.gapBefore + entry.source).join("") + parsed.trailing;
  if (rebuilt !== opened.body) return { unavailable: "parse-failed" };
  const nodes = parsed.entries.map((entry) => entry.node);
  return {
    doc: nodes.length ? schema.topNodeType.create(null, nodes) : emptyDocument(schema),
    baseline: { envelope: opened.envelope, options, entries: parsed.entries, trailing: parsed.trailing, labels: parsed.labels },
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

/** A new join: the entry at `at` and the one before it, and the baseline-matched children on either side. */
type Seam = { at: number; children: number[] };

type Assembly = { entries: BaselineEntry[]; labels: Labels; verified: boolean; seams: Seam[] };

/**
 * The document as Markdown, with every block that still equals its baseline
 * written from its original bytes. Each new seam (next to changed content, or
 * between baseline blocks a deletion made neighbours) is re-parsed on its own;
 * where the two blocks would read back merged, the baseline side joins the
 * changed run and is re-serialized with it, so the serializer's join guards
 * keep them apart.
 */
export function serializeMarkdown(doc: PmNode, baseline: MarkdownBaseline): SerializedMarkdown {
  const matches = alignBlocks(doc.children, baseline.entries.map((entry) => entry.node));
  let assembly = assemble(doc, baseline, matches);
  for (;;) {
    const context = definitionContext(assembly.labels);
    const merged = assembly.seams.find((seam) => !seamHolds(assembly.entries, seam.at, doc.type.schema, context, baseline.options));
    if (!merged) break;
    for (const child of merged.children) matches[child] = -1;
    assembly = assemble(doc, baseline, matches);
  }
  const { entries, labels, verified } = assembly;
  const trailing = baseline.trailing;
  const body = entries.map((entry) => entry.gapBefore + entry.source).join("") + trailing;
  return {
    text: closeEnvelope(body, baseline.envelope),
    baseline: { envelope: baseline.envelope, options: baseline.options, entries, trailing, labels },
    verified,
  };
}

/** Splice baseline bytes and serialized runs in document order, noting every new seam. */
function assemble(doc: PmNode, baseline: MarkdownBaseline, matches: readonly number[]): Assembly {
  const current = doc.children;
  const base = baseline.entries;
  const labels: Labels = { links: new Set(baseline.labels.links), footnotes: new Set(baseline.labels.footnotes) };
  const entries: BaselineEntry[] = [];
  const seams: Seam[] = [];
  let verified = true;
  let previousBase = -1;
  let previousWasBase = false;
  /** The child written by the last entry when that entry is baseline bytes, else -1. */
  let lastBaseChild = -1;
  let index = 0;
  while (index < current.length) {
    const match = matches[index]!;
    const first = entries.length === 0;
    if (match >= 0) {
      const entry = base[match]!;
      const kept = previousWasBase && match === previousBase + 1;
      const gapBefore = first ? (base[0]?.gapBefore ?? "") : kept ? entry.gapBefore : separatorNear(entry.gapBefore);
      if (!first && !kept) seams.push({ at: entries.length, children: lastBaseChild >= 0 ? [lastBaseChild, index] : [index] });
      entries.push({ ...entry, gapBefore });
      previousBase = match;
      previousWasBase = true;
      lastBaseChild = index;
      index += 1;
      continue;
    }
    let end = index;
    while (end < current.length && matches[end]! < 0) end += 1;
    const nextBase = end < current.length ? matches[end]! : base.length;
    const run = serializeRun(current.slice(index, end), doc.type.schema, baseline, first);
    verified &&= run.verified;
    if (run.parsed.entries.length) {
      const replaced = previousBase + 1 < nextBase ? base[previousBase + 1]?.gapBefore : undefined;
      run.parsed.entries[0] = { ...run.parsed.entries[0]!, gapBefore: first ? (base[0]?.gapBefore ?? "") : separatorNear(replaced) };
      if (!first) seams.push({ at: entries.length, children: [lastBaseChild] });
      entries.push(...run.parsed.entries);
      for (const label of run.parsed.labels.links) labels.links.add(label);
      for (const label of run.parsed.labels.footnotes) labels.footnotes.add(label);
      previousWasBase = false;
      lastBaseChild = -1;
      previousBase = nextBase - 1;
    } else if (previousBase + 1 === nextBase) {
      previousBase = nextBase - 1;
    }
    index = end;
  }
  return { entries, labels, verified, seams };
}

/** Whether the entry at `seam` and the one before it read back as the same two blocks when written together. */
function seamHolds(entries: readonly BaselineEntry[], seam: number, schema: Schema, context: string, options: OpenOptions): boolean {
  const left = entries[seam - 1]!;
  const right = entries[seam]!;
  const atStart = seam === 1;
  const window = `${atStart ? left.gapBefore : ""}${left.source}${right.gapBefore}${right.source}`;
  try {
    const parsed = parseBlocks(window, schema, context, atStart, options);
    return semanticKey(parsed.entries.map((entry) => entry.node)) === semanticKey([left.node, right.node]);
  } catch {
    return false;
  }
}

function serializeRun(nodes: readonly PmNode[], schema: Schema, baseline: MarkdownBaseline, atStart: boolean) {
  const expected = semanticKey(nodes);
  const context = definitionContext(baseline.labels);
  let fallback: { text: string; parsed: ParsedBlocks } | null = null;
  for (const mode of ["literal", "safe"] as const) {
    // Each stringify consumes its tree (safe mode rewrites raw nodes in place).
    const tree = documentToMarkdownTree(nodes, baseline.options) as unknown as Parameters<typeof stringifyMarkdownTree>[0];
    const text = stringifyMarkdownTree(tree, mode);
    const parsed = parseBlocks(text, schema, context, atStart, baseline.options);
    // The run's bytes are exactly its entries: no leading or trailing gap.
    parsed.entries.forEach((entry, position) => {
      if (position === 0) entry.gapBefore = "";
    });
    if (semanticKey(parsed.entries.map((entry) => entry.node)) === expected) return { parsed, verified: true };
    fallback = { text, parsed };
  }
  return { parsed: fallback!.parsed, verified: false };
}
