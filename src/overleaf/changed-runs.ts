/**
 * Where two versions of a document differ, as separate runs of lines.
 *
 * Most edits are one contiguous change, and trimming the common prefix and
 * suffix finds it exactly. Some are not: a replace-all, a rename, an agent's
 * edit or a file changed on disk can touch distant places within one send.
 * Trimmed alone, that reads as rewriting everything from the first change to
 * the last — harmless as a plain edit, but sent as a suggestion it proposes
 * deleting and retyping every paragraph in between. Matching the lines in the
 * middle (Myers' shortest edit script) keeps each change to itself.
 */

/** A run of `a`'s lines `[aFrom, aTo)` that became `b`'s lines `[bFrom, bTo)`. */
export type ChangedRun = { aFrom: number; aTo: number; bFrom: number; bTo: number };

/** Lines of `text`, each keeping its own line break, so they join back into it. */
export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * The runs where line lists `a` and `b` differ, in order, or null when more
 * than `limit` lines were added or removed — past that, matching costs more
 * than one broad change saves.
 */
export function changedRuns(a: readonly string[], b: readonly string[], limit: number): ChangedRun[] | null {
  const n = a.length;
  const m = b.length;
  // rounds[d][k + d]: how far along `a` the furthest d-edit path on diagonal
  // k (= x - y) reaches, or -1 when no such path stays inside the grid.
  const rounds: Int32Array[] = [];
  for (let d = 0; d <= Math.min(limit, n + m); d += 1) {
    const reach = new Int32Array(2 * d + 1).fill(-1);
    rounds.push(reach);
    for (let k = -d; k <= d; k += 2) {
      const x = d === 0 ? 0 : start(rounds[d - 1]!, d, k, n, m)?.x;
      if (x == null) continue;
      let end = x;
      while (end < n && end - k < m && a[end] === b[end - k]) end += 1;
      reach[k + d] = end;
      if (end === n && end - k === m) return runsOf(matches(rounds, n, m), n, m);
    }
  }
  return null;
}

/**
 * Where a d-edit path on diagonal k begins its final stretch of matching
 * lines: one line further along `a` than the best (d-1)-path on diagonal
 * k - 1 (a line removed), or level with the one on k + 1 (a line added).
 */
function start(previous: Int32Array, d: number, k: number, n: number, m: number): { x: number; from: number } | null {
  const at = (diagonal: number) => (Math.abs(diagonal) <= d - 1 ? previous[diagonal + d - 1]! : -1);
  const removed = at(k - 1) >= 0 && at(k - 1) + 1 <= n && at(k - 1) + 1 - k <= m ? at(k - 1) + 1 : -1;
  const added = at(k + 1) >= 0 && at(k + 1) - k <= m && at(k + 1) - k >= 0 ? at(k + 1) : -1;
  if (removed < 0 && added < 0) return null;
  return removed > added ? { x: removed, from: k - 1 } : { x: added, from: k + 1 };
}

/** The matched line pairs `[x, y]` along the path that reached `(n, m)`, in order. */
function matches(rounds: Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = rounds.length - 1; d >= 0; d -= 1) {
    const k = x - y;
    const from = d === 0 ? { x: 0, from: 0 } : start(rounds[d - 1]!, d, k, n, m)!;
    while (x > from.x) {
      x -= 1;
      y -= 1;
      pairs.push([x, y]);
    }
    if (d === 0) break;
    x = rounds[d - 1]![from.from + d - 1]!;
    y = x - from.from;
  }
  return pairs.reverse();
}

function runsOf(pairs: [number, number][], n: number, m: number): ChangedRun[] {
  const runs: ChangedRun[] = [];
  let x = 0;
  let y = 0;
  for (const [mx, my] of [...pairs, [n, m] as [number, number]]) {
    if (mx > x || my > y) runs.push({ aFrom: x, aTo: mx, bFrom: y, bTo: my });
    x = mx + 1;
    y = my + 1;
  }
  return runs;
}
