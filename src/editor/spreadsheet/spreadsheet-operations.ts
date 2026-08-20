import * as Y from "yjs";
import type {
  SpreadsheetBatchOperation,
  SpreadsheetBatchUpdateRequest,
  SpreadsheetCellData,
  SpreadsheetCellValue,
  SpreadsheetReadRequest,
  SpreadsheetSemanticFormat,
  SpreadsheetWorkbookData,
  SpreadsheetWorksheetData,
} from "./spreadsheet-types";
import {
  SPREADSHEET_AGENT_ORIGIN,
  SPREADSHEET_COLUMN_ID_FIELD,
  SPREADSHEET_ROW_ID_FIELD,
  reconcileSpreadsheetDoc,
  seedSpreadsheetDoc,
  spreadsheetSnapshotFromDoc,
} from "./spreadsheet-yjs";

const MAX_OPERATIONS = 100;
const MAX_CELLS_PER_BATCH = 100_000;
const MAX_READ_CELLS = 10_000;
const MAX_MATRIX_CELLS = 10_000;
const MAX_ROWS_OR_COLUMNS_PER_OPERATION = 1_000;

type ParsedRange = {
  sheetName?: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !keys.has(key));
  if (unexpected) throw new Error(`${label} contains unsupported field "${unexpected}".`);
}

function optionalSheet(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 128)) {
    throw new Error("sheet must be a non-empty string of at most 128 characters.");
  }
}

function boundedA1Range(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 32
    || !/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)?$/.test(value)) {
    throw new Error("range must be a bounded A1 cell or rectangular range.");
  }
  parseA1Range(value);
}

function boundedCount(value: unknown, label: string, maximum = MAX_ROWS_OR_COLUMNS_PER_OPERATION): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum.toLocaleString()}.`);
  }
}

function columnIndex(label: string): number {
  let result = 0;
  for (const character of label.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}

function columnLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 16_384) throw new Error("Column index is out of range.");
  let value = index + 1;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

export function a1Range(range: { startRow: number; startColumn: number; endRow: number; endColumn: number }): string {
  const start = `${columnLabel(range.startColumn)}${range.startRow + 1}`;
  const end = `${columnLabel(range.endColumn)}${range.endRow + 1}`;
  return start === end ? start : `${start}:${end}`;
}

export function parseA1Range(value: string): ParsedRange {
  const match = value.trim().match(/^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/);
  if (!match) throw new Error(`Invalid A1 range: ${value}`);
  const startColumn = columnIndex(match[3]);
  const startRow = Number(match[4]) - 1;
  const endColumn = match[5] ? columnIndex(match[5]) : startColumn;
  const endRow = match[6] ? Number(match[6]) - 1 : startRow;
  if (startColumn < 0 || endColumn < startColumn || endColumn >= 16_384
    || startRow < 0 || endRow < startRow || endRow >= 1_048_576) {
    throw new Error(`Invalid A1 range: ${value}`);
  }
  return {
    ...(match[1] || match[2] ? { sheetName: (match[1] || match[2]).replaceAll("''", "'") } : {}),
    startRow,
    startColumn,
    endRow,
    endColumn,
  };
}

function resolveSheet(workbook: SpreadsheetWorkbookData, requested?: string): SpreadsheetWorksheetData {
  const id = requested && workbook.sheets[requested]
    ? requested
    : requested
      ? workbook.sheetOrder.find((candidate) => workbook.sheets[candidate]?.name.toLocaleLowerCase() === requested.toLocaleLowerCase())
      : workbook.sheetOrder[0];
  if (!id || !workbook.sheets[id]) throw new Error(requested ? `Spreadsheet sheet not found: ${requested}` : "The spreadsheet has no sheets.");
  return workbook.sheets[id];
}

function operationRange(workbook: SpreadsheetWorkbookData, sheet: string | undefined, value: string): { sheet: SpreadsheetWorksheetData; range: ParsedRange } {
  const range = parseA1Range(value);
  if (range.sheetName && sheet && range.sheetName.toLocaleLowerCase() !== sheet.toLocaleLowerCase()) {
    throw new Error("The sheet field and A1 range refer to different sheets.");
  }
  const target = resolveSheet(workbook, range.sheetName ?? sheet);
  if (range.endRow >= target.rowCount || range.endColumn >= target.columnCount) {
    throw new Error(`Range ${value} exceeds ${target.name}'s ${target.rowCount} rows and ${target.columnCount} columns.`);
  }
  return { sheet: target, range };
}

function rangeSize(range: ParsedRange): number {
  return (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
}

function matrixShape(matrix: unknown, rows: number, columns: number, label: string): void {
  if (!Array.isArray(matrix) || matrix.length !== rows || !matrix.every((row) => Array.isArray(row) && row.length === columns)) {
    throw new Error(`${label} must be a ${rows} × ${columns} matrix matching the range.`);
  }
}

function cellAt(sheet: SpreadsheetWorksheetData, row: number, column: number, create = false): SpreadsheetCellData | undefined {
  if (!sheet.cellData[row] && create) sheet.cellData[row] = {};
  if (!sheet.cellData[row]?.[column] && create) sheet.cellData[row][column] = {};
  return sheet.cellData[row]?.[column];
}

function pruneCell(sheet: SpreadsheetWorksheetData, row: number, column: number): void {
  const cell = sheet.cellData[row]?.[column];
  if (cell && Object.keys(cell).length === 0) delete sheet.cellData[row][column];
  if (sheet.cellData[row] && Object.keys(sheet.cellData[row]).length === 0) delete sheet.cellData[row];
}

// Univer CellValueType. Keep this file off @univerjs/core so the Agent write
// path can run in tests without booting the editor.
const CELL_STRING = 1;
const CELL_NUMBER = 2;
const CELL_BOOLEAN = 3;
const CELL_FORCE_STRING = 4;
const PLAIN_NUMERIC_STRING = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function coercePlainNumericString(value: string): number | null {
  const trimmed = value.trim();
  if (!PLAIN_NUMERIC_STRING.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  // Integer IDs beyond the safe range must stay text; Number() would round them.
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function writtenCellValue(value: Exclude<SpreadsheetCellValue, null>): { v: string | number | boolean; t: number } {
  if (typeof value === "number") return { v: value, t: CELL_NUMBER };
  if (typeof value === "boolean") return { v: value, t: CELL_BOOLEAN };
  // Excel's force-string prefix. Agents use it for zip codes and other IDs that
  // look numeric. Univer still marks those cells; that is the intended warning.
  if (value.startsWith("'")) return { v: value.slice(1), t: CELL_FORCE_STRING };
  const numeric = coercePlainNumericString(value);
  if (numeric !== null) return { v: numeric, t: CELL_NUMBER };
  return { v: value, t: CELL_STRING };
}

function validColor(value: string): boolean {
  return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
}

function applySemanticFormat(
  current: SpreadsheetCellData["s"],
  format: SpreadsheetSemanticFormat,
  styles: SpreadsheetWorkbookData["styles"],
): Record<string, unknown> {
  const style = typeof current === "string" && isRecord(styles[current])
    ? clone(styles[current])
    : isRecord(current) ? clone(current) : {};
  if (format.bold !== undefined) style.bl = format.bold ? 1 : 0;
  if (format.italic !== undefined) style.it = format.italic ? 1 : 0;
  if (format.underline !== undefined) style.ul = { s: format.underline ? 1 : 0 };
  if (format.strikethrough !== undefined) style.st = { s: format.strikethrough ? 1 : 0 };
  if (format.fontFamily !== undefined) {
    if (format.fontFamily.length === 0 || format.fontFamily.length > 100) throw new Error("fontFamily must contain 1–100 characters.");
    style.ff = format.fontFamily;
  }
  if (format.fontSize !== undefined) {
    if (!Number.isFinite(format.fontSize) || format.fontSize < 1 || format.fontSize > 400) throw new Error("fontSize must be between 1 and 400.");
    style.fs = format.fontSize;
  }
  for (const [field, key] of [["textColor", "cl"], ["backgroundColor", "bg"]] as const) {
    const color = format[field];
    if (color !== undefined) {
      if (!validColor(color)) throw new Error(`${field} must be a #RRGGBB or #RRGGBBAA color.`);
      style[key] = { rgb: color };
    }
  }
  if (format.numberFormat !== undefined) {
    if (format.numberFormat.length === 0 || format.numberFormat.length > 128) throw new Error("numberFormat must contain 1–128 characters.");
    style.n = { pattern: format.numberFormat };
  }
  if (format.horizontalAlignment !== undefined) {
    style.ht = { left: 1, center: 2, right: 3 }[format.horizontalAlignment];
  }
  if (format.verticalAlignment !== undefined) {
    style.vt = { top: 1, middle: 2, bottom: 3 }[format.verticalAlignment];
  }
  if (format.wrap !== undefined) {
    style.tb = format.wrap ? 3 : 2;
  }
  return style;
}

function newStableData(field: string, prefix: string): Record<string, unknown> {
  return { custom: { [field]: `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` } };
}

function remapIndexed<T>(input: Record<number, T>, map: (index: number) => number | null): Record<number, T> {
  const output: Record<number, T> = {};
  for (const [key, value] of Object.entries(input)) {
    const next = map(Number(key));
    if (next !== null) output[next] = value;
  }
  return output;
}

function insertRows(sheet: SpreadsheetWorksheetData, before: number, count: number): void {
  if (!Number.isSafeInteger(before) || before < 1 || before > sheet.rowCount + 1) throw new Error("before must be a 1-based row at or immediately after the sheet.");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ROWS_OR_COLUMNS_PER_OPERATION || sheet.rowCount + count > 1_048_576) throw new Error("Invalid row insertion count.");
  const index = before - 1;
  sheet.rowData = remapIndexed(sheet.rowData, (row) => row >= index ? row + count : row);
  sheet.cellData = remapIndexed(sheet.cellData, (row) => row >= index ? row + count : row);
  for (let offset = 0; offset < count; offset++) sheet.rowData[index + offset] = newStableData(SPREADSHEET_ROW_ID_FIELD, "row");
  for (const merge of sheet.mergeData) {
    if (merge.startRow >= index) merge.startRow += count;
    if (merge.endRow >= index) merge.endRow += count;
  }
  sheet.rowCount += count;
}

function deleteRows(sheet: SpreadsheetWorksheetData, start: number, count: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > MAX_ROWS_OR_COLUMNS_PER_OPERATION || start - 1 + count > sheet.rowCount || sheet.rowCount - count < 1) throw new Error("Invalid row deletion range.");
  const index = start - 1;
  const end = index + count;
  sheet.rowData = remapIndexed(sheet.rowData, (row) => row < index ? row : row >= end ? row - count : null);
  sheet.cellData = remapIndexed(sheet.cellData, (row) => row < index ? row : row >= end ? row - count : null);
  sheet.mergeData = sheet.mergeData.flatMap((merge) => {
    if (merge.endRow < index) return [merge];
    if (merge.startRow >= end) return [{ ...merge, startRow: merge.startRow - count, endRow: merge.endRow - count }];
    return [];
  });
  sheet.rowCount -= count;
}

function insertColumns(sheet: SpreadsheetWorksheetData, before: number, count: number): void {
  if (!Number.isSafeInteger(before) || before < 1 || before > sheet.columnCount + 1) throw new Error("before must be a 1-based column at or immediately after the sheet.");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ROWS_OR_COLUMNS_PER_OPERATION || sheet.columnCount + count > 16_384) throw new Error("Invalid column insertion count.");
  const index = before - 1;
  sheet.columnData = remapIndexed(sheet.columnData, (column) => column >= index ? column + count : column);
  for (const row of Object.keys(sheet.cellData).map(Number)) {
    sheet.cellData[row] = remapIndexed(sheet.cellData[row], (column) => column >= index ? column + count : column);
  }
  for (let offset = 0; offset < count; offset++) sheet.columnData[index + offset] = newStableData(SPREADSHEET_COLUMN_ID_FIELD, "column");
  for (const merge of sheet.mergeData) {
    if (merge.startColumn >= index) merge.startColumn += count;
    if (merge.endColumn >= index) merge.endColumn += count;
  }
  sheet.columnCount += count;
}

function deleteColumns(sheet: SpreadsheetWorksheetData, start: number, count: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 1 || count < 1 || count > MAX_ROWS_OR_COLUMNS_PER_OPERATION || start - 1 + count > sheet.columnCount || sheet.columnCount - count < 1) throw new Error("Invalid column deletion range.");
  const index = start - 1;
  const end = index + count;
  sheet.columnData = remapIndexed(sheet.columnData, (column) => column < index ? column : column >= end ? column - count : null);
  for (const row of Object.keys(sheet.cellData).map(Number)) {
    sheet.cellData[row] = remapIndexed(sheet.cellData[row], (column) => column < index ? column : column >= end ? column - count : null);
    if (Object.keys(sheet.cellData[row]).length === 0) delete sheet.cellData[row];
  }
  sheet.mergeData = sheet.mergeData.flatMap((merge) => {
    if (merge.endColumn < index) return [merge];
    if (merge.startColumn >= end) return [{ ...merge, startColumn: merge.startColumn - count, endColumn: merge.endColumn - count }];
    return [];
  });
  sheet.columnCount -= count;
}

function validSheetName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 31
    && !name.startsWith("'") && !name.endsWith("'")
    && ![":", "\\", "/", "?", "*", "[", "]"].some((character) => name.includes(character));
}

function assertUniqueSheetName(workbook: SpreadsheetWorkbookData, name: string, exceptId?: string): void {
  if (!validSheetName(name)) throw new Error("Sheet names must contain 1–31 characters and cannot contain : \\ / ? * [ ].");
  if (workbook.sheetOrder.some((id) => id !== exceptId && workbook.sheets[id].name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error(`A sheet named ${name} already exists.`);
  }
}

function createSheet(name: string, rows: number, columns: number): SpreadsheetWorksheetData {
  const id = `sheet_${crypto.randomUUID().replaceAll("-", "")}`;
  const rowData: SpreadsheetWorksheetData["rowData"] = {};
  const columnData: SpreadsheetWorksheetData["columnData"] = {};
  for (let row = 0; row < rows; row++) rowData[row] = newStableData(SPREADSHEET_ROW_ID_FIELD, "row");
  for (let column = 0; column < columns; column++) columnData[column] = newStableData(SPREADSHEET_COLUMN_ID_FIELD, "column");
  return {
    id, name, rowCount: rows, columnCount: columns, rowData, columnData, cellData: {}, mergeData: [],
    tabColor: "", hidden: 0, freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
    zoomRatio: 1, scrollTop: 0, scrollLeft: 0, defaultColumnWidth: 88, defaultRowHeight: 24,
    rowHeader: { width: 46 }, columnHeader: { height: 24 }, showGridlines: 1, rightToLeft: 0,
  };
}

function applyOperation(workbook: SpreadsheetWorkbookData, operation: SpreadsheetBatchOperation): number {
  if (operation.type === "add_sheet") {
    assertUniqueSheetName(workbook, operation.name);
    if (workbook.sheetOrder.length >= 200) throw new Error("A spreadsheet cannot contain more than 200 sheets.");
    const sheet = createSheet(operation.name, 100, 26);
    workbook.sheets[sheet.id] = sheet;
    if (operation.after === undefined) workbook.sheetOrder.push(sheet.id);
    else {
      const after = resolveSheet(workbook, operation.after);
      workbook.sheetOrder.splice(workbook.sheetOrder.indexOf(after.id) + 1, 0, sheet.id);
    }
    return 0;
  }
  if (operation.type === "delete_sheet") {
    if (workbook.sheetOrder.length === 1) throw new Error("The last sheet cannot be deleted.");
    const sheet = resolveSheet(workbook, operation.sheet);
    workbook.sheetOrder = workbook.sheetOrder.filter((id) => id !== sheet.id);
    delete workbook.sheets[sheet.id];
    return 0;
  }
  if (operation.type === "rename_sheet") {
    const sheet = resolveSheet(workbook, operation.sheet);
    assertUniqueSheetName(workbook, operation.name, sheet.id);
    sheet.name = operation.name;
    return 0;
  }
  if (operation.type === "insert_rows" || operation.type === "delete_rows" || operation.type === "insert_columns" || operation.type === "delete_columns") {
    const sheet = resolveSheet(workbook, operation.sheet);
    if (operation.type === "insert_rows") insertRows(sheet, operation.before, operation.count);
    else if (operation.type === "delete_rows") deleteRows(sheet, operation.start, operation.count);
    else if (operation.type === "insert_columns") insertColumns(sheet, columnIndex(operation.before) + 1, operation.count);
    else deleteColumns(sheet, columnIndex(operation.start) + 1, operation.count);
    return 0;
  }
  const { sheet, range } = operationRange(workbook, operation.sheet, operation.range);
  if (rangeSize(range) > MAX_CELLS_PER_BATCH) {
    throw new Error(`A range operation cannot affect more than ${MAX_CELLS_PER_BATCH.toLocaleString()} cells.`);
  }
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  if (operation.type === "set_values") matrixShape(operation.values, rows, columns, "values");
  if (operation.type === "set_formulas") matrixShape(operation.formulas, rows, columns, "formulas");
  for (let row = range.startRow; row <= range.endRow; row++) {
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      const cell = cellAt(sheet, row, column, true)!;
      const matrixRow = row - range.startRow;
      const matrixColumn = column - range.startColumn;
      if (operation.type === "set_values") {
        const value = operation.values[matrixRow][matrixColumn];
        if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("Cell values must be strings, finite numbers, booleans, or null.");
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Cell numbers must be finite.");
        if (value === null) {
          delete cell.v;
          delete cell.t;
        } else {
          const written = writtenCellValue(value);
          cell.v = written.v;
          cell.t = written.t;
        }
        for (const key of ["f", "p", "si", "ref", "xf"]) delete cell[key];
      } else if (operation.type === "set_formulas") {
        const formula = operation.formulas[matrixRow][matrixColumn];
        if (typeof formula !== "string" || !formula.startsWith("=") || formula.length > 8_192) throw new Error("Formulas must start with = and contain at most 8,192 characters.");
        cell.f = formula;
        for (const key of ["v", "t", "p", "si", "ref", "xf"]) delete cell[key];
      } else if (operation.type === "clear") {
        const include = new Set(operation.include ?? ["values", "formulas", "formats"]);
        if (include.has("values")) for (const key of ["v", "t", "p"]) delete cell[key];
        if (include.has("formulas")) for (const key of ["f", "si", "ref", "xf"]) delete cell[key];
        if (include.has("formats")) delete cell.s;
      } else {
        cell.s = applySemanticFormat(cell.s, operation.format, workbook.styles);
      }
      pruneCell(sheet, row, column);
    }
  }
  return rangeSize(range);
}

export function applySpreadsheetBatch(
  doc: Y.Doc,
  request: SpreadsheetBatchUpdateRequest,
): { appliedOperations: number; affectedCells: number; workbookRevision: number } {
  if (!Array.isArray(request.operations) || request.operations.length === 0 || request.operations.length > MAX_OPERATIONS) {
    throw new Error(`operations must contain between 1 and ${MAX_OPERATIONS} items.`);
  }
  if (JSON.stringify(request).length > 512 * 1024) throw new Error("Spreadsheet update arguments are too large.");
  seedSpreadsheetDoc(doc);
  const workbook = clone(spreadsheetSnapshotFromDoc(doc));
  let affectedCells = 0;
  for (const operation of request.operations) {
    affectedCells += applyOperation(workbook, operation);
    if (affectedCells > MAX_CELLS_PER_BATCH) throw new Error(`A batch cannot affect more than ${MAX_CELLS_PER_BATCH.toLocaleString()} cells.`);
  }
  const meta = doc.getMap<unknown>("spreadsheetMeta");
  const currentRevision = Number(meta.get("agentRevision") ?? 0);
  doc.transact(() => {
    reconcileSpreadsheetDoc(doc, workbook, SPREADSHEET_AGENT_ORIGIN);
    meta.set("agentRevision", currentRevision + 1);
  }, SPREADSHEET_AGENT_ORIGIN);
  return { appliedOperations: request.operations.length, affectedCells, workbookRevision: currentRevision + 1 };
}

export function readSpreadsheet(
  doc: Y.Doc,
  request: SpreadsheetReadRequest,
): Record<string, unknown> {
  const workbook = spreadsheetSnapshotFromDoc(doc);
  const requestedRange = request.range ? parseA1Range(request.range) : null;
  if (requestedRange?.sheetName && request.sheet && requestedRange.sheetName.toLocaleLowerCase() !== request.sheet.toLocaleLowerCase()) {
    throw new Error("The sheet field and A1 range refer to different sheets.");
  }
  const sheet = resolveSheet(workbook, requestedRange?.sheetName ?? request.sheet);
  let range = requestedRange;
  if (!range) {
    let endRow = 0;
    let endColumn = 0;
    for (const [rowKey, row] of Object.entries(sheet.cellData)) {
      endRow = Math.max(endRow, Number(rowKey));
      for (const columnKey of Object.keys(row)) endColumn = Math.max(endColumn, Number(columnKey));
    }
    range = { startRow: 0, startColumn: 0, endRow, endColumn };
  }
  if (range.endRow >= sheet.rowCount || range.endColumn >= sheet.columnCount) throw new Error("The requested range exceeds the sheet dimensions.");
  if (rangeSize(range) > MAX_READ_CELLS) throw new Error(`Read ranges cannot exceed ${MAX_READ_CELLS.toLocaleString()} cells.`);
  const include = new Set(request.include ?? ["values", "formulas"]);
  if ([...include].some((item) => item !== "values" && item !== "formulas" && item !== "formats")) throw new Error("Unsupported spreadsheet read field.");
  const values: Array<Array<SpreadsheetCellValue | null>> = [];
  const formulas: Array<Array<string | null>> = [];
  const formats: Array<Array<SpreadsheetCellData["s"] | null>> = [];
  for (let row = range.startRow; row <= range.endRow; row++) {
    const valueRow: Array<SpreadsheetCellValue | null> = [];
    const formulaRow: Array<string | null> = [];
    const formatRow: Array<SpreadsheetCellData["s"] | null> = [];
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      const cell = cellAt(sheet, row, column);
      valueRow.push(typeof cell?.v === "string" || typeof cell?.v === "number" || typeof cell?.v === "boolean" ? cell.v : null);
      formulaRow.push(typeof cell?.f === "string" ? cell.f : null);
      formatRow.push(cell?.s === undefined ? null : clone(cell.s));
    }
    values.push(valueRow);
    formulas.push(formulaRow);
    formats.push(formatRow);
  }
  return {
    workbook: { id: workbook.id, name: workbook.name },
    sheets: workbook.sheetOrder.map((id) => ({ id, name: workbook.sheets[id].name, rows: workbook.sheets[id].rowCount, columns: workbook.sheets[id].columnCount })),
    sheet: { id: sheet.id, name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount },
    range: a1Range(range),
    ...(include.has("values") ? { values } : {}),
    ...(include.has("formulas") ? { formulas } : {}),
    ...(include.has("formats") ? { formats } : {}),
  };
}

export function parseSpreadsheetReadArgs(value: unknown): SpreadsheetReadRequest {
  if (!isRecord(value)) throw new Error("Spreadsheet read arguments must be an object.");
  assertOnlyKeys(value, ["sheet", "range", "include"], "Spreadsheet read arguments");
  optionalSheet(value.sheet);
  if (value.range !== undefined) boundedA1Range(value.range);
  if (value.include !== undefined && (!Array.isArray(value.include) || value.include.length < 1 || value.include.length > 3
    || new Set(value.include).size !== value.include.length
    || !value.include.every((item) => item === "values" || item === "formulas" || item === "formats"))) {
    throw new Error("include contains unsupported or duplicate fields.");
  }
  return value as SpreadsheetReadRequest;
}

export function parseSpreadsheetBatchUpdateArgs(value: unknown): SpreadsheetBatchUpdateRequest {
  if (!isRecord(value) || !Array.isArray(value.operations)) throw new Error("Spreadsheet batch arguments require an operations array.");
  assertOnlyKeys(value, ["operations"], "Spreadsheet batch arguments");
  if (value.operations.length < 1 || value.operations.length > MAX_OPERATIONS) {
    throw new Error(`operations must contain between 1 and ${MAX_OPERATIONS} items.`);
  }
  for (const [index, rawOperation] of value.operations.entries()) {
    if (!isRecord(rawOperation) || typeof rawOperation.type !== "string") throw new Error(`operations[${index}] must be an object with a type.`);
    const operation = rawOperation as Record<string, unknown>;
    const label = `operations[${index}]`;
    const type = operation.type;
    if (type === "set_values" || type === "set_formulas") {
      const matrixKey = type === "set_values" ? "values" : "formulas";
      assertOnlyKeys(operation, ["type", "sheet", "range", matrixKey], label);
      optionalSheet(operation.sheet);
      boundedA1Range(operation.range);
      const range = parseA1Range(operation.range);
      const matrix = operation[matrixKey];
      const rows = range.endRow - range.startRow + 1;
      const columns = range.endColumn - range.startColumn + 1;
      if (rows * columns > MAX_MATRIX_CELLS) throw new Error(`${label} cannot write more than ${MAX_MATRIX_CELLS.toLocaleString()} cells.`);
      matrixShape(matrix, rows, columns, matrixKey);
      for (const item of (matrix as unknown[][]).flat()) {
        if (type === "set_values") {
          if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error(`${label} contains an invalid cell value.`);
          if (typeof item === "string" && item.length > 32_768) throw new Error(`${label} contains a cell string longer than 32,768 characters.`);
          if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label} contains a non-finite number.`);
        } else if (typeof item !== "string" || !item.startsWith("=") || item.length > 8_192) {
          throw new Error(`${label} contains an invalid formula.`);
        }
      }
      continue;
    }
    if (type === "clear") {
      assertOnlyKeys(operation, ["type", "sheet", "range", "include"], label);
      optionalSheet(operation.sheet);
      boundedA1Range(operation.range);
      const include = operation.include;
      if (include !== undefined && (!Array.isArray(include) || include.length < 1 || include.length > 3
        || new Set(include).size !== include.length
        || !include.every((item) => item === "values" || item === "formulas" || item === "formats"))) {
        throw new Error(`${label}.include contains unsupported or duplicate fields.`);
      }
      continue;
    }
    if (type === "format_range") {
      assertOnlyKeys(operation, ["type", "sheet", "range", "format"], label);
      optionalSheet(operation.sheet);
      boundedA1Range(operation.range);
      if (!isRecord(operation.format) || Object.keys(operation.format).length === 0) throw new Error(`${label}.format must be a non-empty object.`);
      assertOnlyKeys(operation.format, ["bold", "italic", "underline", "strikethrough", "fontFamily", "fontSize", "textColor", "backgroundColor", "numberFormat", "horizontalAlignment", "verticalAlignment", "wrap"], `${label}.format`);
      for (const field of ["bold", "italic", "underline", "strikethrough", "wrap"] as const) {
        if (operation.format[field] !== undefined && typeof operation.format[field] !== "boolean") throw new Error(`${label}.format.${field} must be a boolean.`);
      }
      if (operation.format.fontFamily !== undefined && (typeof operation.format.fontFamily !== "string" || operation.format.fontFamily.length < 1 || operation.format.fontFamily.length > 100)) throw new Error(`${label}.format.fontFamily must contain 1–100 characters.`);
      if (operation.format.fontSize !== undefined && (typeof operation.format.fontSize !== "number" || !Number.isFinite(operation.format.fontSize) || operation.format.fontSize < 1 || operation.format.fontSize > 200)) throw new Error(`${label}.format.fontSize must be between 1 and 200.`);
      for (const field of ["textColor", "backgroundColor"] as const) {
        if (operation.format[field] !== undefined && (typeof operation.format[field] !== "string" || !validColor(operation.format[field]))) throw new Error(`${label}.format.${field} must be a hex color.`);
      }
      if (operation.format.numberFormat !== undefined && (typeof operation.format.numberFormat !== "string" || operation.format.numberFormat.length < 1 || operation.format.numberFormat.length > 128)) throw new Error(`${label}.format.numberFormat must contain 1–128 characters.`);
      if (operation.format.horizontalAlignment !== undefined && !["left", "center", "right"].includes(String(operation.format.horizontalAlignment))) throw new Error(`${label}.format.horizontalAlignment is invalid.`);
      if (operation.format.verticalAlignment !== undefined && !["top", "middle", "bottom"].includes(String(operation.format.verticalAlignment))) throw new Error(`${label}.format.verticalAlignment is invalid.`);
      continue;
    }
    if (type === "insert_rows" || type === "delete_rows") {
      const position = type === "insert_rows" ? "before" : "start";
      assertOnlyKeys(operation, ["type", "sheet", position, "count"], label);
      optionalSheet(operation.sheet);
      boundedCount(operation[position], `${label}.${position}`, 1_048_576);
      boundedCount(operation.count, `${label}.count`);
      continue;
    }
    if (type === "insert_columns" || type === "delete_columns") {
      const position = type === "insert_columns" ? "before" : "start";
      assertOnlyKeys(operation, ["type", "sheet", position, "count"], label);
      optionalSheet(operation.sheet);
      if (typeof operation[position] !== "string" || !/^[A-Za-z]{1,3}$/.test(operation[position])) throw new Error(`${label}.${position} must be an A1 column label.`);
      boundedCount(operation.count, `${label}.count`);
      continue;
    }
    if (type === "add_sheet") {
      assertOnlyKeys(operation, ["type", "name", "after"], label);
      if (!validSheetName(operation.name)) throw new Error(`${label}.name is not a valid sheet name.`);
      optionalSheet(operation.after);
      continue;
    }
    if (type === "delete_sheet" || type === "rename_sheet") {
      assertOnlyKeys(operation, type === "rename_sheet" ? ["type", "sheet", "name"] : ["type", "sheet"], label);
      optionalSheet(operation.sheet);
      if (operation.sheet === undefined) throw new Error(`${label}.sheet is required.`);
      if (type === "rename_sheet" && !validSheetName(operation.name)) throw new Error(`${label}.name is not a valid sheet name.`);
      continue;
    }
    throw new Error(`Unsupported spreadsheet operation: ${type}`);
  }
  return value as SpreadsheetBatchUpdateRequest;
}
