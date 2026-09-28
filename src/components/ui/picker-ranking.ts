// Ranking shared by the keyboard pickers (quick open and the search pickers).

/**
 * Ranks `hay` against a lowercase `needle` that is not a prefix or substring
 * match: every needle character in order, each step scoring higher the closer
 * it follows the previous one. Zero when the characters do not all appear.
 */
export function subsequenceScore(hay: string, needle: string): number {
  let score = 0;
  let index = 0;
  for (const character of needle) {
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
