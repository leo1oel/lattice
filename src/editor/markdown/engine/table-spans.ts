/**
 * Merged table cells for the visual engine (spec R-BLK-11, R-FMT-10/11/13,
 * §11.13).
 *
 * GFM has no merged cells, so Lattice records them beside the table: an HTML
 * comment directly above it lists spans as `[row, col, rowspan, colspan]`,
 * with row 0 the header row and body rows counted from 1. Every source cell a
 * span covers repeats the origin cell's text, so the Markdown still reads as a
 * complete table anywhere else. Papers converted from arXiv carry no marker;
 * in paper reading mode their repeated header and stub labels are inferred as
 * spans instead.
 *
 * Cells are compared by a key: the meaning of the cell's content (see
 * `semanticKey`), with an empty cell as the empty string.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */

/** `[row, col, rowspan, colspan]`, row 0 being the header row. */
export type Span = [number, number, number, number];

const MARKER = /^<!--\s*lattice-table-layout:v1\s+(\{[\s\S]*\})\s*-->$/;

/** The spans a layout marker lists, or null when `source` is not a well-formed marker. */
export function readLayoutMarker(source: string): Span[] | null {
  const match = source.trim().match(MARKER);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return null;
  }
  const spans = (parsed as { spans?: unknown }).spans;
  if (!Array.isArray(spans)) return null;
  const valid = spans.every((span) => Array.isArray(span) && span.length === 4
    && span.every((value) => Number.isInteger(value) && value >= 0));
  return valid ? spans as Span[] : null;
}

/** The marker line for `spans`: compact JSON, spans in reading order. */
export function writeLayoutMarker(spans: readonly Span[]): string {
  const ordered = [...spans].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return `<!-- lattice-table-layout:v1 ${JSON.stringify({ spans: ordered })} -->`;
}

/** Whether a line could be a layout marker at all (valid or not). */
export const looksLikeLayoutMarker = (source: string) => /^<!--\s*lattice-table-layout:v1\b/.test(source.trim());

/**
 * Whether `spans` fit `grid`: each is inside the grid, larger than one cell,
 * overlaps no other, and every cell it covers repeats its origin's text.
 */
export function spansFit(grid: readonly (readonly string[])[], spans: readonly Span[]): boolean {
  const taken = grid.map((row) => row.map(() => false));
  for (const [row, col, rowspan, colspan] of spans) {
    if (rowspan < 1 || colspan < 1 || rowspan * colspan < 2) return false;
    if (row + rowspan > grid.length) return false;
    const origin = grid[row]?.[col];
    if (origin === undefined) return false;
    for (let r = row; r < row + rowspan; r += 1) {
      for (let c = col; c < col + colspan; c += 1) {
        if (grid[r]?.[c] === undefined || taken[r]![c]) return false;
        if (grid[r]![c] !== origin) return false;
        taken[r]![c] = true;
      }
    }
  }
  return true;
}

/**
 * Spans a converted paper's table implies (paper reading mode only).
 *
 * A table with a single header row infers nothing: repeated values there are
 * data. A second header level shows as a row that repeats a label directly
 * above it. Within the header levels, each label that repeats must fill an
 * exact rectangle, which becomes one span; any other shape is ambiguous and
 * the table stays unmerged. Below the header, repeats of a label down the
 * first (stub) column merge too.
 */
export function inferPaperSpans(grid: readonly (readonly string[])[]): Span[] {
  const levels = headerLevels(grid);
  if (levels < 2) return [];
  const spans: Span[] = [];
  const seen = grid.map((row) => row.map(() => false));
  for (let row = 0; row < levels; row += 1) {
    for (let col = 0; col < grid[row]!.length; col += 1) {
      const label = grid[row]![col]!;
      if (!label || seen[row]![col]) continue;
      const region = connectedRegion(grid, levels, row, col, label);
      for (const [r, c] of region) seen[r]![c] = true;
      if (region.length < 2) continue;
      const rows = region.map(([r]) => r);
      const cols = region.map(([, c]) => c);
      const top = Math.min(...rows);
      const left = Math.min(...cols);
      const height = Math.max(...rows) - top + 1;
      const width = Math.max(...cols) - left + 1;
      if (height * width !== region.length) return [];
      spans.push([top, left, height, width]);
    }
  }
  for (let row = levels; row < grid.length; row += 1) {
    const label = grid[row]![0];
    if (!label) continue;
    let end = row;
    while (end + 1 < grid.length && grid[end + 1]![0] === label) end += 1;
    if (end > row) spans.push([row, 0, end - row + 1, 1]);
    row = end;
  }
  return spans;
}

/** Header rows: the first, then each row that repeats a non-empty label from the row above in the same column. */
function headerLevels(grid: readonly (readonly string[])[]): number {
  let levels = grid.length ? 1 : 0;
  while (levels < grid.length) {
    const row = grid[levels]!;
    const above = grid[levels - 1]!;
    if (!row.some((cell, col) => cell && cell === above[col])) break;
    levels += 1;
  }
  return levels;
}

/** Cells holding `label` connected to (row, col) within the header levels. */
function connectedRegion(grid: readonly (readonly string[])[], levels: number, row: number, col: number, label: string): [number, number][] {
  const region: [number, number][] = [];
  const visited = new Set<string>();
  const stack: [number, number][] = [[row, col]];
  while (stack.length) {
    const [r, c] = stack.pop()!;
    const key = `${r}:${c}`;
    if (visited.has(key) || r < 0 || r >= levels || grid[r]?.[c] !== label) continue;
    visited.add(key);
    region.push([r, c]);
    stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
  }
  return region;
}

/** Two span lists that describe the same merges, in any order. */
export function sameSpans(left: readonly Span[], right: readonly Span[]): boolean {
  const key = (spans: readonly Span[]) => spans.map((span) => span.join(",")).sort().join(";");
  return key(left) === key(right);
}
