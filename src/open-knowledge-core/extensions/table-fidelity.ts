/**
 * Table / TableCell / TableHeader extension overrides for source-text fidelity.
 *
 * `Table.sourceDashCounts: number[] | null`
 *   Per-column dash counts from the GFM alignment row in the source.
 *   Captured at parse time by position-slice; threaded through PM via
 *   this attr so the reverse PM→mdast walker can re-emit byte-equal
 *   alignment-row markers regardless of cell content width.
 *
 *   `null` means "no source recorded" (e.g., a WYSIWYG-authored table
 *   with no markdown roundtrip yet) — the to-markdown handler falls
 *   through to the canonical-min one-dash form.
 *
 *   The dashes are inherently per-column rather than per-cell, so the attr
 *   lives on the table node (not on each header cell).
 *
 * `TableCell.sourcePadding` / `TableHeader.sourcePadding: { left: number, right: number } | null`
 *   Per-cell padding (count of literal space chars between the surrounding
 *   `|` separators and the cell content) captured at parse time. Drives the
 *   to-markdown table handler to emit the user's chosen widths so hand-
 *   aligned tables (`| h1   | h2  |`) round-trip byte-equal instead of
 *   collapsing to canonical single-space padding.
 *
 *   `null` means "no source recorded" — the handler falls through to the
 *   canonical 1-space-each form (the gfm default). Object PM attrs round-trip
 *   as JSON through Y.js and through prosemirror-model node.attrs serialization.
 */

import { Table, TableCell, TableHeader } from '@tiptap/extension-table';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';

export const TABLE_SPAN_LAYOUT_MARKER = 'lattice-table-layout:v1';

/** row, column, rowspan, colspan in the table's logical grid. */
export type TableSpan = [number, number, number, number];
export type TableSpanLayout = TableSpan[];

export function normalizeTableSpanLayout(value: unknown): TableSpanLayout | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const spans: TableSpanLayout = [];
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length !== 4) return null;
    const [row, column, rowspan, colspan] = candidate;
    if (
      !Number.isInteger(row)
      || !Number.isInteger(column)
      || !Number.isInteger(rowspan)
      || !Number.isInteger(colspan)
      || row < 0
      || column < 0
      || rowspan < 1
      || colspan < 1
      || (rowspan === 1 && colspan === 1)
    ) return null;
    spans.push([row, column, rowspan, colspan]);
  }
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return spans;
}

export function parseTableSpanLayoutMarker(value: string): TableSpanLayout | null {
  const prefix = `${TABLE_SPAN_LAYOUT_MARKER} `;
  if (!value.startsWith(prefix)) return null;
  try {
    const payload = JSON.parse(value.slice(prefix.length)) as { spans?: unknown };
    return payload && typeof payload === 'object'
      ? normalizeTableSpanLayout(payload.spans)
      : null;
  } catch {
    return null;
  }
}

export function serializeTableSpanLayoutMarker(layout: TableSpanLayout): string {
  return `${TABLE_SPAN_LAYOUT_MARKER} ${JSON.stringify({ spans: layout })}`;
}

export function tableSpanLayoutForPmTable(table: PmNode): TableSpanLayout {
  const map = TableMap.get(table);
  if (map.problems) {
    throw new Error(`Cannot derive malformed table span layout: ${JSON.stringify(map.problems)}`);
  }
  const layout: TableSpanLayout = [];
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let column = 0; column < map.width; column++) {
      const position = map.map[row * map.width + column];
      if (position == null || seen.has(position)) continue;
      seen.add(position);
      const cell = table.nodeAt(position);
      if (!cell) continue;
      const rowspan = Number(cell.attrs.rowspan ?? 1);
      const colspan = Number(cell.attrs.colspan ?? 1);
      if (rowspan > 1 || colspan > 1) {
        const rect = map.findCell(position);
        layout.push([rect.top, rect.left, rowspan, colspan]);
      }
    }
  }
  return layout;
}

export const TableFidelity = Table.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDashCounts: { default: null },
      // Outer-pipe style ({ leading, trailing } booleans) recorded only
      // when uniform across every source line and at least one side omits
      // the pipe (`col|val` form). Table-level rather than per-row so the
      // style survives WYSIWYG row insertion/deletion. null = canonical
      // fully-piped emission.
      sourceOuterPipes: { default: null, rendered: false },
      // Per-column alignment-row cell padding — the delimiter-row sibling
      // of the per-cell sourcePadding (`|-|-|` → zero padding instead of
      // the canonical `| - |`). null = canonical 1-space-each.
      sourceAlignmentPadding: { default: null, rendered: false },
      // A non-null layout means the user explicitly edited merged-cell
      // structure. Markdown stays rectangular; a machine-readable adjacent
      // comment restores these spans and suppresses heuristic inference.
      sourceSpanLayout: { default: null, rendered: false },
      // Logical per-column alignment survives visual colspans, whose origin
      // cell otherwise exposes only one scalar alignment for every column it
      // covers. A width mismatch means columns changed and invalidates it.
      sourceColumnAlignments: { default: null, rendered: false },
    };
  },
});

export const TableCellFidelity = TableCell.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourcePadding: { default: null },
    };
  },
});

export const TableHeaderFidelity = TableHeader.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourcePadding: { default: null },
    };
  },
});
