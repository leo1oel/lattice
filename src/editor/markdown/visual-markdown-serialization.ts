/**
 * Markdown in and out of the visual editor: the bounded parse cache, the
 * byte-preserving serializer, and the round-trip eligibility probe.
 */
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { canonicalizeSupportedMarkdown, preserveMarkdownEnvelope } from "./markdown-collab";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";
import { clamp, exactVisualSourceRanges, type VisualSourceRange } from "./visual-source-map";

type PmNode = Editor["state"]["doc"];

const VISUAL_DOCUMENT_CACHE_LIMIT = 64;
const VISUAL_DOCUMENT_CACHE_TEXT_LIMIT = 4_000_000;

type CachedVisualDocument = {
  text: string;
  content: ReturnType<typeof parseVisualMarkdown>;
  representedExactly?: boolean;
};

const visualDocumentCache = new Map<string, CachedVisualDocument>();
let visualDocumentCacheTextSize = 0;

/** LRU by path, bounded by entry count and total source size. */
export function cachedVisualDocument(path: string, text: string): CachedVisualDocument {
  const cached = visualDocumentCache.get(path);
  if (cached) {
    visualDocumentCache.delete(path);
    if (cached.text === text) {
      visualDocumentCache.set(path, cached);
      return cached;
    }
    visualDocumentCacheTextSize -= cached.text.length;
  }
  const entry: CachedVisualDocument = { text, content: parseVisualMarkdown(text, path) };
  visualDocumentCache.set(path, entry);
  visualDocumentCacheTextSize += text.length;
  while (
    visualDocumentCache.size > VISUAL_DOCUMENT_CACHE_LIMIT
    || visualDocumentCacheTextSize > VISUAL_DOCUMENT_CACHE_TEXT_LIMIT
  ) {
    const [oldestPath, oldest] = visualDocumentCache.entries().next().value!;
    visualDocumentCache.delete(oldestPath);
    visualDocumentCacheTextSize -= oldest.text.length;
  }
  return entry;
}

/** Replace the document without an undo step or an update echo. */
export function setMarkdownWithoutHistory(editor: Editor, markdown: string, sourcePath: string) {
  // TipTap normally builds fresh nodes from JSON, but some extension attributes
  // hold nested objects. Keep the cached parse pristine across editor instances.
  editor.chain()
    .setContent(structuredClone(cachedVisualDocument(sourcePath, markdown).content), { emitUpdate: false })
    .command(({ tr }) => {
      tr.setMeta("addToHistory", false);
      tr.setMeta("canonicalMarkdownReplace", true);
      return true;
    })
    .run();
}

function textSemantics(node: PmNode): string {
  const semantics: unknown[] = [];
  node.descendants((child) => {
    if (child.isText) {
      semantics.push([
        child.text,
        child.marks.filter((mark) => mark.type.name !== "sourceLiteral").map((mark) => [mark.type.name, mark.attrs]),
      ]);
      return;
    }
    // A hard break is the one representation difference this comparison exists
    // to forgive — the same prose carries it as a newline in the source and as
    // a node in the document. Every other leaf is content: an inline-math atom
    // or an image can be deleted without touching a character of text, and
    // that has to read as a change or the deletion is restored away.
    if (child.type.name === "hardBreak") return;
    if (child.isLeaf || child.isAtom) semantics.push([child.type.name, child.attrs]);
  });
  return JSON.stringify(semantics);
}

/**
 * Re-emit the source bytes of every block the reader did not touch.
 *
 * The serializer is entitled to normalize anything it round-trips: a blank line
 * between two blocks the converter wrote tight, `\*` around a stray asterisk,
 * emphasis delimiters inside a bold caption. For a block nobody edited that
 * normalization is pure damage — it rewrites the file on open — and because the
 * eligibility probe compares serializer output against the source, a single
 * normalized separator disabled visual editing for the whole document. Every
 * imported paper failed that way: `## Contents` sits directly on its list, and
 * arxiv2md captions sit directly on their tables.
 *
 * Splicing the original bytes back keeps an untouched document identical, so
 * only blocks that actually changed pay the serializer's canonical form.
 */
export function restoreUnchangedBlocks(
  serialized: string,
  expected: string,
  currentDoc: PmNode,
  changedBlocks?: ReadonlySet<number>,
  sourcePath?: string,
): string {
  let expectedDoc: PmNode;
  try {
    expectedDoc = currentDoc.type.schema.nodeFromJSON(parseVisualMarkdown(expected, sourcePath));
  } catch {
    return serialized;
  }
  if (currentDoc.childCount !== expectedDoc.childCount) return serialized;
  // A leading BOM is envelope, not content: offsets are body-relative and
  // preserveMarkdownEnvelope re-attaches it around whatever we return.
  const body = expected.startsWith("\uFEFF") ? expected.slice(1) : expected;
  // Never splice through visualSourceRanges' best-effort mapping: a repeated
  // fallback range would copy the same formula or container over later
  // blocks. When ownership is uncertain, canonical serialization is less
  // faithful but cannot duplicate or replace unrelated content.
  const original = exactVisualSourceRanges(body, expectedDoc.childCount);
  const rewritten = exactVisualSourceRanges(serialized, currentDoc.childCount);
  if (!original || !rewritten) return serialized;
  const unchanged = Array.from({ length: currentDoc.childCount }, (_, index) => {
    if (changedBlocks?.has(index)) return false;
    const current = currentDoc.child(index);
    const before = expectedDoc.child(index);
    return current.eq(before) || (current.isTextblock && current.sameMarkup(before) && (
      current.content.eq(before.content) || textSemantics(current) === textSemantics(before)
    ));
  });
  if (unchanged.every(Boolean)) return body;
  const last = unchanged.length - 1;
  // Slice one span out of the source bytes, or out of the serializer output.
  type Bound = (ranges: VisualSourceRange[]) => number;
  const pick = (keepSource: boolean, from: Bound, to: Bound) => (
    keepSource ? body.slice(from(original), to(original)) : serialized.slice(from(rewritten), to(rewritten))
  );
  let result = pick(unchanged[0]!, () => 0, (ranges) => ranges[0]!.from);
  for (let index = 0; index <= last; index += 1) {
    // The gap between two blocks comes from the source only when both sides
    // still hold their source bytes. Next to an edited block the serializer
    // decides it, so a boundary the source wrote tight can never splice a
    // rewritten block onto its neighbour and merge the two.
    if (index > 0) {
      result += pick(unchanged[index]! && unchanged[index - 1]!, (ranges) => ranges[index - 1]!.to, (ranges) => ranges[index]!.from);
    }
    result += pick(unchanged[index]!, (ranges) => ranges[index]!.from, (ranges) => ranges[index]!.to);
  }
  return result + pick(unchanged[last]!, (ranges) => ranges[last]!.to, () => Infinity);
}

export function serializeMarkdown(
  editor: Editor,
  expected: string,
  changedBlocks?: ReadonlySet<number>,
  sourcePath?: string,
): string {
  return preserveMarkdownEnvelope(
    restoreUnchangedBlocks(getMarkdownManager().serialize(editor.getJSON()), expected, editor.state.doc, changedBlocks, sourcePath),
    expected,
  );
}

export function changedTopLevelBlocks(transaction: Transaction): Set<number> {
  const changed = new Set<number>();
  const addRange = (from: number, to: number) => {
    const start = clamp(from, 0, transaction.doc.content.size);
    const end = clamp(to, start, transaction.doc.content.size);
    changed.add(transaction.doc.resolve(start).index(0));
    changed.add(transaction.doc.resolve(Math.max(start, end - 1)).index(0));
  };
  for (const step of transaction.steps) {
    let mapped = false;
    step.getMap().forEach((_oldFrom, _oldTo, from, to) => {
      mapped = true;
      addRange(from, to);
    });
    if (mapped) continue;
    // A mark step — bold, a link, an inline-math atom — rewrites content
    // without moving anything, so its step map is empty. Only the step itself
    // carries the range, already in `transaction.doc` coordinates.
    const range = step as unknown as { from?: unknown; to?: unknown };
    if (typeof range.from === "number" && typeof range.to === "number") addRange(range.from, range.to);
  }
  return changed;
}

function visibleText(node: PmNode): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "hardBreak") return "\n";
  return node.children.map(visibleText).join("");
}

function countNodes(node: PmNode, predicate: (child: PmNode) => boolean): number {
  let count = 0;
  node.descendants((child) => {
    if (predicate(child)) count += 1;
  });
  return count;
}

/**
 * ProseMirror's DOM observer turns parser-preserved multiline text into
 * equivalent hard-break nodes after mount. That is internal document
 * normalization, not an authored Markdown change.
 */
export function isMultilineTextNormalization(transaction: Transaction): boolean {
  if (!transaction.docChanged || transaction.before.childCount !== transaction.doc.childCount) return false;
  const changed = changedTopLevelBlocks(transaction);
  const isHardBreak = (node: PmNode) => node.type.name === "hardBreak";
  return changed.size > 0 && [...changed].every((index) => {
    const before = transaction.before.maybeChild(index);
    const after = transaction.doc.maybeChild(index);
    return Boolean(before && after)
      && visibleText(before!) === visibleText(after!)
      && countNodes(before!, (node) => node.isText && /\r?\n/.test(node.text ?? "")) > 0
      && countNodes(after!, isHardBreak) > countNodes(before!, isHardBreak);
  });
}

// One trailing space is ordinary prose whitespace and CommonMark drops it;
// two or more spaces remain significant hard-break syntax.
const canonicalizeVisualEligibility = (markdown: string) => (
  canonicalizeSupportedMarkdown(markdown.replace(/(?<! )[ \t](?=\r?$)/gm, ""))
);

/**
 * Whether the visual editor can round-trip `text` without loss. A property of
 * the source parser's round trip, not of a live editor, so it is memoized on
 * the cached parse.
 */
export function isRepresentedExactly(path: string, text: string, schema: PmNode["type"]["schema"]): boolean {
  const parsed = cachedVisualDocument(path, text);
  // MarkdownManager serialization annotates its input, so keep the cached
  // parse tree pristine for this and later editor instances.
  parsed.representedExactly ??= canonicalizeVisualEligibility(preserveMarkdownEnvelope(
    restoreUnchangedBlocks(
      getMarkdownManager().serialize(structuredClone(parsed.content)),
      text,
      schema.nodeFromJSON(structuredClone(parsed.content)),
      undefined,
      path,
    ),
    text,
  )) === canonicalizeVisualEligibility(text);
  return parsed.representedExactly;
}
