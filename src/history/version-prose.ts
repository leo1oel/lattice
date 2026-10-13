/**
 * An opened version read as prose: the passages of a file that changed, each
 * with its edits, so the version can be read in the reading font the way a
 * proofread is rather than as a code diff whose sentence-long lines clip.
 */
import { phraseHunks } from "../agent/proofread-edits";
import type { InlineEdit } from "../components/ui/inline-edits";

export type ProsePassage = {
  /** The line the passage starts on in the version itself (1-based). */
  line: number;
  text: string;
  edits: InlineEdit[];
  /** The passage is cut out of a longer paragraph at a sentence edge. */
  clippedStart: boolean;
  clippedEnd: boolean;
};

/** Files whose text reads as prose; anything else opens on its source diff. */
export const PROSE_FILE = /\.(tex|ltx|md|markdown|txt|bib)$/i;

/** Past these a change is a rewrite, better read as its source diff. */
const MAX_TEXT = 400_000;
const MAX_EDITS = 400;
const MAX_PASSAGE = 2_400;
/** A changed paragraph longer than this is cut to the sentences around its edits. */
const LONG_PASSAGE = 640;

const SENTENCE_END = /[.!?。！？；;](?=\s|$)/g;

/** Where the sentence holding `offset` starts within `text`. */
function sentenceStart(text: string, offset: number): number {
  let start = 0;
  for (const match of text.slice(0, offset).matchAll(SENTENCE_END)) start = match.index + 1;
  while (start < offset && /\s/.test(text[start]!)) start += 1;
  return start;
}

/** Where the sentence holding `offset` ends within `text`. */
function sentenceEnd(text: string, offset: number): number {
  SENTENCE_END.lastIndex = offset;
  const match = SENTENCE_END.exec(text);
  return match ? match.index + 1 : text.length;
}

/**
 * The passages of `before` that `after` changed: whole source lines (a TeX
 * paragraph is usually one), joined where their edits meet, cut to the
 * changed sentences when a paragraph runs long. Null when the change is too
 * large to read this way.
 */
export function prosePassages(before: string, after: string): ProsePassage[] | null {
  if (before.length + after.length > MAX_TEXT) return null;
  const hunks = phraseHunks(before, after);
  if (hunks.length > MAX_EDITS) return null;

  const ranges: Array<{ from: number; to: number; hunks: typeof hunks }> = [];
  for (const hunk of hunks) {
    const from = before.lastIndexOf("\n", hunk.from - 1) + 1;
    const lineEnd = before.indexOf("\n", hunk.to > hunk.from && before[hunk.to - 1] === "\n" ? hunk.to - 1 : hunk.to);
    const to = Math.max(hunk.to, lineEnd === -1 ? before.length : lineEnd);
    const last = ranges.at(-1);
    if (last && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
      last.hunks.push(hunk);
    } else ranges.push({ from, to, hunks: [hunk] });
  }

  let shift = 0;
  let consumed = 0;
  const passages: ProsePassage[] = [];
  for (const range of ranges) {
    let { from, to } = range;
    const first = range.hunks[0]!;
    const last = range.hunks.at(-1)!;
    let clippedStart = false;
    let clippedEnd = false;
    if (to - from > LONG_PASSAGE) {
      const paragraph = before.slice(from, to);
      const start = from + sentenceStart(paragraph, first.from - from);
      const end = from + sentenceEnd(paragraph, Math.max(0, last.to - from - 1));
      clippedStart = start > from;
      clippedEnd = end < to;
      from = start;
      to = end;
    }
    if (to - from > MAX_PASSAGE) return null;
    // Where the passage starts in the version: earlier edits moved it by their difference in length.
    for (const hunk of hunks.slice(consumed)) {
      if (hunk.from >= from) break;
      shift += hunk.insert.length - (hunk.to - hunk.from);
      consumed += 1;
    }
    const line = after.slice(0, Math.max(0, from + shift)).split("\n").length;
    passages.push({
      line,
      text: before.slice(from, to),
      edits: range.hunks.map((hunk, index) => ({
        id: index, from: hunk.from - from, to: hunk.to - from, insert: hunk.insert, status: "applied" as const,
      })),
      clippedStart,
      clippedEnd,
    });
  }
  return passages;
}
