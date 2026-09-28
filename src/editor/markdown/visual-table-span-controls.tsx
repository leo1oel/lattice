import { useId } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap, mergeCells, splitCell } from "@tiptap/pm/tables";
import { TableCellsMerge, TableCellsSplit } from "lucide-react";
import { Button } from "@ok-app/components/ui/button";
import { tableSpanLayoutForPmTable } from "../../open-knowledge-core/extensions/table-fidelity";
import { notifyInfo } from "../../telemetry/app-notify";

function tableContextAt($position: ResolvedPos): { table: PmNode; tablePosition: number } | null {
  for (let depth = $position.depth; depth > 0; depth--) {
    const node = $position.node(depth);
    if (node.type.spec.tableRole === "table" || node.type.name === "table") {
      return { table: node, tablePosition: $position.before(depth) };
    }
  }
  return null;
}

const isMultiCellSelection = (selection: unknown) => (
  selection instanceof CellSelection && selection.$anchorCell.pos !== selection.$headCell.pos
);

function selectedTableCellContext(editor: Editor) {
  const { selection } = editor.state;
  if (selection instanceof CellSelection) {
    const cell = selection.$anchorCell.nodeAfter;
    const context = isMultiCellSelection(selection) ? null : tableContextAt(selection.$anchorCell);
    return cell && context ? { ...context, cell, cellPosition: selection.$anchorCell.pos } : null;
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    const role = node.type.spec.tableRole;
    if (role !== "cell" && role !== "header_cell") continue;
    const context = tableContextAt($from);
    return context ? { ...context, cell: node, cellPosition: $from.before(depth) } : null;
  }
  return null;
}

const isEmptyCell = (cell: PmNode) => (
  cell.childCount === 1 && Boolean(cell.firstChild?.isTextblock) && cell.firstChild!.content.size === 0
);

function tableSpanControlState(editor: Editor): "merge" | "merge-disabled" | "split" | null {
  if (!editor.isEditable) return null;
  if (isMultiCellSelection(editor.state.selection)) return mergeCells(editor.state) ? "merge" : "merge-disabled";
  return splitCell(editor.state) ? "split" : null;
}

function markSelectedTableLayoutExplicit(transaction: Transaction): boolean {
  const { selection } = transaction;
  const context = tableContextAt(selection instanceof CellSelection ? selection.$anchorCell : selection.$from);
  const table = context && transaction.doc.nodeAt(context.tablePosition);
  if (!context || !table) return false;
  transaction.setNodeMarkup(context.tablePosition, undefined, {
    ...table.attrs,
    sourceSpanLayout: tableSpanLayoutForPmTable(table),
  });
  return true;
}

function mergeSelectedTableCells(editor: Editor): void {
  if (tableSpanControlState(editor) !== "merge") {
    notifyInfo("Table", "Select a complete rectangular group of cells.");
    return;
  }
  const { selection } = editor.state;
  const populated: PmNode[] = [];
  (selection as CellSelection).forEachCell((cell) => {
    if (!isEmptyCell(cell)) populated.push(cell);
  });
  // ProseMirror preserves different cell contents as separate blocks in the
  // merged cell. Only clear duplicates when every populated cell is identical,
  // which keeps extracted-paper labels from becoming "GroupGroupGroup" while
  // allowing an arbitrary rectangular selection.
  const deduplicate = populated.length > 1
    && populated.slice(1).every((cell) => cell.content.eq(populated[0]!.content));
  editor.chain()
    .focus()
    .command(({ tr }) => {
      if (!deduplicate) return true;
      if (!(tr.selection instanceof CellSelection)) return false;
      const cells: { cell: PmNode; position: number }[] = [];
      tr.selection.forEachCell((cell, position) => cells.push({ cell, position }));
      const preferred = cells.find(({ cell }) => !isEmptyCell(cell));
      for (const { position } of cells.sort((left, right) => right.position - left.position)) {
        if (position === preferred?.position) continue;
        const cell = tr.doc.nodeAt(position);
        if (!cell || isEmptyCell(cell)) continue;
        const emptyCell = cell.type.createAndFill(cell.attrs);
        if (!emptyCell) return false;
        tr.replaceWith(position + 1, position + cell.nodeSize - 1, emptyCell.content);
      }
      return true;
    })
    .mergeCells()
    .command(({ tr }) => markSelectedTableLayoutExplicit(tr))
    .run();
}

function splitSelectedTableCell(editor: Editor): void {
  const target = selectedTableCellContext(editor);
  if (!target || !splitCell(editor.state)) return;
  const rect = TableMap.get(target.table).findCell(target.cellPosition - target.tablePosition - 1);
  const crossesGfmHeaderBoundary = rect.top === 0 && rect.bottom > 1;
  editor.chain()
    .focus()
    .splitCell()
    .command(({ tr }) => {
      const table = tr.doc.nodeAt(target.tablePosition);
      if (!table) return false;
      const splitMap = TableMap.get(table);
      const positions = new Map<number, number>();
      for (let row = rect.top; row < rect.bottom; row++) {
        for (let column = rect.left; column < rect.right; column++) {
          const relative = splitMap.map[row * splitMap.width + column];
          if (relative != null) positions.set(target.tablePosition + 1 + relative, row);
        }
      }
      for (const [position, row] of [...positions].sort((left, right) => right[0] - left[0])) {
        const cell = tr.doc.nodeAt(position);
        const expectedType = crossesGfmHeaderBoundary
          ? tr.doc.type.schema.nodes[row === 0 ? "tableHeader" : "tableCell"]
          : target.cell.type;
        if (!cell || !expectedType) return false;
        if (cell.type !== expectedType) tr.setNodeMarkup(position, expectedType, cell.attrs, cell.marks);
        if (!cell.content.eq(target.cell.content)) {
          tr.replaceWith(position + 1, position + cell.nodeSize - 1, target.cell.content);
        }
      }
      return markSelectedTableLayoutExplicit(tr);
    })
    .run();
}

export function TableSpanControls({ editor }: { editor: Editor }) {
  const action = useEditorState({ editor, selector: ({ editor: current }) => tableSpanControlState(current) });
  const mergeReasonId = useId();
  if (!action) return null;
  const mergeDisabled = action === "merge-disabled";
  const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableSpanControls"
      appendTo={() => document.body}
      shouldShow={({ editor: current }) => tableSpanControlState(current) !== null}
      updateDelay={0}
      className="visual-table-span-controls"
      data-testid="table-span-controls"
    >
      {action === "split" ? (
        <Button type="button" variant="ghost" size="sm" onMouseDown={keepEditorFocus} onClick={() => splitSelectedTableCell(editor)}>
          <TableCellsSplit aria-hidden />
          Split cell
        </Button>
      ) : (
        <>
          <span className="inline-flex" title={mergeDisabled ? "Select a complete rectangular group of cells" : undefined}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mergeDisabled}
              aria-describedby={mergeDisabled ? mergeReasonId : undefined}
              onMouseDown={keepEditorFocus}
              onClick={() => mergeSelectedTableCells(editor)}
            >
              <TableCellsMerge aria-hidden />
              Merge cells
            </Button>
          </span>
          {mergeDisabled && (
            <span id={mergeReasonId} className="sr-only">
              Only a complete rectangular group of cells can be merged.
            </span>
          )}
        </>
      )}
    </BubbleMenu>
  );
}
