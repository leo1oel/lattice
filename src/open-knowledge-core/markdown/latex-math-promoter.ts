import type { PhrasingContent, Root, Text } from 'mdast';
import type { InlineMath } from 'mdast-util-math';
import type { Position } from 'unist';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import { findFencedRegions, isInsideFence } from './fence-regions.ts';
import { deriveFragmentPosition, escapedValueOffsets } from './promoter-position.ts';

/*
 * LaTeX-delimited math: `\[ … \]` display blocks and `\( … \)` inline spans.
 *
 * remark-math only tokenizes dollar delimiters, but AI assistants emit the
 * LaTeX forms constantly and every chat surface accepts them; a document
 * surface that shows the same bytes as prose reads as broken.
 *
 * Display blocks cannot be promoted from the parsed tree: their content
 * lines re-tokenize as arbitrary Markdown first (a lone `=` line turns the
 * formula's head into a setext heading, `{…}` becomes an MDX expression), so
 * `swapLatexDisplayMathDelimiters` swaps the delimiters for `$$` — the same
 * byte length — in the protected parse text instead, letting micromark's
 * math-flow construct claim the content before any of that happens. The
 * parse pipeline keeps `file.value` pointing at the original source, so
 * position-slice captures the original `\[ … \]` bytes as sourceRaw and the
 * pristine serialization path reproduces them exactly; editing the formula
 * canonicalizes to `$$ … $$` like any other dirty math component.
 *
 * Inline `\( … \)` spans survive as escape-derived parentheses in text
 * nodes, so `latexMathPromoterPlugin` rebuilds them from the tree. A span's
 * interior can be split across siblings (`{…}` MDX leftovers, misparsed
 * emphasis), so the scan pairs an escaped `(` with the next escaped `)`
 * across a sibling run and takes the formula from the source bytes between
 * them — CommonMark escape decoding must not eat LaTeX (`\{` is a literal
 * brace, `\%` a literal percent). Promoted spans carry `data.sourceRaw`,
 * which serializeInlineMath emits verbatim until a formula edit nulls it
 * (MathInlineView.commitFormulaDraft) and `$ … $` takes over.
 */

const DISPLAY_OPEN_LINE = /^ {0,3}\\\[[ \t]*\r?$/;
const DISPLAY_CLOSE_LINE = /^ {0,3}\\\][ \t]*\r?$/;
const DISPLAY_SINGLE_LINE = /^ {0,3}\\\[(.*)\\\][ \t]*\r?$/;

/**
 * Swap paired, line-anchored `\[` / `\]` display-math delimiters for `$$` in
 * the text handed to remark-parse. Length-preserving by construction, so
 * every downstream position still indexes the original source. Delimiters
 * inside fenced code, indented four or more columns (indented code), or
 * prefixed by a blockquote marker never match; an unpaired opener is left
 * alone rather than swallowing the rest of the document as math.
 */
export function swapLatexDisplayMathDelimiters(source: string): string {
  if (!source.includes('\\[')) return source;
  const fences = findFencedRegions(source);
  const lines: Array<{ start: number; text: string }> = [];
  let offset = 0;
  for (const text of source.split('\n')) {
    lines.push({ start: offset, text });
    offset += text.length + 1;
  }
  const swaps: number[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isInsideFence(line.start, fences)) {
      index += 1;
      continue;
    }
    const single = DISPLAY_SINGLE_LINE.exec(line.text);
    if (single) {
      const inner = single[1];
      if (inner.trim() && !inner.includes('\\[') && !inner.includes('\\]')) {
        swaps.push(line.start + line.text.indexOf('\\['), line.start + line.text.lastIndexOf('\\]'));
      }
      index += 1;
      continue;
    }
    if (DISPLAY_OPEN_LINE.test(line.text)) {
      let close = -1;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        // A fence between the delimiters would end up inside the math block;
        // leave the whole candidate as prose rather than swallow code.
        if (isInsideFence(lines[scan].start, fences)) break;
        if (DISPLAY_CLOSE_LINE.test(lines[scan].text)) {
          close = scan;
          break;
        }
      }
      if (close >= 0) {
        swaps.push(
          line.start + line.text.indexOf('\\['),
          lines[close].start + lines[close].text.indexOf('\\]'),
        );
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  if (swaps.length === 0) return source;
  const parts: string[] = [];
  let previous = 0;
  for (const swap of swaps) {
    parts.push(source.slice(previous, swap), '$$');
    previous = swap + 2;
  }
  parts.push(source.slice(previous));
  return parts.join('');
}

/** Promote `\( … \)` spans left in text nodes to inline math. */
export function latexMathPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    if (!source || !source.includes('\\(')) return;
    visit(tree, (node) => {
      const children = (node as { children?: unknown[] }).children;
      if (Array.isArray(children)) {
        promoteInlineSpans(children as PhrasingContent[], source);
      }
    });
  };
}

interface InlineSpan {
  closeIndex: number;
  /** Mark containers between the sibling at closeIndex and the close text
   * node, outermost first; empty when the close sits at the run's own level. */
  closeAncestors: MarkContainer[];
  closeNode: Text;
  closeOffset: number;
  formula: string;
  sourceRaw: string;
  position: Position;
}

/** A container whose delimiters can be misparsed formula bytes (`_` pairs in
 * `\(a_i\) … \(b_j\)` emphasize the prose between the spans). Only these are
 * safe to unwrap: their children carry the marks of everything the reader
 * actually authored. */
type MarkContainer = PhrasingContent & { type: 'emphasis' | 'strong' | 'delete'; children: PhrasingContent[] };

function isMarkContainer(node: PhrasingContent): node is MarkContainer {
  return node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete';
}

interface NestedClose {
  ancestors: MarkContainer[];
  node: Text;
  offset: number;
}

/** In-order search for the first escape-derived `)` in a sibling's subtree,
 * descending only through mark containers. `null` when the subtree holds no
 * close; `'unsearchable'` when a non-mark container is in the way — its close
 * (if any) cannot be unwrapped, so the caller must give the span up rather
 * than pair with a later `)` and swallow the container. */
function findNestedClose(
  node: PhrasingContent,
  source: string,
): NestedClose | null | 'unsearchable' {
  if (node.type === 'text') {
    const offset = findEscapedDelimiter(node, source, ')', 0);
    return offset === null ? null : { ancestors: [], node, offset };
  }
  if (isMarkContainer(node)) {
    for (const child of node.children) {
      const nested = findNestedClose(child, source);
      if (nested === 'unsearchable') return 'unsearchable';
      if (nested) return { ...nested, ancestors: [node, ...nested.ancestors] };
    }
    return null;
  }
  const children = (node as { children?: PhrasingContent[] }).children;
  return Array.isArray(children) && children.length > 0 ? 'unsearchable' : null;
}

function promoteInlineSpans(children: PhrasingContent[], source: string): void {
  let index = 0;
  let scanFrom = 0;
  while (index < children.length) {
    const child = children[index];
    if (child.type !== 'text') {
      index += 1;
      scanFrom = 0;
      continue;
    }
    const open = findEscapedDelimiter(child, source, '(', scanFrom);
    if (open === null) {
      index += 1;
      scanFrom = 0;
      continue;
    }
    const span = matchSpan(children, index, open, source);
    if (span === null) {
      scanFrom = open + 1;
      continue;
    }
    index = applySpan(children, index, open, span, source);
    scanFrom = 0;
  }
}

/** The first offset at or after `from` where `char` was decoded from `\char`. */
function findEscapedDelimiter(
  node: Text,
  source: string,
  char: '(' | ')',
  from: number,
): number | null {
  if (!node.value.includes(char)) return null;
  const escaped = escapedValueOffsets(source, node);
  if (escaped === null || escaped.size === 0) return null;
  for (let at = node.value.indexOf(char, from); at !== -1; at = node.value.indexOf(char, at + 1)) {
    if (escaped.has(at)) return at;
  }
  return null;
}

function matchSpan(
  children: PhrasingContent[],
  openIndex: number,
  openOffset: number,
  source: string,
): InlineSpan | null {
  const openNode = children[openIndex] as Text;
  let closeIndex = openIndex;
  let closeAncestors: MarkContainer[] = [];
  let closeNode: Text | null = null;
  let closeOffset = findEscapedDelimiter(openNode, source, ')', openOffset + 1);
  if (closeOffset !== null) {
    closeNode = openNode;
  } else {
    for (let sibling = openIndex + 1; sibling < children.length; sibling += 1) {
      const node = children[sibling];
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      // Interior siblings are consumed into the formula, so their bytes must
      // be addressable; without offsets the source slice below could not be
      // trusted to cover them.
      if (typeof start !== 'number' || typeof end !== 'number') return null;
      const nested = findNestedClose(node, source);
      if (nested === 'unsearchable') return null;
      if (nested) {
        closeIndex = sibling;
        closeAncestors = nested.ancestors;
        closeNode = nested.node;
        closeOffset = nested.offset;
        break;
      }
    }
    if (closeNode === null || closeOffset === null) return null;
  }
  const openPosition = deriveFragmentPosition(source, openNode, openOffset, openOffset + 1);
  const closePosition = deriveFragmentPosition(source, closeNode, closeOffset, closeOffset + 1);
  if (!openPosition || !closePosition) return null;
  const from = openPosition.start.offset;
  const to = closePosition.end.offset;
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  const sourceRaw = source.slice(from, to);
  // A slice that is not delimiter-shaped means the offset walk desynced —
  // leave the span as prose rather than guess at the formula.
  if (!sourceRaw.startsWith('\\(') || !sourceRaw.endsWith('\\)') || sourceRaw.includes('\n')) {
    return null;
  }
  const formula = sourceRaw.slice(2, -2).trim();
  if (!formula) return null;
  for (let interior = openIndex + 1; interior < closeIndex; interior += 1) {
    const start = children[interior].position?.start?.offset;
    const end = children[interior].position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number' || start < from || end > to) {
      return null;
    }
  }
  // A nested close is only unwrappable when every ancestor's opening
  // delimiter sits inside the span — that is what proves the container is
  // misparsed formula bytes and not authored markup.
  for (const ancestor of closeAncestors) {
    const start = ancestor.position?.start?.offset;
    if (typeof start !== 'number' || start < from) return null;
  }
  return {
    closeIndex,
    closeAncestors,
    closeNode,
    closeOffset,
    formula,
    sourceRaw,
    position: { start: openPosition.start, end: closePosition.end },
  };
}

/** Splice the span into lead text + math atom + tail; returns the index to
 * continue scanning from (the first tail node, which may hold another span). */
function applySpan(
  children: PhrasingContent[],
  openIndex: number,
  openOffset: number,
  span: InlineSpan,
  source: string,
): number {
  const openNode = children[openIndex] as Text;
  const replacements: PhrasingContent[] = [];
  const lead = openNode.value.slice(0, openOffset);
  if (lead) {
    const node: Text = { type: 'text', value: lead };
    const position = deriveFragmentPosition(source, openNode, 0, openOffset);
    if (position) node.position = position;
    replacements.push(node);
  }
  const mathNode: InlineMath = {
    type: 'inlineMath',
    value: span.formula,
    // `\( … \)` is inline math, so a formula edit (which nulls sourceRaw)
    // canonicalizes to `$ … $`; without the delimiter hint the serializer
    // defaults to `$$`.
    data: { sourceRaw: span.sourceRaw, sourceDelimiter: '$' },
    position: span.position,
  };
  replacements.push(mathNode as unknown as PhrasingContent);
  const tail = closeTail(span, source);
  replacements.push(...tail);
  children.splice(openIndex, span.closeIndex - openIndex + 1, ...replacements);
  return openIndex + (lead ? 2 : 1);
}

/** Everything after the close delimiter, lifted to the scan's own level.
 *
 * When the close was nested, each ancestor container's opening delimiter was
 * formula bytes (`_` before a subscript, say), so the container itself is a
 * misparse — but its children are real: a `**bold**` run inside stays a
 * strong node. Unwrapping drops only the bogus delimiters; the on-disk bytes
 * are safe regardless because an untouched block re-serializes from source. */
function closeTail(span: InlineSpan, source: string): PhrasingContent[] {
  const tail: PhrasingContent[] = [];
  const remainder = span.closeNode.value.slice(span.closeOffset + 1);
  if (remainder) {
    const node: Text = { type: 'text', value: remainder };
    const position = deriveFragmentPosition(
      source,
      span.closeNode,
      span.closeOffset + 1,
      span.closeNode.value.length,
    );
    if (position) node.position = position;
    tail.push(node);
  }
  let inner: PhrasingContent = span.closeNode;
  for (let level = span.closeAncestors.length - 1; level >= 0; level -= 1) {
    const ancestor = span.closeAncestors[level];
    const at = ancestor.children.indexOf(inner);
    if (at !== -1) tail.push(...ancestor.children.slice(at + 1));
    inner = ancestor;
  }
  return tail;
}
