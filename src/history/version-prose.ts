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

/** Each Han, kana or Hangul character is one word, as a CJK count reads; otherwise a run of letters or digits is. */
const CJK = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`;
const LETTERS = String.raw`(?:(?!${CJK})[\p{L}\p{M}\p{N}])+`;
const WORD = new RegExp(String.raw`${CJK}|${LETTERS}(?:['’-]${LETTERS})*`, "gu");

const words = (text: string) => text.match(WORD)?.length ?? 0;

/**
 * What is not prose: comments, control sequences, and the arguments of the
 * commands that name rather than say (citations, references, labels,
 * environments, files).
 */
const MARKUP = /(?<!\\)%.*|\\(?:[A-Za-z]*cite[A-Za-z]*|[A-Za-z]*ref|label|begin|end|input[A-Za-z]*|include[A-Za-z]*|graphicspath|usepackage|documentclass|bibliography|bibliographystyle)\*?(?:[ \t]*(?:\[[^\]]*\]|\{(?:[^{}]|\{[^{}]*\})*\}))+|\\(?:[A-Za-z@]+\*?|.)/g;

/** `text` with its markup blanked out, keeping every offset where it was. */
const proseOnly = (text: string) => text.replace(MARKUP, (markup) => " ".repeat(markup.length));

const CJK_CHARACTER = new RegExp(CJK, "u");

/**
 * `removed` and `inserted` without the CJK characters they share at either
 * end: the diff takes an unspaced CJK run as one token, so one changed
 * character replaces the whole run.
 */
function differing(removed: string, inserted: string): [string, string] {
  const a = Array.from(removed);
  const b = Array.from(inserted);
  const shared = (x: string | undefined, y: string | undefined) => x !== undefined && x === y && CJK_CHARACTER.test(x);
  let start = 0;
  while (shared(a[start], b[start])) start += 1;
  let end = 0;
  while (end < Math.min(a.length, b.length) - start && shared(a[a.length - 1 - end], b[b.length - 1 - end])) end += 1;
  return [a.slice(start, a.length - end).join(""), b.slice(start, b.length - end).join("")];
}

/**
 * How many prose words the passages' edits add and remove. Each side is read
 * whole, so an edit inside a citation or a comment counts nothing.
 */
export function changedWords(passages: readonly ProsePassage[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const passage of passages) {
    const before = proseOnly(passage.text);
    let after = "";
    let cursor = 0;
    const inserted: Array<[number, number]> = [];
    for (const edit of passage.edits) {
      after += passage.text.slice(cursor, edit.from);
      inserted.push([after.length, after.length + edit.insert.length]);
      after += edit.insert;
      cursor = edit.to;
    }
    const prose = proseOnly(after + passage.text.slice(cursor));
    passage.edits.forEach((edit, index) => {
      const [from, to] = inserted[index]!;
      const [gone, made] = differing(before.slice(edit.from, edit.to), prose.slice(from, to));
      removed += words(gone);
      added += words(made);
    });
  }
  return { added, removed };
}

const SECTIONING = /\\(section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const LEVELS = ["section", "subsection", "subsubsection"];

/** A heading's text without its markup: `\emph{Fast} attention` reads "Fast attention". */
const plainTitle = (title: string) => title
  .replace(/\\[A-Za-z]+\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, "$1")
  .replace(/\\[A-Za-z]+\*?|[{}~]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/**
 * The section line `line` (1-based) of `source` sits in, numbered as LaTeX
 * numbers it ("§3.2 Training"); an unnumbered one by its title alone. Null
 * before the first heading.
 */
export function sectionAt(source: string, line: number): string | null {
  const counters = [0, 0, 0];
  let found: string | null = null;
  let lineAt = 1;
  let scanned = 0;
  for (const match of source.matchAll(SECTIONING)) {
    for (let index = scanned; index < match.index; index += 1) if (source.charCodeAt(index) === 10) lineAt += 1;
    scanned = match.index;
    if (lineAt > line) break;
    // A commented-out heading is not one.
    const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
    if (/(^|[^\\])%/.test(source.slice(lineStart, match.index))) continue;
    const level = LEVELS.indexOf(match[1]!);
    const title = plainTitle(match[3]!);
    if (match[2]) {
      found = title;
      continue;
    }
    counters[level] += 1;
    counters.fill(0, level + 1);
    found = `§${counters.slice(0, level + 1).join(".")} ${title}`;
  }
  return found;
}

/** The words between two edits that join them into one: spaces, or one short word ("a", "the", "of"). */
const JOINING_GAP = /^\s*(?:[\p{L}\p{N}]{1,3}\s*)?$/u;

/**
 * `passage` as a person would mark it: edits that only a space or a short
 * shared word keep apart join into one, so a rewritten phrase reads as one
 * struck run followed by one new run rather than alternating fragments.
 * Counts are taken before this, so a joined word is not counted as changed.
 */
export function joinedPassage(passage: ProsePassage): ProsePassage {
  const edits: InlineEdit[] = [];
  for (const edit of passage.edits) {
    const last = edits.at(-1);
    const gap = last ? passage.text.slice(last.to, edit.from) : "";
    if (last && JOINING_GAP.test(gap)) {
      edits[edits.length - 1] = { ...last, to: edit.to, insert: last.insert + gap + edit.insert };
    } else edits.push({ ...edit, id: edits.length });
  }
  return { ...passage, edits };
}
