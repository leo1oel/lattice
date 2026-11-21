/**
 * Column widths for the visual engine's tables (GPUI's Markdown island asks
 * for them through `tableColumnWidths`, visual-editor-props.ts): a pointer
 * on a column's border shows the resize cursor, a drag sets that column's
 * width (never under {@link MIN_COLUMN_WIDTH}), and a double-click fits it to
 * its content.
 *
 * The widths are the host's to keep, never the document's: no attribute,
 * mark or Markdown carries them, so the file stays plain GFM and every other
 * reader of it sees nothing. A table is named by its index among the
 * document's tables in reading order; widths for a column count the table no
 * longer has are given back to the host as dropped. Without a host asking,
 * the plugin draws nothing and handles no event, so a table is laid out as
 * before.
 *
 * Widths reach the table as a node decoration's spec, which
 * {@link SizedTableView} applies to the colgroup it owns (ProseMirror
 * ignores mutations outside a table's cells), so they are CSS pixels set on
 * `<col>` with a fixed layout. While a drag is under way, and until the host
 * keeps the committed widths, the plugin's own overlay is drawn instead; the
 * host's widths are read again with every transaction, so a change of them
 * needs no message of its own.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import { TableView } from "@tiptap/extension-table";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { TableMap, cellAround } from "@tiptap/pm/tables";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** What the host keeps of the open file's tables, by table index. */
export type TableColumnWidths = {
  widths: Readonly<Record<number, readonly number[]>>;
  /** A table's widths were set, or dropped (null). */
  onChange: (table: number, widths: number[] | null) => void;
};

/** The narrowest a dragged or fitted column gets, in CSS pixels. */
export const MIN_COLUMN_WIDTH = 48;
/** How near a cell's edge, in CSS pixels, the pointer starts a resize. */
const EDGE = 5;

type Overlay = Readonly<Record<number, readonly number[]>>;
type WidthsState = {
  /** The host's widths these were drawn from. */
  saved: Overlay;
  /** Each table's position, in reading order. */
  tables: number[];
  /** Saved widths that no longer fit their table's columns. */
  stale: number[];
  overlay: Overlay;
  decorations: DecorationSet;
};
type Meta = { overlay: { table: number; widths: number[] } };

const tableWidthsKey = new PluginKey<WidthsState>("latticeTableColumnWidths");

/** The widths a table's decorations carry, when it has any. */
function decoratedWidths(decorations: readonly Decoration[]): readonly number[] | null {
  for (const decoration of decorations) {
    const widths = (decoration.spec as { columnWidths?: readonly number[] | null }).columnWidths;
    if (widths) return widths;
  }
  return null;
}

/** Tiptap's table view, sized by the widths its decorations carry. */
export class SizedTableView extends TableView {
  constructor(node: PmNode, cellMinWidth: number, view: EditorView, attributes: Record<string, unknown>, decorations: readonly Decoration[]) {
    super(node, cellMinWidth, view, attributes);
    this.size(decorations);
  }

  override update(node: PmNode, decorations: readonly Decoration[] = []): boolean {
    if (!super.update(node)) return false;
    this.size(decorations);
    return true;
  }

  private size(decorations: readonly Decoration[]) {
    const widths = decoratedWidths(decorations);
    Array.from(this.colgroup.children as HTMLCollectionOf<HTMLElement>).forEach((col, column) => {
      col.style.width = widths ? `${widths[column]}px` : "";
    });
    this.table.toggleAttribute("data-sized", Boolean(widths));
    if (!widths) {
      this.table.style.tableLayout = "";
      return;
    }
    this.table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    this.table.style.minWidth = "";
    this.table.style.tableLayout = "fixed";
  }
}

const isTable = (node: PmNode) => node.type.spec.tableRole === "table";

function computeState(doc: PmNode, saved: Overlay, overlay: Overlay): WidthsState {
  const tables: number[] = [];
  const stale: number[] = [];
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!isTable(node)) return !node.isTextblock && !node.isAtom;
    const table = tables.length;
    tables.push(pos);
    const columns = TableMap.get(node).width;
    const own = overlay[table] ?? saved[table];
    const fits = own && own.length === columns ? own : null;
    if (own && !fits && !overlay[table]) stale.push(table);
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { "data-lx-table": String(table) }, { columnWidths: fits }));
    return false;
  });
  return { saved, tables, stale, overlay, decorations: DecorationSet.create(doc, decorations) };
}

const INACTIVE: WidthsState = { saved: {}, tables: [], stale: [], overlay: {}, decorations: DecorationSet.empty };

const sameWidths = (left: readonly number[] | undefined, right: readonly number[]) => (
  left?.length === right.length && left.every((width, column) => width === right[column])
);

/** The overlay less the tables whose widths the host now keeps as drawn. */
function pendingOverlay(overlay: Overlay, saved: Overlay): Overlay {
  return Object.fromEntries(Object.entries(overlay).filter(([table, widths]) => !sameWidths(saved[Number(table)], widths)));
}

/** A column border under the pointer: its table and the column left of it. */
type Border = { table: number; tablePos: number; column: number };

function borderAt(view: EditorView, event: MouseEvent): Border | null {
  const target = event.target instanceof Element ? event.target : null;
  const cell = target?.closest<HTMLElement>("td, th");
  if (!cell || !view.dom.contains(cell)) return null;
  const rect = cell.getBoundingClientRect();
  const scale = cell.offsetWidth ? rect.width / cell.offsetWidth : 1;
  const edge = EDGE * scale;
  const side = event.clientX >= rect.right - edge ? 1 : event.clientX <= rect.left + edge ? -1 : 0;
  if (!side) return null;
  const $cell = cellAround(view.state.doc.resolve(view.posAtDOM(cell, 0)));
  if (!$cell) return null;
  const tableStart = $cell.start(-1);
  const map = TableMap.get($cell.node(-1));
  const found = map.findCell($cell.pos - tableStart);
  const column = side > 0 ? found.right - 1 : found.left - 1;
  const table = tableWidthsKey.getState(view.state)?.tables.indexOf(tableStart - 1) ?? -1;
  return column < 0 || table < 0 ? null : { table, tablePos: tableStart - 1, column };
}

/** The table element drawn for the table at `pos`. */
function tableElement(view: EditorView, pos: number): HTMLTableElement | null {
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  return dom instanceof HTMLTableElement ? dom : dom?.querySelector("table") ?? null;
}

/** Each column's cells that span it alone, as drawn. */
function columnCells(view: EditorView, pos: number, table: PmNode, column: number): HTMLElement[] {
  const map = TableMap.get(table);
  const seen = new Set<number>();
  const cells: HTMLElement[] = [];
  for (let row = 0; row < map.height; row += 1) {
    const offset = map.map[row * map.width + column]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    if (table.nodeAt(offset)?.attrs.colspan !== 1) continue;
    const dom = view.nodeDOM(pos + 1 + offset);
    if (dom instanceof HTMLElement) cells.push(dom);
  }
  return cells;
}

/** The table's columns as drawn now, in CSS pixels. */
function drawnWidths(view: EditorView, pos: number, table: PmNode): number[] {
  const map = TableMap.get(table);
  return Array.from({ length: map.width }, (_, column) => {
    const cell = columnCells(view, pos, table, column)[0];
    if (cell) return cell.offsetWidth;
    const offset = map.map[column]!;
    const spanning = view.nodeDOM(pos + 1 + offset);
    const colspan = (table.nodeAt(offset)?.attrs.colspan as number | undefined) ?? 1;
    return spanning instanceof HTMLElement ? spanning.offsetWidth / colspan : MIN_COLUMN_WIDTH;
  }).map((width) => Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

/**
 * The width `column` takes for its content: the table is laid out once with
 * that column free and the table as wide as its content, and put back before
 * anything paints. No wider than the table's frame, so one long cell does
 * not make a column the reader must scroll across.
 */
function fittedWidth(view: EditorView, pos: number, table: PmNode, column: number): number {
  const element = tableElement(view, pos);
  const col = element?.querySelector("colgroup")?.children[column] as HTMLElement | undefined;
  if (!element || !col) return MIN_COLUMN_WIDTH;
  const kept = { width: element.style.width, minWidth: element.style.minWidth, layout: element.style.tableLayout, col: col.style.width };
  element.style.tableLayout = "auto";
  element.style.width = "max-content";
  element.style.minWidth = "";
  col.style.width = "";
  const widest = Math.max(0, ...columnCells(view, pos, table, column).map((cell) => cell.offsetWidth));
  element.style.tableLayout = kept.layout;
  element.style.width = kept.width;
  element.style.minWidth = kept.minWidth;
  col.style.width = kept.col;
  const frame = element.parentElement?.clientWidth || Infinity;
  return Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(widest, frame)));
}

/** The pointer's side of a resize: the cursor, the drag, the fit. */
class ColumnResize {
  private hovering = false;
  private dragging = false;
  private reported = new Set<number>();

  constructor(private readonly view: EditorView, private readonly source: () => TableColumnWidths | undefined) {}

  /** The widths the table has now: its own, or as drawn. */
  private widthsOf(border: Border, table: PmNode): number[] {
    const state = tableWidthsKey.getState(this.view.state);
    const own = state?.overlay[border.table] ?? this.source()?.widths[border.table];
    const columns = TableMap.get(table).width;
    return own && own.length === columns ? [...own] : drawnWidths(this.view, border.tablePos, table);
  }

  private show(widths: number[], table: number) {
    const meta: Meta = { overlay: { table, widths } };
    this.view.dispatch(this.view.state.tr.setMeta(tableWidthsKey, meta).setMeta("addToHistory", false));
  }

  private setCursor(on: boolean) {
    if (on === this.hovering) return;
    this.hovering = on;
    const frame = this.view.dom.closest<HTMLElement>(".lx-md-editor") ?? this.view.dom.parentElement;
    if (on) frame?.setAttribute("data-column-resize", "");
    else frame?.removeAttribute("data-column-resize");
  }

  move(event: MouseEvent) {
    if (this.dragging) return;
    this.setCursor(Boolean(this.source() && borderAt(this.view, event)));
  }

  leave() {
    if (!this.dragging) this.setCursor(false);
  }

  /** A press on a border: a double-click fits the column, else the press drags it. */
  down(event: MouseEvent): boolean {
    const host = this.source();
    if (!host || event.button !== 0) return false;
    const border = borderAt(this.view, event);
    const table = border ? this.view.state.doc.nodeAt(border.tablePos) : null;
    if (!border || !table) return false;
    event.preventDefault();
    const widths = this.widthsOf(border, table);
    if (event.detail >= 2) {
      widths[border.column] = fittedWidth(this.view, border.tablePos, table, border.column);
      this.show(widths, border.table);
      host.onChange(border.table, widths);
      return true;
    }
    const element = tableElement(this.view, border.tablePos);
    const scale = element?.offsetWidth ? element.getBoundingClientRect().width / element.offsetWidth : 1;
    const start = event.clientX;
    const from = widths[border.column]!;
    let moved = false;
    this.dragging = true;
    const drag = (moveEvent: MouseEvent) => {
      const width = Math.max(MIN_COLUMN_WIDTH, Math.round(from + (moveEvent.clientX - start) / (scale || 1)));
      if (width === widths[border.column]) return;
      moved = true;
      widths[border.column] = width;
      this.show([...widths], border.table);
    };
    const end = () => {
      window.removeEventListener("mousemove", drag);
      window.removeEventListener("mouseup", end);
      this.dragging = false;
      if (moved) host.onChange(border.table, [...widths]);
    };
    window.addEventListener("mousemove", drag);
    window.addEventListener("mouseup", end);
    return true;
  }

  /** Saved widths that no longer fit their table go back to the host as dropped, once each. */
  update(state: EditorState) {
    const host = this.source();
    const stale = tableWidthsKey.getState(state)?.stale ?? [];
    if (!host || this.dragging) return;
    for (const table of stale) {
      if (this.reported.has(table)) continue;
      this.reported.add(table);
      host.onChange(table, null);
    }
    this.reported = new Set([...this.reported].filter((table) => stale.includes(table)));
  }
}

const resizers = new WeakMap<EditorView, ColumnResize>();

export const TableColumnWidthsExtension = Extension.create<{ source: () => TableColumnWidths | undefined }>({
  name: "latticeTableColumnWidths",
  addOptions: () => ({ source: () => undefined }),
  addProseMirrorPlugins() {
    const { source } = this.options;
    return [new Plugin<WidthsState>({
      key: tableWidthsKey,
      state: {
        init: (_config, state) => (source() ? computeState(state.doc, source()!.widths, {}) : INACTIVE),
        apply: (transaction, value, _previous, state) => {
          const host = source();
          if (!host) return INACTIVE;
          const meta = transaction.getMeta(tableWidthsKey) as Meta | undefined;
          if (!meta && !transaction.docChanged && value !== INACTIVE && host.widths === value.saved) return value;
          const overlay = meta ? { ...value.overlay, [meta.overlay.table]: meta.overlay.widths } : value.overlay;
          return computeState(state.doc, host.widths, pendingOverlay(overlay, host.widths));
        },
      },
      props: {
        decorations: (state) => tableWidthsKey.getState(state)?.decorations,
        handleDOMEvents: {
          mousemove: (view, event) => {
            resizers.get(view)?.move(event);
            return false;
          },
          mouseleave: (view) => {
            resizers.get(view)?.leave();
            return false;
          },
          mousedown: (view, event) => resizers.get(view)?.down(event) ?? false,
        },
      },
      view: (view) => {
        const resize = new ColumnResize(view, source);
        resizers.set(view, resize);
        return { update: (next) => resize.update(next.state), destroy: () => resizers.delete(view) };
      },
    })];
  },
});
