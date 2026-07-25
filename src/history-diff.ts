import { diffLines, diffWordsWithSpace, type Change } from "diff";

export type DiffLine = {
  type: "added" | "removed" | "context" | "skip";
  text: string;
  beforeLine?: number | null;
  afterLine?: number | null;
  skippedCount?: number;
};

const MAX_CHARS = 240_000;
const DEFAULT_CONTEXT = 3;

export function unifiedDiffLines(before: string | null | undefined, after: string | null | undefined): DiffLine[] {
  return annotatedDiffLines(before, after).map(({ type, text }) => ({ type, text }));
}

/** Full unified diff with 1-based before/after line numbers. */
export function annotatedDiffLines(
  before: string | null | undefined,
  after: string | null | undefined,
): DiffLine[] {
  const left = before ?? "";
  const right = after ?? "";
  if (left.length + right.length > MAX_CHARS) {
    return [{
      type: "context",
      text: "Diff truncated: this change is too large to preview inline.",
      beforeLine: null,
      afterLine: null,
    }];
  }
  const changes: Change[] = diffLines(left, right);
  const lines: DiffLine[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (const change of changes) {
    const type: DiffLine["type"] = change.added ? "added" : change.removed ? "removed" : "context";
    const chunks = change.value.replace(/\n$/, "").split("\n");
    for (const text of chunks) {
      if (!text && chunks.length === 1 && !change.value.includes("\n")) continue;
      if (type === "removed") {
        beforeLine += 1;
        lines.push({ type, text, beforeLine, afterLine: null });
      } else if (type === "added") {
        afterLine += 1;
        lines.push({ type, text, beforeLine: null, afterLine });
      } else {
        beforeLine += 1;
        afterLine += 1;
        lines.push({ type, text, beforeLine, afterLine });
      }
    }
  }
  return lines;
}

/**
 * Collapse long unchanged runs, keeping `context` lines around each change.
 * Emit `skip` rows for hidden context so the UI can expand them.
 */
export function hunkedDiffLines(
  before: string | null | undefined,
  after: string | null | undefined,
  context = DEFAULT_CONTEXT,
): DiffLine[] {
  const lines = annotatedDiffLines(before, after);
  if (lines.length === 0) return lines;
  if (lines.length === 1 && lines[0]?.text.startsWith("Diff truncated")) return lines;

  const keep = new Array(lines.length).fill(false);
  const isChange = (line: DiffLine) => line.type === "added" || line.type === "removed";
  for (let index = 0; index < lines.length; index += 1) {
    if (!isChange(lines[index]!)) continue;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    for (let cursor = start; cursor <= end; cursor += 1) keep[cursor] = true;
  }

  // If the file is only context (identical), keep a short preview.
  if (!keep.some(Boolean)) {
    return lines.slice(0, Math.min(lines.length, context * 2 + 1));
  }

  const result: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (keep[index]) {
      result.push(lines[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && !keep[end]) end += 1;
    const skippedCount = end - index;
    if (skippedCount > 0) {
      result.push({
        type: "skip",
        text: `${skippedCount} unchanged line${skippedCount === 1 ? "" : "s"}`,
        skippedCount,
        beforeLine: lines[index]?.beforeLine ?? null,
        afterLine: lines[index]?.afterLine ?? null,
      });
    }
    index = end;
  }
  return result;
}

export function changeKind(before: string | null | undefined, after: string | null | undefined): "created" | "deleted" | "edited" {
  if (before == null && after != null) return "created";
  if (before != null && after == null) return "deleted";
  return "edited";
}

/** Prefer the after-file line for navigation; fall back to before-file line. */
export function jumpLineForDiff(line: DiffLine): number | null {
  if (line.type === "skip") return null;
  if (line.afterLine != null) return line.afterLine;
  if (line.beforeLine != null) return line.beforeLine;
  return null;
}

/** One run of a line, marked according to whether it is part of the change. */
export type DiffSegment = { text: string; changed: boolean };

/**
 * Which words actually differ between a line and the line that replaced it.
 *
 * A line-level diff says the whole line changed, which for prose is nearly
 * useless: correcting one word paints the entire sentence red and green and
 * leaves the reader to spot the difference themselves. This narrows it to the
 * words that moved, so the eye lands on them.
 */
export function wordSegments(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } {
  const parts = diffWordsWithSpace(before, after);
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  for (const part of parts) {
    if (part.added) right.push({ text: part.value, changed: true });
    else if (part.removed) left.push({ text: part.value, changed: true });
    else {
      left.push({ text: part.value, changed: false });
      right.push({ text: part.value, changed: false });
    }
  }
  return { before: left, after: right };
}

/**
 * Pair each replaced line with its replacement, by position within the run.
 *
 * Only a removed run and an added run that sit together and are the same
 * length are treated as rewrites of each other. Runs of different lengths are
 * a genuine insertion or deletion rather than a rewrite, and guessing at a
 * pairing there would mark words as changed that nobody touched.
 */
export function pairedRewrites(lines: DiffLine[]): Map<number, DiffSegment[]> {
  const marks = new Map<number, DiffSegment[]>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type !== "removed") {
      index += 1;
      continue;
    }
    let removedEnd = index;
    while (lines[removedEnd]?.type === "removed") removedEnd += 1;
    let addedEnd = removedEnd;
    while (lines[addedEnd]?.type === "added") addedEnd += 1;
    const removedCount = removedEnd - index;
    const addedCount = addedEnd - removedEnd;
    if (removedCount > 0 && removedCount === addedCount) {
      for (let offset = 0; offset < removedCount; offset += 1) {
        const from = lines[index + offset]!;
        const to = lines[removedEnd + offset]!;
        const { before, after } = wordSegments(from.text, to.text);
        marks.set(index + offset, before);
        marks.set(removedEnd + offset, after);
      }
    }
    index = addedEnd > index ? addedEnd : index + 1;
  }
  return marks;
}

/** One run of text in an in-context view, and what happened to it. */
export type InlineSegment = { text: string; kind: "same" | "added" | "removed" };

/** One line of the document, with the change marked where it happened. */
export type InlineDiffLine = {
  /**
   * The line's number in the document as it now reads. Null for a line that
   * was removed outright: it is shown so the removal is visible, but it is no
   * longer part of the file and numbering it would be a lie.
   */
  line: number | null;
  segments: InlineSegment[];
  changed: boolean;
};

/**
 * The document as it now reads, with what changed marked in place.
 *
 * A hunked diff answers "what are the edits" and is the wrong question for
 * prose: it shows a handful of lines torn out of the paragraph they belong
 * to, so the reader cannot tell where the change is or what it means. This
 * answers "what does the document say now, and what moved" — the text is
 * continuous, insertions are marked where they landed, and deletions stay
 * visible in the sentence they were cut from rather than silently vanishing.
 */
export function inlineDiffLines(
  before: string | null | undefined,
  after: string | null | undefined,
): InlineDiffLine[] {
  const lines = annotatedDiffLines(before, after);
  if (lines.length === 1 && lines[0]?.text.startsWith("Diff truncated")) {
    return [{ line: null, segments: [{ text: lines[0].text, kind: "same" }], changed: false }];
  }
  const out: InlineDiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.type === "context") {
      out.push({
        line: line.afterLine ?? null,
        segments: [{ text: line.text, kind: "same" }],
        changed: false,
      });
      index += 1;
      continue;
    }
    // A run of removals, then any additions that follow it. Together these are
    // one edit, whether that is a rewrite, a cut, or an insertion.
    let removedEnd = index;
    while (lines[removedEnd]?.type === "removed") removedEnd += 1;
    let addedEnd = removedEnd;
    while (lines[addedEnd]?.type === "added") addedEnd += 1;
    const removed = lines.slice(index, removedEnd);
    const added = lines.slice(removedEnd, addedEnd);

    if (removed.length === added.length && removed.length > 0) {
      // Rewritten line for line: merge each pair so the sentence reads
      // through, with only the words that moved marked.
      for (let offset = 0; offset < removed.length; offset += 1) {
        const before = removed[offset]!;
        const after = added[offset]!;
        const segments = mergedSegments(before.text, after.text);
        if (segments) {
          out.push({ line: after.afterLine ?? null, segments, changed: true });
          continue;
        }
        // Too shattered to read in place: the old line, then the new one.
        out.push({ line: null, segments: [{ text: before.text, kind: "removed" }], changed: true });
        out.push({
          line: after.afterLine ?? null,
          segments: [{ text: after.text, kind: "added" }],
          changed: true,
        });
      }
    } else {
      for (const item of removed) {
        out.push({
          line: null,
          segments: [{ text: item.text, kind: "removed" }],
          changed: true,
        });
      }
      for (const item of added) {
        out.push({
          line: item.afterLine ?? null,
          segments: [{ text: item.text, kind: "added" }],
          changed: true,
        });
      }
    }
    index = addedEnd > index ? addedEnd : index + 1;
  }
  return out;
}

/**
 * How many alternating edits a line can carry before reading it word by word
 * is harder than reading both versions whole. Two similar-but-different
 * strings — a timestamp, a URL, a rewritten equation — shatter into a dozen
 * tiny runs that interleave into nonsense: `2026-07-25T1125T19:0131:41Z46Z`.
 */
const MAX_INLINE_EDITS = 4;

/**
 * One line's worth of before-and-after in reading order, or null when the two
 * versions differ in so many places that marking them in place is unreadable.
 */
function mergedSegments(before: string, after: string): InlineSegment[] | null {
  const segments: InlineSegment[] = diffWordsWithSpace(before, after).map((part) => ({
    text: part.value,
    kind: part.added ? "added" : part.removed ? "removed" : "same",
  }));
  const edits = segments.filter((segment) => segment.kind !== "same").length;
  return edits <= MAX_INLINE_EDITS ? segments : null;
}
