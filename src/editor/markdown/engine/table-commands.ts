/**
 * Table editing commands for the visual engine (spec R-BLK-11, R-FMT-10,
 * R-FMT-22): Enter moves down a column, rows and columns are inserted without
 * disturbing the GFM header row or the column alignments, and merging or
 * splitting cells keeps every value the cells held.
 *
 * Built on prosemirror-tables' TableMap (MIT).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Fragment, type Node as PmNode, type ResolvedPos } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap, addRow, cellAround } from "@tiptap/pm/tables";
import { semanticKey } from "./semantic-key";

type Dispatch = ((transaction: Transaction) => void) | undefined;

/** The table around the selection: node, start, map, and the current cell's grid rectangle. */
export type TableContext = {
  table: PmNode;
  tablePos: number;
  tableStart: number;
  map: TableMap;
  cellPos: number;
  cell: PmNode;
  rect: { left: number; top: number; right: number; bottom: number };
};

export function tableContext(state: EditorState, from: ResolvedPos = state.selection.$head): TableContext | null {
  const $cell = state.selection instanceof CellSelection ? state.selection.$headCell : cellAround(from);
  if (!$cell) return null;
  const table = $cell.node(-1);
  if (table.type.name !== "table") return null;
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const cellPos = $cell.pos;
  const cell = state.doc.nodeAt(cellPos);
  if (!cell) return null;
  return { table, tablePos: tableStart - 1, tableStart, map, cellPos, cell, rect: map.findCell(cellPos - tableStart) };
}

const hasSpans = (table: PmNode) => {
  let spans = false;
  table.forEach((row) => row.forEach((cell) => {
    if (cell.attrs.colspan > 1 || cell.attrs.rowspan > 1) spans = true;
  }));
  return spans;
};

/** Whether the table has merged cells (they rule out rectangular drag reorder). */
export const tableHasSpans = hasSpans;

/** Put the caret at the end of the cell at `cellPos` (relative to the table). */
function selectCell(transaction: Transaction, tableStart: number, cellPos: number): Transaction {
  const cell = transaction.doc.nodeAt(tableStart + cellPos);
  if (!cell) return transaction;
  const end = tableStart + cellPos + cell.nodeSize - 2;
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve(end), -1));
}

/**
 * Enter in a table: move to the cell below in the same column, appending a
 * row from the last one. A text selection inside the cell is kept, not
 * replaced by a cell split (R-BLK-11, R-FMT-22).
 */
export function moveDownOrAppendRow(state: EditorState, dispatch: Dispatch): boolean {
  if (state.selection instanceof CellSelection) return false;
  const context = tableContext(state);
  if (!context) return false;
  const { map, rect, tableStart } = context;
  if (!dispatch) return true;
  if (rect.bottom < map.height) {
    dispatch(selectCell(state.tr, tableStart, map.map[rect.bottom * map.width + rect.left]!).scrollIntoView());
    return true;
  }
  const transaction = addRow(state.tr, { map, tableStart, table: context.table, ...rect }, map.height);
  const table = transaction.doc.nodeAt(context.tablePos)!;
  const next = TableMap.get(table);
  dispatch(selectCell(transaction, tableStart, next.map[(next.height - 1) * next.width + rect.left]!).scrollIntoView());
  return true;
}

/** Insert a row above or below the current one; nothing goes above the header row. */
export function insertRow(state: EditorState, dispatch: Dispatch, side: "above" | "below"): boolean {
  const context = tableContext(state);
  if (!context) return false;
  const row = side === "above" ? context.rect.top : context.rect.bottom;
  if (row === 0) return false;
  if (dispatch) dispatch(addRow(state.tr, { map: context.map, tableStart: context.tableStart, table: context.table, ...context.rect }, row));
  return true;
}

/** Delete the current row; the header row stays, since GFM needs one. */
export function deleteRow(state: EditorState, dispatch: Dispatch): boolean {
  const context = tableContext(state);
  if (!context || context.rect.top === 0 || hasSpans(context.table)) return false;
  if (!dispatch) return true;
  let start = context.tableStart;
  for (let index = 0; index < context.rect.top; index += 1) start += context.table.child(index).nodeSize;
  dispatch(state.tr.delete(start, start + context.table.child(context.rect.top).nodeSize));
  return true;
}

/** Rebuild the table's rows with `transform(cells, rowIndex)`, keeping the alignment row in step. */
function rebuildColumns(
  state: EditorState,
  context: TableContext,
  transform: (cells: PmNode[], row: number) => PmNode[],
  align: (align: (string | null)[]) => (string | null)[],
): Transaction {
  const rows: PmNode[] = [];
  context.table.forEach((row, _offset, index) => {
    const cells: PmNode[] = [];
    row.forEach((cell) => cells.push(cell));
    rows.push(row.copy(Fragment.fromArray(transform(cells, index))));
  });
  const width = context.map.width;
  const current = (context.table.attrs.align as (string | null)[] | null) ?? Array.from({ length: width }, () => null);
  const table = context.table.type.create({ ...context.table.attrs, align: align([...current]) }, rows, context.table.marks);
  return state.tr.replaceWith(context.tablePos, context.tablePos + context.table.nodeSize, table);
}

/** Insert an empty column left or right of the current one (tables without merged cells). */
export function insertColumn(state: EditorState, dispatch: Dispatch, side: "left" | "right"): boolean {
  const context = tableContext(state);
  if (!context || hasSpans(context.table)) return false;
  if (!dispatch) return true;
  const index = side === "left" ? context.rect.left : context.rect.right;
  const transaction = rebuildColumns(state, context, (cells, row) => {
    const type = row === 0 ? state.schema.nodes.tableHeader! : state.schema.nodes.tableCell!;
    const next = [...cells];
    next.splice(index, 0, type.createAndFill()!);
    return next;
  }, (align) => {
    align.splice(index, 0, null);
    return align;
  });
  dispatch(selectCell(transaction, context.tableStart, TableMap.get(transaction.doc.nodeAt(context.tablePos)!).map[context.rect.top * (context.map.width + 1) + index]!));
  return true;
}

/** Delete the current column (tables without merged cells); the last column deletes the table. */
export function deleteColumn(state: EditorState, dispatch: Dispatch): boolean {
  const context = tableContext(state);
  if (!context || hasSpans(context.table)) return false;
  if (!dispatch) return true;
  if (context.map.width === 1) {
    dispatch(state.tr.delete(context.tablePos, context.tablePos + context.table.nodeSize));
    return true;
  }
  const index = context.rect.left;
  dispatch(rebuildColumns(state, context, (cells) => cells.filter((_cell, position) => position !== index), (align) => {
    align.splice(index, 1);
    return align;
  }));
  return true;
}

/** Delete the table around the selection. */
export function deleteTable(state: EditorState, dispatch: Dispatch): boolean {
  const context = tableContext(state);
  if (!context) return false;
  if (dispatch) dispatch(state.tr.delete(context.tablePos, context.tablePos + context.table.nodeSize));
  return true;
}

/** Whether the selected cells form a rectangle that merging would not cut. */
export function canMergeCells(state: EditorState): boolean {
  const selection = state.selection;
  if (!(selection instanceof CellSelection) || selection.$anchorCell.pos === selection.$headCell.pos) return false;
  const context = tableContext(state);
  if (!context) return false;
  const { map, tableStart } = context;
  const rect = map.rectBetween(selection.$anchorCell.pos - tableStart, selection.$headCell.pos - tableStart);
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let col = rect.left; col < rect.right; col += 1) {
      const cell = map.findCell(map.map[row * map.width + col]!);
      if (cell.left < rect.left || cell.right > rect.right || cell.top < rect.top || cell.bottom > rect.bottom) return false;
    }
  }
  return true;
}

/**
 * Merge the selected cells into their top-left cell. Equal values show once;
 * distinct values are all kept, in reading order, separated by spaces
 * (R-BLK-11). The table's layout becomes explicit, so the merge is written.
 */
export function mergeSelectedCells(state: EditorState, dispatch: Dispatch): boolean {
  if (!canMergeCells(state)) return false;
  if (!dispatch) return true;
  const selection = state.selection as CellSelection;
  const context = tableContext(state)!;
  const { map, tableStart } = context;
  const rect = map.rectBetween(selection.$anchorCell.pos - tableStart, selection.$headCell.pos - tableStart);
  const seen = new Set<number>();
  const keys = new Set<string>();
  const parts: Fragment[] = [];
  const doomed: number[] = [];
  let origin = -1;
  for (let row = rect.top; row < rect.bottom; row += 1) {
    for (let col = rect.left; col < rect.right; col += 1) {
      const position = map.map[row * map.width + col]!;
      if (seen.has(position)) continue;
      seen.add(position);
      if (origin < 0) origin = position;
      else doomed.push(position);
      const paragraph = context.table.nodeAt(position)!.firstChild;
      if (!paragraph?.childCount) continue;
      const key = semanticKey([paragraph]);
      if (keys.has(key)) continue;
      keys.add(key);
      parts.push(paragraph.content);
    }
  }
  let content = Fragment.empty;
  parts.forEach((part, index) => {
    content = content.append(index ? Fragment.from(state.schema.text(" ")).append(part) : part);
  });
  const transaction = state.tr;
  for (const position of doomed.sort((left, right) => right - left)) {
    const cell = context.table.nodeAt(position)!;
    transaction.delete(tableStart + position, tableStart + position + cell.nodeSize);
  }
  const originCell = context.table.nodeAt(origin)!;
  const merged = originCell.type.create(
    { ...originCell.attrs, colspan: rect.right - rect.left, rowspan: rect.bottom - rect.top, colwidth: null },
    state.schema.nodes.paragraph!.create(null, content),
  );
  transaction.replaceWith(tableStart + origin, tableStart + origin + originCell.nodeSize, merged);
  transaction.setNodeMarkup(context.tablePos, undefined, { ...context.table.attrs, layout: "explicit" });
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(tableStart + origin + 2)));
  dispatch(transaction);
  return true;
}

/** Whether the caret's cell is merged. */
export function canSplitCell(state: EditorState): boolean {
  const context = tableContext(state);
  return Boolean(context && (context.cell.attrs.colspan > 1 || context.cell.attrs.rowspan > 1));
}

/**
 * Split the merged cell back into one cell per grid slot, each repeating the
 * merged value as the Markdown source does. The layout stays explicit when
 * merges remain, or when `keepEmptyLayout` (paper reading mode, where an empty
 * layout keeps inference from merging the cells again, R-FMT-10).
 */
export function splitCurrentCell(state: EditorState, dispatch: Dispatch, keepEmptyLayout: boolean): boolean {
  if (!canSplitCell(state)) return false;
  if (!dispatch) return true;
  const context = tableContext(state)!;
  const { map, rect, tableStart, cell } = context;
  const transaction = state.tr;
  const single = { ...cell.attrs, colspan: 1, rowspan: 1, colwidth: null };
  const copy = (type = cell.type) => type.create(single, cell.content);
  // Fill the slots row by row from the bottom, so earlier positions stay valid.
  for (let row = rect.bottom - 1; row >= rect.top; row -= 1) {
    const cells: PmNode[] = [];
    for (let col = rect.left; col < rect.right; col += 1) {
      if (row === rect.top && col === rect.left) continue;
      cells.push(copy(row === 0 ? state.schema.nodes.tableHeader! : state.schema.nodes.tableCell!));
    }
    if (!cells.length) continue;
    const insertAt = row === rect.top
      ? context.cellPos + cell.nodeSize
      : tableStart + map.positionAt(row, rect.left, context.table);
    transaction.insert(transaction.mapping.slice(0).map(insertAt), cells);
  }
  transaction.setNodeMarkup(transaction.mapping.map(context.cellPos), undefined, single);
  const table = transaction.doc.nodeAt(context.tablePos)!;
  const layout = hasSpans(table) || keepEmptyLayout ? "explicit" : null;
  transaction.setNodeMarkup(context.tablePos, undefined, { ...table.attrs, layout });
  dispatch(transaction);
  return true;
}
