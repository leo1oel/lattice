import {
  protectedDifference,
  protectedLatexSignature,
  protectedLatexSpans,
  type ProtectedKind,
} from "../editor/latex/latex-protected";

/**
 * One logical change a proofread suggests: replace `[from, to)` of the
 * original selection with `insert`. Edits of one suggestion are ordered and
 * never overlap, so any subset of them applies to the original as is.
 */
export type ProofreadEdit = { id: number; from: number; to: number; insert: string };

/** An edit that would have altered protected LaTeX, and so is never offered. */
export type HeldProofreadEdit = ProofreadEdit & { kind: ProtectedKind };

/** A suggestion split into the edits the writer may choose from and the ones held back. */
export type ProofreadReview = { edits: ProofreadEdit[]; held: HeldProofreadEdit[] };

/**
 * The document text around a selection that its protected LaTeX needs to
 * parse the same way: from the start of a span the selection begins inside
 * (math, a `\cite{…}`) and to the end of one it ends inside. Each is empty
 * when the selection edge sits in prose.
 */
export type ProofreadContext = { before: string; after: string };

export function proofreadContext(doc: string, from: number, to: number): ProofreadContext {
  let start = from;
  let end = to;
  // A span ending exactly at an edge counts too: text typed against `\foo`
  // would become part of the command's name.
  for (const span of protectedLatexSpans(doc, to + 1)) {
    if (span.from < from && span.to >= from) start = Math.min(start, span.from);
    if (span.from <= to && span.to > to) end = Math.max(end, span.to);
  }
  return { before: doc.slice(start, from), after: doc.slice(to, end) };
}

/** Words, LaTeX control sequences, runs of spaces, line breaks, and single other characters. */
const TOKEN = /\\(?:[A-Za-z@]+|.)|[\p{L}\p{N}\p{M}]+|[^\S\n]+|\n|./gsu;

type Token = { text: string; from: number };

const tokenize = (text: string): Token[] => [...text.matchAll(TOKEN)].map((match) => ({ text: match[0], from: match.index }));

/** Past this many token edits a suggestion is a rewrite; it is reviewed as one change. */
const MAX_DIFF_DISTANCE = 1_500;

/**
 * Index pairs of the tokens `a` and `b` share, in order (Myers' shortest
 * edit script). Null when the two differ by more than `MAX_DIFF_DISTANCE`.
 * Each round keeps only the diagonals it could reach, so memory is the square
 * of the edit distance rather than of the text length.
 */
function commonTokens(a: string[], b: string[]): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m + 1;
  const frontier = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  for (let distance = 0; distance <= Math.min(n + m, MAX_DIFF_DISTANCE); distance += 1) {
    trace.push(frontier.slice(offset - distance, offset + distance + 1));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || (diagonal !== distance && frontier[offset + diagonal - 1] < frontier[offset + diagonal + 1]);
      let x = down ? frontier[offset + diagonal + 1] : frontier[offset + diagonal - 1] + 1;
      let y = x - diagonal;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + diagonal] = x;
      if (x >= n && y >= m) return backtrack(trace, distance, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], distance: number, n: number, m: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let round = distance; round > 0; round -= 1) {
    // The frontier before `round`, indexed from diagonal -round.
    const frontier = trace[round]!;
    const at = (diagonal: number) => frontier[diagonal + round]!;
    const diagonal = x - y;
    const down = diagonal === -round || (diagonal !== round && at(diagonal - 1) < at(diagonal + 1));
    const previous = down ? diagonal + 1 : diagonal - 1;
    const previousX = at(previous);
    const previousY = previousX - previous;
    const startX = down ? previousX : previousX + 1;
    while (x > startX) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

type Hunk = { from: number; to: number; insert: string };

/** The token-level changes from `original` to `revised`, in original offsets. */
function tokenHunks(original: string, revised: string): Hunk[] {
  const a = tokenize(original);
  const b = tokenize(revised);
  let start = 0;
  while (start < a.length && start < b.length && a[start]!.text === b[start]!.text) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1]!.text === b[endB - 1]!.text) {
    endA -= 1;
    endB -= 1;
  }
  const offsetOf = (index: number) => index < a.length ? a[index]!.from : original.length;
  const textOf = (tokens: Token[], from: number, to: number) => tokens.slice(from, to).map((token) => token.text).join("");
  const pairs = commonTokens(a.slice(start, endA).map((token) => token.text), b.slice(start, endB).map((token) => token.text))
    ?? [];
  const hunks: Hunk[] = [];
  let i = start;
  let j = start;
  for (const [x, y] of [...pairs.map(([x, y]): [number, number] => [x + start, y + start]), [endA, endB] as [number, number]]) {
    if (x > i || y > j) hunks.push({ from: offsetOf(i), to: offsetOf(x), insert: textOf(b, j, y) });
    i = x + 1;
    j = y + 1;
  }
  return hunks;
}

const hasSpace = (text: string) => /\s/.test(text);

/** A change that swaps one word for another, as a spelling or agreement fix does. */
const swapsWord = (original: string, hunk: Hunk) => {
  const deleted = original.slice(hunk.from, hunk.to);
  return Boolean(deleted && hunk.insert) && !hasSpace(deleted) && !hasSpace(hunk.insert);
};

/**
 * Token changes joined into the edits a writer would name. Changes touching
 * the same run of non-space characters belong together (`state of the art`
 * → `state-of-the-art` is one edit, not three). Across a single space, two
 * word swaps stay separate (`teh` and `wich` are two fixes), but a word
 * added or dropped joins its neighbour: `In this` → `This` is one rewording.
 */
function logicalGroups(original: string, hunks: Hunk[]): Hunk[][] {
  const groups: Hunk[][] = [];
  for (const hunk of hunks) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    const gap = last ? original.slice(last.to, hunk.from) : "";
    const joins = last && (!hasSpace(gap)
      || (/^[^\S\n]+$/.test(gap) && !(swapsWord(original, last) && swapsWord(original, hunk))));
    if (group && joins) group.push(hunk);
    else groups.push([hunk]);
  }
  return groups;
}

const joinHunks = (original: string, hunks: Hunk[]): Hunk => ({
  from: hunks[0]!.from,
  to: hunks.at(-1)!.to,
  insert: hunks.map((hunk, index) => index === 0 ? hunk.insert : original.slice(hunks[index - 1]!.to, hunk.from) + hunk.insert).join(""),
});

/** `hunk` without the spaces it deletes and inserts alike at either end (`In this␠` → `This␠`). */
function trimSharedSpace(original: string, hunk: Hunk): Hunk {
  let { from, to, insert } = hunk;
  while (to > from && insert && /\s/.test(insert.at(-1)!) && original[to - 1] === insert.at(-1)) {
    to -= 1;
    insert = insert.slice(0, -1);
  }
  while (to > from && insert && /\s/.test(insert[0]!) && original[from] === insert[0]) {
    from += 1;
    insert = insert.slice(1);
  }
  return { from, to, insert };
}

/** The offered edits the writer has not rejected, in order. */
export function chosenEdits(review: ProofreadReview, rejected: ReadonlySet<number>): ProofreadEdit[] {
  return review.edits.filter((edit) => !rejected.has(edit.id));
}

/** `original` with `edits` applied; the edits must come from one review. */
export function applyProofreadEdits(original: string, edits: readonly Hunk[]): string {
  let result = "";
  let cursor = 0;
  for (const edit of [...edits].sort((left, right) => left.from - right.from)) {
    result += original.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }
  return result + original.slice(cursor);
}

/**
 * Which protected LaTeX `revised` changed relative to `original`, read in
 * the selection's context; null when math, citations, comments, commands and
 * structure all survived byte for byte.
 */
export function protectedChange(original: string, revised: string, context: ProofreadContext): ProtectedKind | null {
  const read = (text: string) => protectedLatexSignature(context.before + text + context.after);
  return protectedDifference(read(original), read(revised));
}

/**
 * Split a suggestion into logical edits and hold back every one that would
 * alter protected LaTeX. An unsafe edit joined from several token changes is
 * re-checked change by change, so a safe spelling fix is still offered when
 * the model also touched a citation next to it.
 */
export function reviewProofread(original: string, revised: string, context: ProofreadContext): ProofreadReview {
  const reference = protectedLatexSignature(context.before + original + context.after);
  const breaks = (hunk: Hunk) => protectedDifference(
    reference,
    protectedLatexSignature(context.before + applyProofreadEdits(original, [hunk]) + context.after),
  );
  const review: ProofreadReview = { edits: [], held: [] };
  const record = (hunk: Hunk, kind: ProtectedKind | null) => {
    const edit = { id: review.edits.length + review.held.length, ...trimSharedSpace(original, hunk) };
    if (kind) review.held.push({ ...edit, kind });
    else review.edits.push(edit);
  };
  for (const group of logicalGroups(original, tokenHunks(original, revised))) {
    const joined = joinHunks(original, group);
    const kind = breaks(joined);
    const parts = kind && group.length > 1 ? group.map((hunk) => ({ hunk, kind: breaks(hunk) })) : [];
    // Split only to rescue a safe part; an edit unsafe throughout is held whole.
    if (parts.some((part) => !part.kind)) for (const part of parts) record(part.hunk, part.kind);
    else record(joined, kind);
  }
  return review;
}

/** An edit as the card lists it: a little unchanged text around what it deletes and inserts. */
export type ProofreadEditPreview = { before: string; deleted: string; inserted: string; after: string };

/** How far the preview widens an edit to whole words, and how much context it shows. */
const WORD_LIMIT = 32;
const CONTEXT_REACH = 120;

/** Spaces and line breaks made visible when they are all an edit changes. */
const visible = (text: string) => text && !text.trim()
  ? text.replace(/\n/g, "↵").replace(/[^\S\n]/g, "␣")
  : text.replace(/\s+/g, " ");

const isWordCharacter = (char: string | undefined) => Boolean(char?.trim());

export function proofreadEditPreview(original: string, edit: Hunk): ProofreadEditPreview {
  // Widen to whole words when the edit cuts into one, so `␣of␣the␣` → `-of-the-`
  // reads as `state of the art` → `state-of-the-art`.
  const deleted = original.slice(edit.from, edit.to);
  let from = edit.from;
  let to = edit.to;
  if (isWordCharacter(deleted[0]) || isWordCharacter(edit.insert[0])) {
    while (from > 0 && edit.from - from < WORD_LIMIT && isWordCharacter(original[from - 1])) from -= 1;
  }
  if (isWordCharacter(deleted.at(-1)) || isWordCharacter(edit.insert.at(-1))) {
    while (to < original.length && to - edit.to < WORD_LIMIT && isWordCharacter(original[to])) to += 1;
  }
  const lead = original.slice(Math.max(0, from - CONTEXT_REACH), from);
  const before = /(?:\S+\s*){0,3}$/.exec(lead)!;
  const trail = original.slice(to, to + CONTEXT_REACH);
  const after = /^(?:\s*\S+){0,3}/.exec(trail)!;
  const moreBefore = from > CONTEXT_REACH || Boolean(lead.slice(0, before.index).trim());
  const moreAfter = Boolean(original.slice(to + after[0].length).trim());
  return {
    before: `${moreBefore ? "…" : ""}${before[0].replace(/\s+/g, " ").trimStart()}`,
    deleted: visible(original.slice(from, to)),
    inserted: visible(original.slice(from, edit.from) + edit.insert + original.slice(edit.to, to)),
    after: `${after[0].replace(/\s+/g, " ").trimEnd()}${moreAfter ? "…" : ""}`,
  };
}
