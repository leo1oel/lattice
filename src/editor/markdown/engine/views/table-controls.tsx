/**
 * Table chrome for the visual engine (spec R-BLK-11, R-FMT-10, R-FMT-22):
 * while the caret is in a table, a handle above its column and one beside its
 * row open menus to insert or delete rows and columns, and a small toolbar
 * merges selected cells or splits a merged one.
 *
 * The chrome sits in the editor's own layer, positioned from the table's
 * geometry, and follows the selection on every transaction.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import type { Editor } from "@tiptap/react";
import { CellSelection } from "@tiptap/pm/tables";
import {
  ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Ellipsis, EllipsisVertical, TableCellsMerge, TableCellsSplit, Trash2,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu";
import {
  canMergeCells, canSplitCell, deleteColumn, deleteRow, deleteTable, insertColumn, insertRow, mergeSelectedCells, splitCurrentCell,
  tableContext, tableHasSpans,
} from "../table-commands";

type Geometry = {
  /** The column handle's center and the table's top edge, relative to the chrome layer. */
  column: { x: number; y: number };
  /** The row handle's center and the table's left edge. */
  row: { x: number; y: number };
  /** The span toolbar's anchor: the top center of the selected cells. */
  cells: { x: number; y: number };
  merged: boolean;
  canMerge: boolean;
  canSplit: boolean;
  header: boolean;
};

function measure(editor: Editor, layer: HTMLElement | null): Geometry | null {
  if (!layer || editor.isDestroyed || !editor.isEditable) return null;
  const { state, view } = editor;
  const context = tableContext(state);
  if (!context) return null;
  const table = view.nodeDOM(context.tablePos) as HTMLElement | null;
  const cell = view.nodeDOM(context.cellPos) as HTMLElement | null;
  if (!table || !cell) return null;
  const tableElement = table.querySelector("table") ?? table;
  const origin = layer.getBoundingClientRect();
  const tableRect = tableElement.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  let cellsRect = cellRect;
  const selection = state.selection;
  if (selection instanceof CellSelection) {
    const rects: DOMRect[] = [];
    selection.forEachCell((_node, position) => {
      const element = view.nodeDOM(position) as HTMLElement | null;
      if (element) rects.push(element.getBoundingClientRect());
    });
    if (rects.length) {
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      const top = Math.min(...rects.map((rect) => rect.top));
      cellsRect = new DOMRect(left, top, right - left, 0);
    }
  }
  return {
    column: { x: cellRect.left + cellRect.width / 2 - origin.left, y: tableRect.top - origin.top },
    row: { x: tableRect.left - origin.left, y: cellRect.top + cellRect.height / 2 - origin.top },
    cells: { x: cellsRect.left + cellsRect.width / 2 - origin.left, y: cellsRect.top - origin.top },
    merged: tableHasSpans(context.table),
    canMerge: canMergeCells(state),
    canSplit: canSplitCell(state),
    header: context.rect.top === 0,
  };
}

const same = (left: Geometry | null, right: Geometry | null) => JSON.stringify(left) === JSON.stringify(right);

export function TableControls({ editor, layer, paperMode }: { editor: Editor; layer: HTMLElement | null; paperMode: boolean }) {
  const { t } = useLingui();
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [menu, setMenu] = useState<"row" | "column" | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measure(editor, layer);
        setGeometry((current) => (same(current, next) ? current : next));
      });
    };
    update();
    editor.on("transaction", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", update);
      window.removeEventListener("resize", update);
    };
  }, [editor, layer]);

  if (!geometry) return null;
  const run = (command: (state: Editor["state"], dispatch: Editor["view"]["dispatch"]) => boolean) => () => {
    command(editor.state, editor.view.dispatch);
    editor.view.focus();
  };
  const { state } = editor;
  return (
    <div className="lx-md-table-controls" contentEditable={false}>
      <DropdownMenu open={menu === "column"} onOpenChange={(open) => setMenu(open ? "column" : null)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="lx-md-table-handle"
            data-axis="column"
            data-merged={geometry.merged || undefined}
            aria-label={t`Column options`}
            style={{ left: geometry.column.x, top: geometry.column.y }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuItem disabled={!insertColumn(state, undefined, "left")} onSelect={run((s, d) => insertColumn(s, d, "left"))}>
            <ArrowLeftToLine aria-hidden="true" />{t`Insert column left`}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!insertColumn(state, undefined, "right")} onSelect={run((s, d) => insertColumn(s, d, "right"))}>
            <ArrowRightToLine aria-hidden="true" />{t`Insert column right`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-variant="destructive" disabled={!deleteColumn(state, undefined)} onSelect={run(deleteColumn)}>
            <Trash2 aria-hidden="true" />{t`Delete column`}
          </DropdownMenuItem>
          <DropdownMenuItem data-variant="destructive" onSelect={run(deleteTable)}>
            <Trash2 aria-hidden="true" />{t`Delete table`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu open={menu === "row"} onOpenChange={(open) => setMenu(open ? "row" : null)}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="lx-md-table-handle"
            data-axis="row"
            aria-label={t`Row options`}
            style={{ left: geometry.row.x, top: geometry.row.y }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <EllipsisVertical aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="center" onCloseAutoFocus={(event) => event.preventDefault()}>
          <DropdownMenuItem disabled={geometry.header} onSelect={run((s, d) => insertRow(s, d, "above"))}>
            <ArrowUpToLine aria-hidden="true" />{t`Insert row above`}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={run((s, d) => insertRow(s, d, "below"))}>
            <ArrowDownToLine aria-hidden="true" />{t`Insert row below`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-variant="destructive" disabled={!deleteRow(state, undefined)} onSelect={run(deleteRow)}>
            <Trash2 aria-hidden="true" />{t`Delete row`}
          </DropdownMenuItem>
          <DropdownMenuItem data-variant="destructive" onSelect={run(deleteTable)}>
            <Trash2 aria-hidden="true" />{t`Delete table`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {(geometry.canMerge || geometry.canSplit) && (
        <div className="lx-md-table-span-toolbar" role="toolbar" aria-label={t`Table cells`} style={{ left: geometry.cells.x, top: geometry.cells.y }}>
          {geometry.canMerge && (
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={run(mergeSelectedCells)}>
              <TableCellsMerge aria-hidden="true" />{t`Merge cells`}
            </button>
          )}
          {geometry.canSplit && (
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={run((s, d) => splitCurrentCell(s, d, paperMode))}>
              <TableCellsSplit aria-hidden="true" />{t`Split cell`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
