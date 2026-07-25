/**
 * Moving Overleaf's anchored spans — comment quotes and suggestions — as the
 * text around and inside them changes.
 *
 * Overleaf sends where each one sits once, when the document is joined, and
 * then says nothing more about them: they are expected to be carried along by
 * the same operations that move the text. Left alone they drift, and a
 * drifting suggestion is not merely drawn in the wrong place — Accept and
 * Reject are applied to a range, so acting on one that has drifted edits text
 * nobody proposed changing.
 *
 * This is the same job `transformCaret` does for a cursor, except a span has
 * an end as well as a start, so an edit landing inside it changes its length
 * rather than its position.
 */
import type { OtOp } from "./ot-ops";

export type Span = { from: number; length: number };

/**
 * Where a span ends up after `ops` have been applied.
 *
 * Text typed at either edge lands outside the span, never in it: at the start
 * the span moves along to keep covering its own words, and at the end it stays
 * where it is. Both matter because accepting a suggestion rewrites whatever
 * the span covers, so a span that quietly swallowed the words next to it would
 * change text nobody proposed changing. A span whose text is deleted outright
 * collapses to nothing, which is how a caller knows there is no longer
 * anything to highlight.
 */
export function transformSpan(span: Span, ops: OtOp[]): Span {
  let { from, length } = span;
  for (const op of ops) {
    if (typeof op.i === "string") {
      const inserted = op.i.length;
      if (op.p <= from) from += inserted;
      else if (op.p < from + length) length += inserted;
      continue;
    }
    if (typeof op.d !== "string") continue;
    const start = op.p;
    const end = op.p + op.d.length;
    if (end <= from) {
      // Entirely before: everything shifts back.
      from -= op.d.length;
      continue;
    }
    if (start >= from + length) continue; // entirely after — nothing to do
    // Overlapping: lose the part of the span that was deleted, and move the
    // start back by however much of the deletion was in front of it.
    const overlap = Math.min(end, from + length) - Math.max(start, from);
    length -= overlap;
    if (start < from) from -= from - start;
  }
  return { from, length };
}

/** True once a span has nothing left in it to point at. */
export function isCollapsed(span: Span): boolean {
  return span.length <= 0;
}
