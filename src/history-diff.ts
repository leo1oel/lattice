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
