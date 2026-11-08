/**
 * Review mode's tracked changes, worked out rather than recorded: every
 * difference between the base (the text when review mode was turned on, plus
 * whatever was accepted since) and the text now is one change. Nothing is
 * logged keystroke by keystroke, so an undo, a paste, the agent's edit or a
 * file changed on disk all read the way they leave the text, and a change
 * typed and then typed away is simply gone.
 *
 * A difference is found in two passes: the lines that changed (Myers, as
 * Overleaf's own operations are split in ../overleaf/changed-runs.ts), then
 * the words inside them, so a corrected word reads as that word, not as its
 * whole line removed and retyped. A replacement is a deletion and an
 * insertion at the same place, drawn as both and accepted or rejected as
 * one.
 */
import { ChangeSet, Text, type ChangeDesc } from "@codemirror/state";
import { changedRuns, splitLines } from "../overleaf/changed-runs";
import type { TrackedChange } from "../overleaf/overleaf-realtime-model";

/** `base[baseFrom, baseTo)` became `current[from, to)`. Either side may be empty, never both. */
export type ReviewHunk = { baseFrom: number; baseTo: number; from: number; to: number };

/** Past this many changed lines, or words in one changed stretch, the stretch is one change. */
const LINE_LIMIT = 4_000;
const WORD_LIMIT = 1_500;

/** The writer's own colour for their tracked changes: Word's blue-violet. */
export const REVIEW_HUE = 250;

/**
 * Words, runs of spaces, and single marks. Han, kana and Hangul have no
 * spaces between words, so each character stands alone; a backslash is its
 * own mark, so `\emph` → `\textbf` changes the command's name, not its slash.
 */
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}_])+|[^\S\n]+|\n|./gsu;

const tokens = (text: string): string[] => text.match(TOKEN) ?? [];

/** Every place `base` and `current` differ, in document order. */
export function reviewHunks(base: string, current: string): ReviewHunk[] {
  if (base === current) return [];
  const a = splitLines(base);
  const b = splitLines(current);
  // Most of a long paper is untouched: trim it before matching what is left.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const aMiddle = a.slice(head, a.length - tail);
  const bMiddle = b.slice(head, b.length - tail);
  const runs = changedRuns(aMiddle, bMiddle, LINE_LIMIT)
    ?? [{ aFrom: 0, aTo: aMiddle.length, bFrom: 0, bTo: bMiddle.length }];
  const aStarts = lineStarts(a);
  const bStarts = lineStarts(b);
  const hunks: ReviewHunk[] = [];
  for (const run of runs) {
    const baseFrom = aStarts[head + run.aFrom]!;
    const from = bStarts[head + run.bFrom]!;
    hunks.push(...wordHunks(
      base.slice(baseFrom, aStarts[head + run.aTo]!), current.slice(from, bStarts[head + run.bTo]!), baseFrom, from,
    ));
  }
  return hunks;
}

function lineStarts(lines: readonly string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts.at(-1)! + line.length);
  return starts;
}

/** The word-level changes inside one changed stretch of lines, offset to where it sits. */
function wordHunks(before: string, after: string, baseOffset: number, offset: number): ReviewHunk[] {
  const a = tokens(before);
  const b = tokens(after);
  const runs = changedRuns(a, b, WORD_LIMIT) ?? [{ aFrom: 0, aTo: a.length, bFrom: 0, bTo: b.length }];
  const aStarts = lineStarts(a);
  const bStarts = lineStarts(b);
  const hunks: ReviewHunk[] = [];
  for (const run of runs) {
    const hunk = {
      baseFrom: baseOffset + aStarts[run.aFrom]!, baseTo: baseOffset + aStarts[run.aTo]!,
      from: offset + bStarts[run.bFrom]!, to: offset + bStarts[run.bTo]!,
    };
    const previous = hunks.at(-1);
    // "a b c" → "x y z" matches the spaces and nothing else; three changes
    // a space apart read as the one phrase that was rewritten.
    if (previous && previous.to < hunk.from && /^[^\S\n]+$/.test(after.slice(previous.to - offset, hunk.from - offset))) {
      previous.baseTo = hunk.baseTo;
      previous.to = hunk.to;
    } else hunks.push(hunk);
  }
  // Two words replaced by one also match up a space either way round; the
  // space both sides keep is not part of the change.
  for (const hunk of hunks) {
    const space = (text: string, at: number) => /\s/.test(text[at] ?? "");
    while (hunk.baseTo > hunk.baseFrom && hunk.to > hunk.from
      && before[hunk.baseTo - 1 - baseOffset] === after[hunk.to - 1 - offset] && space(after, hunk.to - 1 - offset)) {
      hunk.baseTo -= 1;
      hunk.to -= 1;
    }
    while (hunk.baseTo > hunk.baseFrom && hunk.to > hunk.from
      && before[hunk.baseFrom - baseOffset] === after[hunk.from - offset] && space(after, hunk.from - offset)) {
      hunk.baseFrom += 1;
      hunk.from += 1;
    }
  }
  return hunks;
}

/**
 * The tracked changes `hunks` describe, positioned in `current`: a deletion
 * at the point its text left (it occupies no offsets, as Overleaf's do), an
 * insertion over the text it added. A replacement gives both, the deletion
 * first, so the struck text reads before what replaced it.
 */
export function reviewChanges(base: string, current: string, hunks: readonly ReviewHunk[]): TrackedChange[] {
  // The id names the hunk, so a change found under the pointer leads back to it.
  return hunks.flatMap((hunk, index): TrackedChange[] => {
    const changes: TrackedChange[] = [];
    const common = { userId: null, timestamp: null, hue: REVIEW_HUE };
    if (hunk.baseTo > hunk.baseFrom) {
      changes.push({ ...common, id: `review:${index}:del`, position: hunk.from, text: base.slice(hunk.baseFrom, hunk.baseTo), deletion: true });
    }
    if (hunk.to > hunk.from) {
      changes.push({ ...common, id: `review:${index}:ins`, position: hunk.from, text: current.slice(hunk.from, hunk.to), deletion: false });
    }
    return changes;
  });
}

/**
 * The base once `hunk` is accepted: what the text has there replaces what
 * the base had. A replacement is accepted or rejected whole: accepting only
 * its insertion would leave the base with both versions run together.
 */
export function acceptedBase(base: string, current: string, hunk: ReviewHunk): string {
  return base.slice(0, hunk.baseFrom) + current.slice(hunk.from, hunk.to) + base.slice(hunk.baseTo);
}

/** The edit to the text that rejects `hunk`: what the base had there comes back. */
export function rejectEdit(base: string, hunk: ReviewHunk): { from: number; to: number; insert: string } {
  return { from: hunk.from, to: hunk.to, insert: base.slice(hunk.baseFrom, hunk.baseTo) };
}

/** The edits that put every hunk back as the base has it: Reject all. */
export function rejectAllEdits(base: string, hunks: readonly ReviewHunk[]) {
  return hunks.map((hunk) => rejectEdit(base, hunk));
}

/**
 * The base after someone else's edit to the text: `remote`, made to the text
 * `before` (which differs from `base` by `hunks`), carried over to the base,
 * so a co-author's words become part of what is reviewed against rather than
 * the writer's own tracked changes.
 *
 * The writer's changes are the edit from the text back to the base, and the
 * co-author's is mapped over it as two concurrent edits are (OT). Text the
 * co-author typed inside one of the writer's insertions lands in the base at
 * that insertion, so rejecting the insertion keeps it; text they deleted that
 * only the writer had added never was in the base. Whether `remote` touched
 * one of the writer's changes is returned too, so that can be said aloud.
 */
export function advancedBase(base: string, before: string, hunks: readonly ReviewHunk[], remote: ChangeSet): { base: string; touched: boolean } {
  const toCurrent = ChangeSet.of(
    hunks.map((hunk) => ({ from: hunk.baseFrom, to: hunk.baseTo, insert: before.slice(hunk.from, hunk.to) })),
    base.length,
  );
  const baseText = Text.of(base.split("\n"));
  const toBase = toCurrent.invert(baseText);
  const mapped = remote.map(toBase);
  return { base: mapped.apply(baseText).toString(), touched: touches(remote, hunks) };
}

/** Whether any of `remote`'s edits overlaps or abuts a hunk, in the text both describe. */
function touches(remote: ChangeDesc, hunks: readonly ReviewHunk[]): boolean {
  let touched = false;
  remote.iterChangedRanges((fromA, toA) => {
    if (hunks.some((hunk) => fromA <= hunk.to && toA >= hunk.from)) touched = true;
  });
  return touched;
}

/**
 * The base after a file went from `before` to `after` outside any editor (an
 * Overleaf sync pulled a co-author's edits into it): `advancedBase` with the
 * edit worked out from the two texts.
 */
export function baseAfterSync(base: string, before: string, after: string): string {
  const remote = ChangeSet.of(
    reviewHunks(before, after).map((hunk) => ({ from: hunk.baseFrom, to: hunk.baseTo, insert: after.slice(hunk.from, hunk.to) })),
    before.length,
  );
  return advancedBase(base, before, reviewHunks(base, before), remote).base;
}
