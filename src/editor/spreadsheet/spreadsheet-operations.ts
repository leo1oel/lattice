/* eslint-disable lingui/no-unlocalized-strings -- Agent spreadsheet tool protocol: every message here is a tool error the Agent reads, never interface copy */
import type * as Y from "yjs";
import { HORIZONTAL_ALIGNMENTS, SPREADSHEET_AXES, SPREADSHEET_READ_FIELDS, VERTICAL_ALIGNMENTS, clone, isRecord, isSpreadsheetCellValue, newId } from "./spreadsheet-types";
import type {
  SpreadsheetAxis,
  SpreadsheetBatchOperation,
  SpreadsheetBatchUpdateRequest,
  SpreadsheetCellData,
  SpreadsheetCellValue,
  SpreadsheetRangeData,
  SpreadsheetReadRequest,
  SpreadsheetSemanticFormat,
  SpreadsheetWorkbookData,
  SpreadsheetWorksheetData,
} from "./spreadsheet-types";
import {
  SPREADSHEET_AGENT_ORIGIN,
  SPREADSHEET_META_KEY,
  createWorksheet,
  newAxisData,
  reconcileSpreadsheetDoc,
  seedSpreadsheetDoc,
  spreadsheetSnapshotFromDoc,
} from "./spreadsheet-yjs";

const MAX_OPERATIONS = 100;
const MAX_CELLS_PER_BATCH = 100_000;
const MAX_READ_CELLS = 10_000;
const MAX_MATRIX_CELLS = 10_000;
const MAX_LINES_PER_OPERATION = 1_000;
// Univer CellValueType. Keep this file off @univerjs/core so the Agent write
// path can run in tests without booting the editor.
const CELL_TYPE = { string: 1, number: 2, boolean: 3, forceString: 4 } as const;
const PLAIN_NUMERIC_STRING = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type ParsedRange = SpreadsheetRangeData & { sheetName?: string };
type Operation<T extends SpreadsheetBatchOperation["type"] = SpreadsheetBatchOperation["type"]> = Extract<SpreadsheetBatchOperation, { type: T }>;
type RangeOperation = Extract<SpreadsheetBatchOperation, { range: string }>;
type StructureOperation = Exclude<SpreadsheetBatchOperation, RangeOperation>;

// ── A1 notation ──────────────────────────────────────────────────────────────

function columnIndex(label: string): number {
  let result = 0;
  for (const character of label.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}

/** Zero-based column index to its A1 letters; negative indexes clamp to A. */
export function columnLabel(index: number): string {
  let output = "";
  for (let value = Math.max(0, index) + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    output = String.fromCharCode(65 + ((value - 1) % 26)) + output;
  }
  return output;
}

export function a1Range(range: SpreadsheetRangeData): string {
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
  if (startColumn < 0 || endColumn < startColumn || endColumn >= SPREADSHEET_AXES.column.max
    || startRow < 0 || endRow < startRow || endRow >= SPREADSHEET_AXES.row.max) {
    throw new Error(`Invalid A1 range: ${value}`);
  }
  const sheetName = match[1] || match[2];
  return { ...(sheetName ? { sheetName: sheetName.replaceAll("''", "'") } : {}), startRow, startColumn, endRow, endColumn };
}

function rangeShape(range: SpreadsheetRangeData): { rows: number; columns: number; size: number } {
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  return { rows, columns, size: rows * columns };
}

// ── Workbook edits ───────────────────────────────────────────────────────────

function resolveSheet(workbook: SpreadsheetWorkbookData, requested?: string): SpreadsheetWorksheetData {
  const id = !requested
    ? workbook.sheetOrder[0]
    : workbook.sheets[requested]
      ? requested
      : workbook.sheetOrder.find((candidate) => workbook.sheets[candidate]?.name.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (!id || !workbook.sheets[id]) throw new Error(requested ? `Spreadsheet sheet not found: ${requested}` : "The spreadsheet has no sheets.");
  return workbook.sheets[id];
}

function rangeSheet(workbook: SpreadsheetWorkbookData, requested: string | undefined, range: ParsedRange | null): SpreadsheetWorksheetData {
  if (range?.sheetName && requested && range.sheetName.toLocaleLowerCase() !== requested.toLocaleLowerCase()) {
    throw new Error("The sheet field and A1 range refer to different sheets.");
  }
  return resolveSheet(workbook, range?.sheetName ?? requested);
}

function matrixShape(matrix: unknown, rows: number, columns: number, label: string): void {
  if (!Array.isArray(matrix) || matrix.length !== rows || !matrix.every((row) => Array.isArray(row) && row.length === columns)) {
    throw new Error(`${label} must be a ${rows} × ${columns} matrix matching the range.`);
  }
}

function coercePlainNumericString(value: string): number | null {
  const trimmed = value.trim();
  if (!PLAIN_NUMERIC_STRING.test(trimmed)) return null;
  const parsed = Number(trimmed);
  // Integer IDs beyond the safe range must stay text; Number() would round them.
  return Number.isFinite(parsed) && (!Number.isInteger(parsed) || Number.isSafeInteger(parsed)) ? parsed : null;
}

function writtenCellValue(value: Exclude<SpreadsheetCellValue, null>): { v: string | number | boolean; t: number } {
  if (typeof value === "number") return { v: value, t: CELL_TYPE.number };
  if (typeof value === "boolean") return { v: value, t: CELL_TYPE.boolean };
  // Excel's force-string prefix. Agents use it for zip codes and other IDs that
  // look numeric. Univer still marks those cells; that is the intended warning.
  if (value.startsWith("'")) return { v: value.slice(1), t: CELL_TYPE.forceString };
  const numeric = coercePlainNumericString(value);
  return numeric === null ? { v: value, t: CELL_TYPE.string } : { v: numeric, t: CELL_TYPE.number };
}

const mapDefined = <T>(value: T | undefined, to: (value: T) => unknown) => value === undefined ? undefined : to(value);

/** Semantic Agent formats to Univer style fields, merged over the cell's current (possibly shared) style. */
function applySemanticFormat(current: SpreadsheetCellData["s"], format: SpreadsheetSemanticFormat, styles: SpreadsheetWorkbookData["styles"]) {
  const base = typeof current === "string" && isRecord(styles[current]) ? styles[current] : isRecord(current) ? current : {};
  const changes = {
    bl: mapDefined(format.bold, (on) => on ? 1 : 0),
    it: mapDefined(format.italic, (on) => on ? 1 : 0),
    ul: mapDefined(format.underline, (on) => ({ s: on ? 1 : 0 })),
    st: mapDefined(format.strikethrough, (on) => ({ s: on ? 1 : 0 })),
    ff: format.fontFamily,
    fs: format.fontSize,
    cl: mapDefined(format.textColor, (rgb) => ({ rgb })),
    bg: mapDefined(format.backgroundColor, (rgb) => ({ rgb })),
    n: mapDefined(format.numberFormat, (pattern) => ({ pattern })),
    ht: mapDefined(format.horizontalAlignment, (alignment) => HORIZONTAL_ALIGNMENTS.indexOf(alignment) + 1),
    vt: mapDefined(format.verticalAlignment, (alignment) => VERTICAL_ALIGNMENTS.indexOf(alignment) + 1),
    tb: mapDefined(format.wrap, (wrap) => wrap ? 3 : 2),
  };
  return { ...clone(base), ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
}

function remapIndexed<T>(input: Record<number, T>, map: (index: number) => number | null): Record<number, T> {
  const output: Record<number, T> = {};
  for (const [key, value] of Object.entries(input)) {
    const next = map(Number(key));
    if (next !== null) output[next] = value;
  }
  return output;
}

/** Move rows or columns (and the cells and merges on them) through `map`; null drops the line. */
function remapLines(sheet: SpreadsheetWorksheetData, axis: SpreadsheetAxis, map: (index: number) => number | null): void {
  const { data } = SPREADSHEET_AXES[axis];
  sheet[data] = remapIndexed(sheet[data], map);
  if (axis === "row") {
    sheet.cellData = remapIndexed(sheet.cellData, map);
    return;
  }
  for (const row of Object.keys(sheet.cellData).map(Number)) {
    sheet.cellData[row] = remapIndexed(sheet.cellData[row], map);
    if (Object.keys(sheet.cellData[row]).length === 0) delete sheet.cellData[row];
  }
}

function insertLines(sheet: SpreadsheetWorksheetData, axis: SpreadsheetAxis, before: number, count: number): void {
  const { count: countKey, data, start, end, max } = SPREADSHEET_AXES[axis];
  if (!Number.isSafeInteger(before) || before < 1 || before > sheet[countKey] + 1) throw new Error(`before must be a 1-based ${axis} at or immediately after the sheet.`);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LINES_PER_OPERATION || sheet[countKey] + count > max) throw new Error(`Invalid ${axis} insertion count.`);
  const index = before - 1;
  remapLines(sheet, axis, (line) => line >= index ? line + count : line);
  for (let offset = 0; offset < count; offset++) sheet[data][index + offset] = newAxisData(axis);
  for (const merge of sheet.mergeData) {
    if (merge[start] >= index) merge[start] += count;
    if (merge[end] >= index) merge[end] += count;
  }
  sheet[countKey] += count;
}

function deleteLines(sheet: SpreadsheetWorksheetData, axis: SpreadsheetAxis, first: number, count: number): void {
  const { count: countKey, start, end } = SPREADSHEET_AXES[axis];
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 1 || count < 1 || count > MAX_LINES_PER_OPERATION
    || first - 1 + count > sheet[countKey] || sheet[countKey] - count < 1) throw new Error(`Invalid ${axis} deletion range.`);
  const index = first - 1;
  const stop = index + count;
  remapLines(sheet, axis, (line) => line < index ? line : line >= stop ? line - count : null);
  sheet.mergeData = sheet.mergeData.flatMap((merge) => {
    if (merge[end] < index) return [merge];
    if (merge[start] >= stop) return [{ ...merge, [start]: merge[start] - count, [end]: merge[end] - count }];
    return [];
  });
  sheet[countKey] -= count;
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

const STRUCTURE_OPERATIONS: { [T in StructureOperation["type"]]: (workbook: SpreadsheetWorkbookData, operation: Operation<T>) => void } = {
  add_sheet(workbook, { name, after }) {
    assertUniqueSheetName(workbook, name);
    if (workbook.sheetOrder.length >= 200) throw new Error("A spreadsheet cannot contain more than 200 sheets.");
    const sheet = createWorksheet(newId("sheet"), name);
    workbook.sheets[sheet.id] = sheet;
    const position = after === undefined ? workbook.sheetOrder.length : workbook.sheetOrder.indexOf(resolveSheet(workbook, after).id) + 1;
    workbook.sheetOrder.splice(position, 0, sheet.id);
  },
  delete_sheet(workbook, { sheet }) {
    if (workbook.sheetOrder.length === 1) throw new Error("The last sheet cannot be deleted.");
    const { id } = resolveSheet(workbook, sheet);
    workbook.sheetOrder = workbook.sheetOrder.filter((candidate) => candidate !== id);
    delete workbook.sheets[id];
  },
  rename_sheet(workbook, { sheet, name }) {
    const target = resolveSheet(workbook, sheet);
    assertUniqueSheetName(workbook, name, target.id);
    target.name = name;
  },
  insert_rows: (workbook, { sheet, before, count }) => insertLines(resolveSheet(workbook, sheet), "row", before, count),
  delete_rows: (workbook, { sheet, start, count }) => deleteLines(resolveSheet(workbook, sheet), "row", start, count),
  insert_columns: (workbook, { sheet, before, count }) => insertLines(resolveSheet(workbook, sheet), "column", columnIndex(before) + 1, count),
  delete_columns: (workbook, { sheet, start, count }) => deleteLines(resolveSheet(workbook, sheet), "column", columnIndex(start) + 1, count),
};

const deleteFields = (cell: SpreadsheetCellData, fields: readonly string[]) => fields.forEach((field) => delete cell[field]);

type CellWriter<T extends RangeOperation["type"]> =
  (cell: SpreadsheetCellData, operation: Operation<T>, offset: { row: number; column: number }, styles: SpreadsheetWorkbookData["styles"]) => void;

const CELL_WRITERS: { [T in RangeOperation["type"]]: CellWriter<T> } = {
  set_values(cell, { values }, { row, column }) {
    const value = values[row][column];
    if (value === null) deleteFields(cell, ["v", "t"]);
    else Object.assign(cell, writtenCellValue(value));
    deleteFields(cell, ["f", "p", "si", "ref", "xf"]);
  },
  set_formulas(cell, { formulas }, { row, column }) {
    cell.f = formulas[row][column];
    deleteFields(cell, ["v", "t", "p", "si", "ref", "xf"]);
  },
  clear(cell, { include = SPREADSHEET_READ_FIELDS }) {
    if (include.includes("values")) deleteFields(cell, ["v", "t", "p"]);
    if (include.includes("formulas")) deleteFields(cell, ["f", "si", "ref", "xf"]);
    if (include.includes("formats")) delete cell.s;
  },
  format_range(cell, { format }, _offset, styles) {
    cell.s = applySemanticFormat(cell.s, format, styles);
  },
};

/** Returns the number of cells the operation touched (structural edits count as zero). */
function applyOperation(workbook: SpreadsheetWorkbookData, operation: SpreadsheetBatchOperation): number {
  if (!("range" in operation)) {
    (STRUCTURE_OPERATIONS[operation.type] as (workbook: SpreadsheetWorkbookData, operation: StructureOperation) => void)(workbook, operation);
    return 0;
  }
  const range = parseA1Range(operation.range);
  const sheet = rangeSheet(workbook, operation.sheet, range);
  if (range.endRow >= sheet.rowCount || range.endColumn >= sheet.columnCount) {
    throw new Error(`Range ${operation.range} exceeds ${sheet.name}'s ${sheet.rowCount} rows and ${sheet.columnCount} columns.`);
  }
  const { rows, columns, size } = rangeShape(range);
  if (size > MAX_CELLS_PER_BATCH) throw new Error(`A range operation cannot affect more than ${MAX_CELLS_PER_BATCH.toLocaleString()} cells.`);
  if (operation.type === "set_values") matrixShape(operation.values, rows, columns, "values");
  if (operation.type === "set_formulas") matrixShape(operation.formulas, rows, columns, "formulas");
  const write = CELL_WRITERS[operation.type] as CellWriter<RangeOperation["type"]>;
  for (let row = range.startRow; row <= range.endRow; row++) {
    for (let column = range.startColumn; column <= range.endColumn; column++) {
      const cells = sheet.cellData[row] ??= {};
      write(cells[column] ??= {}, operation, { row: row - range.startRow, column: column - range.startColumn }, workbook.styles);
      if (Object.keys(cells[column]).length === 0) delete cells[column];
      if (Object.keys(cells).length === 0) delete sheet.cellData[row];
    }
  }
  return size;
}

export function applySpreadsheetBatch(doc: Y.Doc, request: SpreadsheetBatchUpdateRequest): { appliedOperations: number; affectedCells: number; workbookRevision: number } {
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
  const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
  const workbookRevision = Number(meta.get("agentRevision") ?? 0) + 1;
  doc.transact(() => {
    reconcileSpreadsheetDoc(doc, workbook, SPREADSHEET_AGENT_ORIGIN);
    meta.set("agentRevision", workbookRevision);
  }, SPREADSHEET_AGENT_ORIGIN);
  return { appliedOperations: request.operations.length, affectedCells, workbookRevision };
}

// ── Reads ────────────────────────────────────────────────────────────────────

function usedRange(sheet: SpreadsheetWorksheetData): SpreadsheetRangeData {
  let endRow = 0;
  let endColumn = 0;
  for (const [rowKey, row] of Object.entries(sheet.cellData)) {
    endRow = Math.max(endRow, Number(rowKey));
    for (const columnKey of Object.keys(row)) endColumn = Math.max(endColumn, Number(columnKey));
  }
  return { startRow: 0, startColumn: 0, endRow, endColumn };
}

export function readSpreadsheet(doc: Y.Doc, request: SpreadsheetReadRequest): Record<string, unknown> {
  const workbook = spreadsheetSnapshotFromDoc(doc);
  const requested = request.range ? parseA1Range(request.range) : null;
  const sheet = rangeSheet(workbook, request.sheet, requested);
  const range = requested ?? usedRange(sheet);
  if (range.endRow >= sheet.rowCount || range.endColumn >= sheet.columnCount) throw new Error("The requested range exceeds the sheet dimensions.");
  const { rows, columns, size } = rangeShape(range);
  if (size > MAX_READ_CELLS) throw new Error(`Read ranges cannot exceed ${MAX_READ_CELLS.toLocaleString()} cells.`);
  const include = new Set(request.include ?? ["values", "formulas"]);
  const matrix = (read: (cell: SpreadsheetCellData | undefined) => unknown) => Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => read(sheet.cellData[range.startRow + row]?.[range.startColumn + column])));
  const summary = ({ id, name, rowCount, columnCount }: SpreadsheetWorksheetData) => ({ id, name, rows: rowCount, columns: columnCount });
  return {
    workbook: { id: workbook.id, name: workbook.name },
    sheets: workbook.sheetOrder.map((id) => summary(workbook.sheets[id])),
    sheet: summary(sheet),
    range: a1Range(range),
    ...(include.has("values") ? { values: matrix((cell) => isSpreadsheetCellValue(cell?.v) ? cell.v : null) } : {}),
    ...(include.has("formulas") ? { formulas: matrix((cell) => typeof cell?.f === "string" ? cell.f : null) } : {}),
    ...(include.has("formats") ? { formats: matrix((cell) => cell?.s === undefined ? null : clone(cell.s)) } : {}),
  };
}

// ── Agent argument validation ────────────────────────────────────────────────

type Validator = (operation: Record<string, unknown>, label: string) => void;

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
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

function boundedCount(value: unknown, label: string, maximum = MAX_LINES_PER_OPERATION): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum.toLocaleString()}.`);
  }
}

function validInclude(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length >= 1 && value.length <= 3
    && new Set(value).size === value.length && value.every((item) => (SPREADSHEET_READ_FIELDS as readonly unknown[]).includes(item)));
}

const isFormula = (value: unknown) => typeof value === "string" && value.startsWith("=") && value.length <= 8_192;

const textOfLength = (maximum: number): [(value: unknown) => boolean, string] =>
  [(value) => typeof value === "string" && value.length >= 1 && value.length <= maximum, `must contain 1–${maximum} characters.`];
const oneOf = (options: readonly string[]): [(value: unknown) => boolean, string] =>
  [(value) => options.includes(String(value)), "is invalid."];
const BOOLEAN_RULE: [(value: unknown) => boolean, string] = [(value) => typeof value === "boolean", "must be a boolean."];
const COLOR_RULE: [(value: unknown) => boolean, string] = [(value) => typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value), "must be a hex color."];

/** Checked in this order; the first failing field names the error. */
const FORMAT_RULES: Record<keyof SpreadsheetSemanticFormat, [(value: unknown) => boolean, string]> = {
  bold: BOOLEAN_RULE,
  italic: BOOLEAN_RULE,
  underline: BOOLEAN_RULE,
  strikethrough: BOOLEAN_RULE,
  wrap: BOOLEAN_RULE,
  fontFamily: textOfLength(100),
  fontSize: [(value) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 200, "must be between 1 and 200."],
  textColor: COLOR_RULE,
  backgroundColor: COLOR_RULE,
  numberFormat: textOfLength(128),
  horizontalAlignment: oneOf(HORIZONTAL_ALIGNMENTS),
  verticalAlignment: oneOf(VERTICAL_ALIGNMENTS),
};

function cellValueError(item: unknown): string | undefined {
  if (item !== null && !isSpreadsheetCellValue(item)) return "contains an invalid cell value.";
  if (typeof item === "string" && item.length > 32_768) return "contains a cell string longer than 32,768 characters.";
  if (typeof item === "number" && !Number.isFinite(item)) return "contains a non-finite number.";
}

function rangeValidator(extraKey: string, validate: Validator): Validator {
  return (operation, label) => {
    assertOnlyKeys(operation, ["type", "sheet", "range", extraKey], label);
    optionalSheet(operation.sheet);
    boundedA1Range(operation.range);
    validate(operation, label);
  };
}

function matrixValidator(field: "values" | "formulas"): Validator {
  return rangeValidator(field, (operation, label) => {
    const { rows, columns, size } = rangeShape(parseA1Range(operation.range as string));
    if (size > MAX_MATRIX_CELLS) throw new Error(`${label} cannot write more than ${MAX_MATRIX_CELLS.toLocaleString()} cells.`);
    matrixShape(operation[field], rows, columns, field);
    for (const item of (operation[field] as unknown[][]).flat()) {
      const error = field === "values" ? cellValueError(item) : isFormula(item) ? undefined : "contains an invalid formula.";
      if (error) throw new Error(`${label} ${error}`);
    }
  });
}

function lineValidator(axis: SpreadsheetAxis, position: "before" | "start"): Validator {
  return (operation, label) => {
    assertOnlyKeys(operation, ["type", "sheet", position, "count"], label);
    optionalSheet(operation.sheet);
    const value = operation[position];
    if (axis === "row") boundedCount(value, `${label}.${position}`, SPREADSHEET_AXES.row.max);
    else if (typeof value !== "string" || !/^[A-Za-z]{1,3}$/.test(value)) throw new Error(`${label}.${position} must be an A1 column label.`);
    boundedCount(operation.count, `${label}.count`);
  };
}

function sheetValidator(keys: string[], validateName: boolean): Validator {
  return (operation, label) => {
    assertOnlyKeys(operation, ["type", "sheet", ...keys], label);
    optionalSheet(operation.sheet);
    if (operation.sheet === undefined) throw new Error(`${label}.sheet is required.`);
    if (validateName && !validSheetName(operation.name)) throw new Error(`${label}.name is not a valid sheet name.`);
  };
}

const OPERATION_VALIDATORS: Record<SpreadsheetBatchOperation["type"], Validator> = {
  set_values: matrixValidator("values"),
  set_formulas: matrixValidator("formulas"),
  clear: rangeValidator("include", (operation, label) => {
    if (!validInclude(operation.include)) throw new Error(`${label}.include contains unsupported or duplicate fields.`);
  }),
  format_range: rangeValidator("format", ({ format }, label) => {
    if (!isRecord(format) || Object.keys(format).length === 0) throw new Error(`${label}.format must be a non-empty object.`);
    assertOnlyKeys(format, Object.keys(FORMAT_RULES), `${label}.format`);
    for (const [field, [valid, message]] of Object.entries(FORMAT_RULES)) {
      if (format[field] !== undefined && !valid(format[field])) throw new Error(`${label}.format.${field} ${message}`);
    }
  }),
  insert_rows: lineValidator("row", "before"),
  delete_rows: lineValidator("row", "start"),
  insert_columns: lineValidator("column", "before"),
  delete_columns: lineValidator("column", "start"),
  add_sheet(operation, label) {
    assertOnlyKeys(operation, ["type", "name", "after"], label);
    if (!validSheetName(operation.name)) throw new Error(`${label}.name is not a valid sheet name.`);
    optionalSheet(operation.after);
  },
  delete_sheet: sheetValidator([], false),
  rename_sheet: sheetValidator(["name"], true),
};

export function parseSpreadsheetReadArgs(value: unknown): SpreadsheetReadRequest {
  if (!isRecord(value)) throw new Error("Spreadsheet read arguments must be an object.");
  assertOnlyKeys(value, ["sheet", "range", "include"], "Spreadsheet read arguments");
  optionalSheet(value.sheet);
  if (value.range !== undefined) boundedA1Range(value.range);
  if (!validInclude(value.include)) throw new Error("include contains unsupported or duplicate fields.");
  return value as SpreadsheetReadRequest;
}

export function parseSpreadsheetBatchUpdateArgs(value: unknown): SpreadsheetBatchUpdateRequest {
  if (!isRecord(value) || !Array.isArray(value.operations)) throw new Error("Spreadsheet batch arguments require an operations array.");
  assertOnlyKeys(value, ["operations"], "Spreadsheet batch arguments");
  if (value.operations.length < 1 || value.operations.length > MAX_OPERATIONS) {
    throw new Error(`operations must contain between 1 and ${MAX_OPERATIONS} items.`);
  }
  for (const [index, operation] of value.operations.entries()) {
    if (!isRecord(operation) || typeof operation.type !== "string") throw new Error(`operations[${index}] must be an object with a type.`);
    if (!Object.hasOwn(OPERATION_VALIDATORS, operation.type)) throw new Error(`Unsupported spreadsheet operation: ${operation.type}`);
    OPERATION_VALIDATORS[operation.type as SpreadsheetBatchOperation["type"]](operation, `operations[${index}]`);
  }
  return value as SpreadsheetBatchUpdateRequest;
}
