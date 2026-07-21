import { diffLines, type Change } from "diff";

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
