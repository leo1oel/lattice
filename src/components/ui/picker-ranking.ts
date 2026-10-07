// Ranking shared by the keyboard pickers (quick open and the search pickers).

/**
 * Ranks `hay` against a lowercase `needle` that is not a prefix or substring
 * match: every needle character in order, each step scoring higher the closer
 * it follows the previous one. Zero when the characters do not all appear.
 * Spaces only separate the parts, so "note 12" finds notes/note-012.md.
 */
export function subsequenceScore(hay: string, needle: string): number {
  let score = 0;
  let index = 0;
  for (const character of needle.replace(/\s+/g, "")) {
    const next = hay.indexOf(character, index);
    if (next < 0) return 0;
    score += 10 - Math.min(9, next - index);
    index = next + 1;
  }
  return score;
}

/** Scores with `score`, drops non-matches, and keeps the best `limit` in rank order. */
export function rankMatches<T>(
  items: readonly T[],
  score: (item: T) => number,
  tieBreak: (left: T, right: T) => number,
  limit: number,
): T[] {
  return items
    .map((item) => ({ item, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || tieBreak(left.item, right.item))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** What a picker row says, as far as ranking goes. */
type RankedRow = { label: string; detail?: string; group?: string; keywords?: string };

/** Whether `hay[at]` starts a word: the first character, or one after a space or separator. */
const wordStart = (hay: string, at: number) => at === 0 || /[\s/._\-·(]/.test(hay[at - 1]!);

/**
 * How well `item` matches `query`, zero for no match. The label leads (whole,
 * then its start), then a run of the query anywhere in what the row says,
 * higher at the start of a word; then every spaced part of the query somewhere
 * ("agent show" finds Show Agent), then its characters in order.
 */
export function scoreItem(item: RankedRow, query: string): number {
  const needle = query.toLocaleLowerCase();
  if (!needle) return 1;
  const label = item.label.toLocaleLowerCase();
  if (label === needle) return 1000;
  if (label.startsWith(needle)) return 950;
  const hay = `${label} ${item.detail ?? ""} ${item.group ?? ""} ${item.keywords ?? ""}`.toLocaleLowerCase();
  const at = hay.indexOf(needle);
  if (at >= 0) return (wordStart(hay, at) ? 700 : 500) - Math.min(at, 200);
  const terms = needle.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((term) => hay.includes(term))) return 280;
  return Math.min(250, subsequenceScore(hay, needle));
}

/** How well a project path matches `query`: its whole, its file name, a run of it, then its characters in order. */
export function scorePath(path: string, query: string): number {
  const hay = path.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 1;
  if (hay === needle) return 1000;
  if (hay.endsWith(`/${needle}`)) return 900;
  if (hay.includes(needle)) return 500 - hay.indexOf(needle);
  return subsequenceScore(hay, needle);
}
