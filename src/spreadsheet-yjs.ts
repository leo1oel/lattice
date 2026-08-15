import * as Y from "yjs";
import {
  LATTICE_SPREADSHEET_FORMAT,
  LATTICE_SPREADSHEET_VERSION,
  type LatticeSpreadsheetFile,
  type SpreadsheetCellData,
  type SpreadsheetRangeData,
  type SpreadsheetWorkbookData,
  type SpreadsheetWorksheetData,
} from "./spreadsheet-types";

export const SPREADSHEET_CONTENT_KEY = "content";
export const SPREADSHEET_META_KEY = "spreadsheetMeta";
export const SPREADSHEET_STYLES_KEY = "spreadsheetStyles";
export const SPREADSHEET_SHEET_ORDER_KEY = "spreadsheetSheetOrder";
export const SPREADSHEET_SHEETS_KEY = "spreadsheetSheets";
export const SPREADSHEET_LOCAL_ORIGIN = "spreadsheet-local";
export const SPREADSHEET_AGENT_ORIGIN = "spreadsheet-agent";
export const SPREADSHEET_SEED_ORIGIN = "spreadsheet-seed";

export const SPREADSHEET_ROW_ID_FIELD = "__latticeRowId";
export const SPREADSHEET_COLUMN_ID_FIELD = "__latticeColumnId";

const DEFAULT_ROWS = 100;
const DEFAULT_COLUMNS = 26;
const MAX_SHEETS = 200;
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type StableMerge = {
  startRowId: string;
  startColumnId: string;
  endRowId: string;
  endColumnId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function boundedCount(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function customId(data: unknown, field: string): string | undefined {
  if (!isRecord(data) || !isRecord(data.custom)) return undefined;
  const value = data.custom[field];
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;
}

function dataWithId(data: unknown, field: string, id: string): Record<string, unknown> {
  const output = isRecord(data) ? clone(data) : {};
  output.custom = { ...(isRecord(output.custom) ? output.custom : {}), [field]: id };
  return output;
}

function stableId(prefix: string, seed: string, index: number): string {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}_${index.toString(36)}`;
}

function worksheetDefaults(id: string, name: string, rows: number, columns: number): SpreadsheetWorksheetData {
  const rowData: Record<number, Record<string, unknown>> = {};
  const columnData: Record<number, Record<string, unknown>> = {};
  for (let row = 0; row < rows; row++) rowData[row] = dataWithId({}, SPREADSHEET_ROW_ID_FIELD, stableId("row", id, row));
  for (let column = 0; column < columns; column++) columnData[column] = dataWithId({}, SPREADSHEET_COLUMN_ID_FIELD, stableId("column", id, column));
  return {
    id,
    name,
    rowCount: rows,
    columnCount: columns,
    cellData: {},
    rowData,
    columnData,
    mergeData: [],
    tabColor: "",
    hidden: 0,
    freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 88,
    defaultRowHeight: 24,
    rowHeader: { width: 46 },
    columnHeader: { height: 24 },
    showGridlines: 1,
    rightToLeft: 0,
  };
}

export function createDefaultSpreadsheet(name = "Spreadsheet", deterministic = false): LatticeSpreadsheetFile {
  const workbookId = deterministic ? "workbook_default" : newId("workbook");
  const sheetId = deterministic ? "sheet_default" : newId("sheet");
  return {
    format: LATTICE_SPREADSHEET_FORMAT,
    version: LATTICE_SPREADSHEET_VERSION,
    workbook: {
      id: workbookId,
      name,
      appVersion: "0.25.1",
      locale: "enUS",
      styles: {},
      sheetOrder: [sheetId],
      sheets: { [sheetId]: worksheetDefaults(sheetId, "Sheet1", DEFAULT_ROWS, DEFAULT_COLUMNS) },
    },
  };
}

function normalizeCell(value: unknown): SpreadsheetCellData | null {
  if (!isRecord(value)) return null;
  const cell = clone(value) as SpreadsheetCellData;
  if (cell.v !== undefined && cell.v !== null && typeof cell.v !== "string" && typeof cell.v !== "number" && typeof cell.v !== "boolean") return null;
  if (cell.f !== undefined && cell.f !== null && typeof cell.f !== "string") return null;
  return cell;
}

function normalizeWorksheet(value: unknown, id: string, fallbackName: string): SpreadsheetWorksheetData | null {
  if (!isRecord(value)) return null;
  const rows = boundedCount(value.rowCount, DEFAULT_ROWS, MAX_ROWS);
  const columns = boundedCount(value.columnCount, DEFAULT_COLUMNS, MAX_COLUMNS);
  const defaults = worksheetDefaults(id, typeof value.name === "string" && value.name ? value.name : fallbackName, rows, columns);
  const output = { ...defaults, ...clone(value), id } as SpreadsheetWorksheetData;
  output.name = typeof output.name === "string" && output.name ? output.name : fallbackName;
  output.rowCount = rows;
  output.columnCount = columns;
  output.rowData = isRecord(value.rowData) ? clone(value.rowData) as SpreadsheetWorksheetData["rowData"] : {};
  output.columnData = isRecord(value.columnData) ? clone(value.columnData) as SpreadsheetWorksheetData["columnData"] : {};
  const existingRowIds = new Set(Object.values(output.rowData).map((data) => customId(data, SPREADSHEET_ROW_ID_FIELD)).filter((id): id is string => Boolean(id)));
  const existingColumnIds = new Set(Object.values(output.columnData).map((data) => customId(data, SPREADSHEET_COLUMN_ID_FIELD)).filter((id): id is string => Boolean(id)));
  const usedRowIds = new Set<string>();
  const usedColumnIds = new Set<string>();
  for (let row = 0; row < rows; row++) {
    const existing = customId(output.rowData[row], SPREADSHEET_ROW_ID_FIELD);
    const deterministic = stableId("row", id, row);
    const rowId = existing && !usedRowIds.has(existing)
      ? existing
      : !existingRowIds.has(deterministic) && !usedRowIds.has(deterministic)
        ? deterministic
        : newId("row");
    usedRowIds.add(rowId);
    output.rowData[row] = dataWithId(output.rowData[row], SPREADSHEET_ROW_ID_FIELD, rowId);
  }
  for (let column = 0; column < columns; column++) {
    const existing = customId(output.columnData[column], SPREADSHEET_COLUMN_ID_FIELD);
    const deterministic = stableId("column", id, column);
    const columnId = existing && !usedColumnIds.has(existing)
      ? existing
      : !existingColumnIds.has(deterministic) && !usedColumnIds.has(deterministic)
        ? deterministic
        : newId("column");
    usedColumnIds.add(columnId);
    output.columnData[column] = dataWithId(output.columnData[column], SPREADSHEET_COLUMN_ID_FIELD, columnId);
  }
  output.cellData = {};
  if (isRecord(value.cellData)) {
    for (const [rowKey, rowValue] of Object.entries(value.cellData)) {
      const row = Number(rowKey);
      if (!Number.isSafeInteger(row) || row < 0 || row >= rows || !isRecord(rowValue)) continue;
      for (const [columnKey, cellValue] of Object.entries(rowValue)) {
        const column = Number(columnKey);
        const cell = normalizeCell(cellValue);
        if (!Number.isSafeInteger(column) || column < 0 || column >= columns || !cell) continue;
        (output.cellData[row] ??= {})[column] = cell;
      }
    }
  }
  output.mergeData = Array.isArray(value.mergeData)
    ? value.mergeData.filter((range): range is SpreadsheetRangeData => isValidRange(range, rows, columns)).map(clone)
    : [];
  return output;
}

function isValidRange(value: unknown, rows: number, columns: number): value is SpreadsheetRangeData {
  if (!isRecord(value)) return false;
  const { startRow, startColumn, endRow, endColumn } = value;
  return [startRow, startColumn, endRow, endColumn].every(Number.isSafeInteger)
    && Number(startRow) >= 0 && Number(startColumn) >= 0
    && Number(endRow) >= Number(startRow) && Number(endColumn) >= Number(startColumn)
    && Number(endRow) < rows && Number(endColumn) < columns;
}

export function parseSpreadsheetFile(source: string): LatticeSpreadsheetFile | null {
  if (new TextEncoder().encode(source).byteLength > MAX_FILE_BYTES) return null;
  const trimmed = source.trim();
  if (!trimmed) return createDefaultSpreadsheet("Spreadsheet", true);
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!isRecord(parsed) || parsed.format !== LATTICE_SPREADSHEET_FORMAT || parsed.version !== LATTICE_SPREADSHEET_VERSION || !isRecord(parsed.workbook)) return null;
  const input = parsed.workbook;
  if (!Array.isArray(input.sheetOrder) || input.sheetOrder.length === 0 || input.sheetOrder.length > MAX_SHEETS || !isRecord(input.sheets)) return null;
  const sheetOrder = input.sheetOrder.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128);
  if (sheetOrder.length !== input.sheetOrder.length || new Set(sheetOrder).size !== sheetOrder.length) return null;
  const sheets: Record<string, SpreadsheetWorksheetData> = {};
  for (let index = 0; index < sheetOrder.length; index++) {
    const id = sheetOrder[index];
    const sheet = normalizeWorksheet(input.sheets[id], id, `Sheet${index + 1}`);
    if (!sheet) return null;
    sheets[id] = sheet;
  }
  const workbook: SpreadsheetWorkbookData = {
    ...clone(input),
    id: typeof input.id === "string" && input.id ? input.id : newId("workbook"),
    name: typeof input.name === "string" && input.name ? input.name : "Spreadsheet",
    appVersion: typeof input.appVersion === "string" ? input.appVersion : "0.25.1",
    locale: typeof input.locale === "string" ? input.locale : "enUS",
    styles: isRecord(input.styles) ? clone(input.styles) as SpreadsheetWorkbookData["styles"] : {},
    sheetOrder,
    sheets,
  };
  return { format: LATTICE_SPREADSHEET_FORMAT, version: LATTICE_SPREADSHEET_VERSION, workbook };
}

export function serializeSpreadsheetFile(workbook: SpreadsheetWorkbookData): string {
  return `${JSON.stringify(canonicalize({
    format: LATTICE_SPREADSHEET_FORMAT,
    version: LATTICE_SPREADSHEET_VERSION,
    workbook,
  }), null, 2)}\n`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sheetPartKey(sheetId: string, part: string): string {
  return `${SPREADSHEET_SHEETS_KEY}:${encodeURIComponent(sheetId)}:${part}`;
}

function sheetMapFor(doc: Y.Doc, sheetId: string): Y.Map<unknown> | undefined {
  if (!doc.getMap<boolean>(SPREADSHEET_SHEETS_KEY).has(sheetId)) return undefined;
  return doc.getMap<unknown>(sheetPartKey(sheetId, "metadata"));
}

function arrayAt(doc: Y.Doc, sheetId: string, key: "rows" | "columns"): Y.Array<string> {
  return doc.getArray<string>(sheetPartKey(sheetId, key));
}

function mapAt<T>(doc: Y.Doc, sheetId: string, key: string): Y.Map<T> {
  return doc.getMap<T>(sheetPartKey(sheetId, key));
}

function syncArray(target: Y.Array<string>, desired: string[]): void {
  const wanted = new Set(desired);
  for (let index = target.length - 1; index >= 0; index--) {
    if (!wanted.has(target.get(index))) target.delete(index, 1);
  }
  for (let index = 0; index < desired.length; index++) {
    if (target.get(index) === desired[index]) continue;
    const current = target.toArray();
    const existing = current.indexOf(desired[index], index + 1);
    if (existing >= 0) target.delete(existing, 1);
    target.insert(index, [desired[index]]);
  }
  if (target.length > desired.length) target.delete(desired.length, target.length - desired.length);
}

function syncJsonMap(target: Y.Map<unknown>, desired: Record<string, unknown>): void {
  for (const key of target.keys()) if (!(key in desired)) target.delete(key);
  for (const [key, value] of Object.entries(desired)) {
    if (!jsonEqual(target.get(key), value)) target.set(key, clone(value));
  }
}

function rowAndColumnIds(sheet: SpreadsheetWorksheetData): { rows: string[]; columns: string[] } {
  const rows: string[] = [];
  const columns: string[] = [];
  const seenRows = new Set<string>();
  const seenColumns = new Set<string>();
  for (let index = 0; index < sheet.rowCount; index++) {
    let id = customId(sheet.rowData[index], SPREADSHEET_ROW_ID_FIELD);
    if (!id || seenRows.has(id)) id = newId("row");
    seenRows.add(id);
    rows.push(id);
    sheet.rowData[index] = dataWithId(sheet.rowData[index], SPREADSHEET_ROW_ID_FIELD, id);
  }
  for (let index = 0; index < sheet.columnCount; index++) {
    let id = customId(sheet.columnData[index], SPREADSHEET_COLUMN_ID_FIELD);
    if (!id || seenColumns.has(id)) id = newId("column");
    seenColumns.add(id);
    columns.push(id);
    sheet.columnData[index] = dataWithId(sheet.columnData[index], SPREADSHEET_COLUMN_ID_FIELD, id);
  }
  return { rows, columns };
}

function cellKey(rowId: string, columnId: string): string {
  return `${encodeURIComponent(rowId)}|${encodeURIComponent(columnId)}`;
}

function cellFieldKey(rowId: string, columnId: string, field: string): string {
  return `${cellKey(rowId, columnId)}|${encodeURIComponent(field)}`;
}

function seedSheet(doc: Y.Doc, sheetData: SpreadsheetWorksheetData): void {
  const sheet = doc.getMap<unknown>(sheetPartKey(sheetData.id, "metadata"));
  const rows = arrayAt(doc, sheetData.id, "rows");
  const columns = arrayAt(doc, sheetData.id, "columns");
  const rowData = mapAt<unknown>(doc, sheetData.id, "rowData");
  const columnData = mapAt<unknown>(doc, sheetData.id, "columnData");
  const cells = mapAt<unknown>(doc, sheetData.id, "cells");
  const merges = mapAt<StableMerge>(doc, sheetData.id, "merges");
  const ids = rowAndColumnIds(sheetData);
  syncArray(rows, ids.rows);
  syncArray(columns, ids.columns);
  for (let index = 0; index < ids.rows.length; index++) rowData.set(ids.rows[index], clone(sheetData.rowData[index] ?? {}));
  for (let index = 0; index < ids.columns.length; index++) columnData.set(ids.columns[index], clone(sheetData.columnData[index] ?? {}));
  for (const [rowKey, row] of Object.entries(sheetData.cellData)) {
    for (const [columnKey, cellData] of Object.entries(row)) {
      for (const [field, value] of Object.entries(cellData)) {
        cells.set(cellFieldKey(ids.rows[Number(rowKey)], ids.columns[Number(columnKey)], field), clone(value));
      }
    }
  }
  for (const range of sheetData.mergeData) {
    const merge = {
      startRowId: ids.rows[range.startRow],
      startColumnId: ids.columns[range.startColumn],
      endRowId: ids.rows[range.endRow],
      endColumnId: ids.columns[range.endColumn],
    };
    merges.set(cellKey(merge.startRowId, merge.startColumnId), merge);
  }
  const settings = clone(sheetData) as Record<string, unknown>;
  for (const key of ["id", "name", "rowCount", "columnCount", "cellData", "rowData", "columnData", "mergeData"]) delete settings[key];
  sheet.set("name", sheetData.name);
  sheet.set("settings", settings);
}

function seedWorkbook(doc: Y.Doc, workbook: SpreadsheetWorkbookData, origin: unknown): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
    const metadata = clone(workbook) as Record<string, unknown>;
    for (const key of ["styles", "sheetOrder", "sheets"]) delete metadata[key];
    syncJsonMap(meta, { formatVersion: LATTICE_SPREADSHEET_VERSION, initialized: true, workbook: metadata });
    syncJsonMap(doc.getMap(SPREADSHEET_STYLES_KEY), workbook.styles);
    const order = doc.getArray<string>(SPREADSHEET_SHEET_ORDER_KEY);
    syncArray(order, workbook.sheetOrder);
    const sheets = doc.getMap<boolean>(SPREADSHEET_SHEETS_KEY);
    for (const id of workbook.sheetOrder) {
      sheets.set(id, true);
      seedSheet(doc, clone(workbook.sheets[id]));
    }
  }, origin);
}

export function hasStructuredSpreadsheet(doc: Y.Doc): boolean {
  return doc.getMap<unknown>(SPREADSHEET_META_KEY).get("initialized") === true;
}

export function seedSpreadsheetDoc(doc: Y.Doc): boolean {
  if (hasStructuredSpreadsheet(doc)) return false;
  const parsed = parseSpreadsheetFile(doc.getText(SPREADSHEET_CONTENT_KEY).toString());
  if (!parsed) throw new Error("Invalid .lattice-sheet document");
  seedWorkbook(doc, parsed.workbook, SPREADSHEET_SEED_ORIGIN);
  return true;
}

function uniqueOrder(order: Y.Array<string>): string[] {
  const seen = new Set<string>();
  return order.toArray().filter((id) => {
    if (typeof id !== "string" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function spreadsheetSnapshotFromDoc(doc: Y.Doc): SpreadsheetWorkbookData {
  if (!hasStructuredSpreadsheet(doc)) {
    const parsed = parseSpreadsheetFile(doc.getText(SPREADSHEET_CONTENT_KEY).toString());
    if (!parsed) throw new Error("Invalid .lattice-sheet document");
    return parsed.workbook;
  }
  const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
  if (meta.get("formatVersion") !== LATTICE_SPREADSHEET_VERSION || !isRecord(meta.get("workbook"))) {
    throw new Error(`Unsupported spreadsheet collaboration format: ${String(meta.get("formatVersion"))}`);
  }
  const workbook = clone(meta.get("workbook")) as SpreadsheetWorkbookData;
  workbook.styles = {};
  doc.getMap<unknown>(SPREADSHEET_STYLES_KEY).forEach((value, key) => { workbook.styles[key] = clone(value) as Record<string, unknown> | null; });
  workbook.sheetOrder = uniqueOrder(doc.getArray<string>(SPREADSHEET_SHEET_ORDER_KEY));
  workbook.sheets = {};
  for (const sheetId of workbook.sheetOrder) {
    const sheet = sheetMapFor(doc, sheetId);
    if (!sheet) continue;
    const rows = uniqueOrder(arrayAt(doc, sheetId, "rows"));
    const columns = uniqueOrder(arrayAt(doc, sheetId, "columns"));
    const rowIndex = new Map(rows.map((id, index) => [id, index]));
    const columnIndex = new Map(columns.map((id, index) => [id, index]));
    const rawSettings = sheet.get("settings");
    const settings: Record<string, unknown> = isRecord(rawSettings) ? clone(rawSettings) : {};
    const output = {
      ...worksheetDefaults(sheetId, typeof sheet.get("name") === "string" ? String(sheet.get("name")) : "Sheet", rows.length, columns.length),
      ...settings,
      id: sheetId,
      name: typeof sheet.get("name") === "string" ? String(sheet.get("name")) : "Sheet",
      rowCount: rows.length,
      columnCount: columns.length,
      rowData: {},
      columnData: {},
      cellData: {},
      mergeData: [],
    } as SpreadsheetWorksheetData;
    mapAt<unknown>(doc, sheetId, "rowData").forEach((value, id) => {
      const index = rowIndex.get(id);
      if (index !== undefined) output.rowData[index] = dataWithId(value, SPREADSHEET_ROW_ID_FIELD, id);
    });
    mapAt<unknown>(doc, sheetId, "columnData").forEach((value, id) => {
      const index = columnIndex.get(id);
      if (index !== undefined) output.columnData[index] = dataWithId(value, SPREADSHEET_COLUMN_ID_FIELD, id);
    });
    for (let index = 0; index < rows.length; index++) output.rowData[index] ??= dataWithId({}, SPREADSHEET_ROW_ID_FIELD, rows[index]);
    for (let index = 0; index < columns.length; index++) output.columnData[index] ??= dataWithId({}, SPREADSHEET_COLUMN_ID_FIELD, columns[index]);
    mapAt<unknown>(doc, sheetId, "cells").forEach((value, key) => {
      const [encodedRow, encodedColumn, encodedField] = key.split("|");
      if (encodedColumn === undefined || encodedField === undefined) return;
      const row = rowIndex.get(decodeURIComponent(encodedRow));
      const column = columnIndex.get(decodeURIComponent(encodedColumn));
      if (row === undefined || column === undefined) return;
      const data = (output.cellData[row] ??= {})[column] ??= {};
      data[decodeURIComponent(encodedField)] = clone(value);
    });
    mapAt<StableMerge>(doc, sheetId, "merges").forEach((merge) => {
      const startRow = rowIndex.get(merge.startRowId);
      const startColumn = columnIndex.get(merge.startColumnId);
      const endRow = rowIndex.get(merge.endRowId);
      const endColumn = columnIndex.get(merge.endColumnId);
      if (startRow !== undefined && startColumn !== undefined && endRow !== undefined && endColumn !== undefined) {
        output.mergeData.push({ startRow, startColumn, endRow, endColumn });
      }
    });
    workbook.sheets[sheetId] = output;
  }
  if (workbook.sheetOrder.length === 0 || Object.keys(workbook.sheets).length === 0) {
    throw new Error("A spreadsheet must contain at least one sheet");
  }
  return workbook;
}

export function spreadsheetDocContent(doc: Y.Doc): string {
  return serializeSpreadsheetFile(spreadsheetSnapshotFromDoc(doc));
}

function reconcileSheet(doc: Y.Doc, input: SpreadsheetWorksheetData): void {
  const data = normalizeWorksheet(input, input.id, input.name);
  if (!data) throw new Error(`Invalid worksheet: ${input.name}`);
  const sheet = doc.getMap<unknown>(sheetPartKey(data.id, "metadata"));
  const ids = rowAndColumnIds(data);
  sheet.set("name", data.name);
  const settings = clone(data) as Record<string, unknown>;
  for (const key of ["id", "name", "rowCount", "columnCount", "cellData", "rowData", "columnData", "mergeData"]) delete settings[key];
  if (!jsonEqual(sheet.get("settings"), settings)) sheet.set("settings", settings);
  const rows = arrayAt(doc, data.id, "rows");
  const columns = arrayAt(doc, data.id, "columns");
  syncArray(rows, ids.rows);
  syncArray(columns, ids.columns);
  const rowData = mapAt<unknown>(doc, data.id, "rowData");
  const columnData = mapAt<unknown>(doc, data.id, "columnData");
  syncJsonMap(rowData, Object.fromEntries(ids.rows.map((id, index) => [id, data.rowData[index] ?? {}])));
  syncJsonMap(columnData, Object.fromEntries(ids.columns.map((id, index) => [id, data.columnData[index] ?? {}])));
  const cells = mapAt<unknown>(doc, data.id, "cells");
  const desiredCellFields = new Set<string>();
  for (const [rowKey, row] of Object.entries(data.cellData)) {
    for (const [columnKey, cellData] of Object.entries(row)) {
      for (const [field, value] of Object.entries(cellData)) {
        const key = cellFieldKey(ids.rows[Number(rowKey)], ids.columns[Number(columnKey)], field);
        desiredCellFields.add(key);
        if (!jsonEqual(cells.get(key), value)) cells.set(key, clone(value));
      }
    }
  }
  for (const key of cells.keys()) if (!desiredCellFields.has(key)) cells.delete(key);
  const merges = mapAt<StableMerge>(doc, data.id, "merges");
  const desiredMerges: Record<string, StableMerge> = {};
  for (const range of data.mergeData) {
    const merge = {
      startRowId: ids.rows[range.startRow],
      startColumnId: ids.columns[range.startColumn],
      endRowId: ids.rows[range.endRow],
      endColumnId: ids.columns[range.endColumn],
    };
    desiredMerges[cellKey(merge.startRowId, merge.startColumnId)] = merge;
  }
  syncJsonMap(merges as unknown as Y.Map<unknown>, desiredMerges);
}

function applyRecordChanges(
  current: unknown,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const output = isRecord(current) ? clone(current) : {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (jsonEqual(previous[key], next[key]) && (key in previous) === (key in next)) continue;
    if (key in next) output[key] = clone(next[key]);
    else delete output[key];
  }
  return output;
}

function applyJsonMapChanges(
  target: Y.Map<unknown>,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (jsonEqual(previous[key], next[key]) && (key in previous) === (key in next)) continue;
    if (!(key in next)) {
      target.delete(key);
      continue;
    }
    const value = isRecord(previous[key]) && isRecord(next[key])
      ? applyRecordChanges(target.get(key), previous[key], next[key])
      : clone(next[key]);
    target.set(key, value);
  }
}

function applySequenceChanges(target: Y.Array<string>, previous: string[], next: string[]): void {
  const previousIds = new Set(previous);
  const nextIds = new Set(next);
  for (let index = target.length - 1; index >= 0; index--) {
    const id = target.get(index);
    if (previousIds.has(id) && !nextIds.has(id)) target.delete(index, 1);
  }
  for (let index = 0; index < next.length; index++) {
    const id = next[index];
    if (previousIds.has(id) || target.toArray().includes(id)) continue;
    const current = target.toArray();
    let insertionIndex = current.length;
    for (let before = index - 1; before >= 0; before--) {
      const anchor = current.indexOf(next[before]);
      if (anchor >= 0) {
        insertionIndex = anchor + 1;
        break;
      }
    }
    if (insertionIndex === current.length) {
      for (let after = index + 1; after < next.length; after++) {
        const anchor = current.indexOf(next[after]);
        if (anchor >= 0) {
          insertionIndex = anchor;
          break;
        }
      }
    }
    target.insert(insertionIndex, [id]);
  }

  const previousProjection = previous.filter((id) => nextIds.has(id));
  const nextProjection = next.filter((id) => previousIds.has(id));
  if (jsonEqual(previousProjection, nextProjection)) return;
  const desired = next.filter((id) => target.toArray().includes(id));
  for (let index = 1; index < desired.length; index++) {
    const current = target.toArray();
    const previousIndex = current.indexOf(desired[index - 1]);
    const currentIndex = current.indexOf(desired[index]);
    if (currentIndex > previousIndex) continue;
    target.delete(currentIndex, 1);
    const anchor = target.toArray().indexOf(desired[index - 1]);
    target.insert(anchor + 1, [desired[index]]);
  }
}

type NormalizedSheet = {
  data: SpreadsheetWorksheetData;
  rows: string[];
  columns: string[];
};

function normalizedSheet(input: SpreadsheetWorksheetData): NormalizedSheet {
  const data = normalizeWorksheet(input, input.id, input.name);
  if (!data) throw new Error(`Invalid worksheet: ${input.name}`);
  const { rows, columns } = rowAndColumnIds(data);
  return { data, rows, columns };
}

function indexedData(
  data: Record<number, Record<string, unknown>>,
  ids: string[],
): Record<string, unknown> {
  return Object.fromEntries(ids.map((id, index) => [id, clone(data[index] ?? {})]));
}

function cellFields(sheet: NormalizedSheet): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [rowKey, row] of Object.entries(sheet.data.cellData)) {
    const rowId = sheet.rows[Number(rowKey)];
    if (!rowId) continue;
    for (const [columnKey, cell] of Object.entries(row)) {
      const columnId = sheet.columns[Number(columnKey)];
      if (!columnId) continue;
      for (const [field, value] of Object.entries(cell)) {
        output[cellFieldKey(rowId, columnId, field)] = clone(value);
      }
    }
  }
  return output;
}

function stableMerges(sheet: NormalizedSheet): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const range of sheet.data.mergeData) {
    const merge: StableMerge = {
      startRowId: sheet.rows[range.startRow],
      startColumnId: sheet.columns[range.startColumn],
      endRowId: sheet.rows[range.endRow],
      endColumnId: sheet.columns[range.endColumn],
    };
    output[cellKey(merge.startRowId, merge.startColumnId)] = merge;
  }
  return output;
}

function sheetSettings(sheet: SpreadsheetWorksheetData): Record<string, unknown> {
  const settings = clone(sheet) as Record<string, unknown>;
  for (const key of ["id", "name", "rowCount", "columnCount", "cellData", "rowData", "columnData", "mergeData"]) delete settings[key];
  return settings;
}

function applySheetChanges(doc: Y.Doc, previousInput: SpreadsheetWorksheetData, nextInput: SpreadsheetWorksheetData): void {
  const previous = normalizedSheet(previousInput);
  const next = normalizedSheet(nextInput);
  const sheet = sheetMapFor(doc, next.data.id);
  if (!sheet) return;
  if (previous.data.name !== next.data.name) sheet.set("name", next.data.name);
  const previousSettings = sheetSettings(previous.data);
  const nextSettings = sheetSettings(next.data);
  if (!jsonEqual(previousSettings, nextSettings)) {
    sheet.set("settings", applyRecordChanges(sheet.get("settings"), previousSettings, nextSettings));
  }
  applySequenceChanges(arrayAt(doc, next.data.id, "rows"), previous.rows, next.rows);
  applySequenceChanges(arrayAt(doc, next.data.id, "columns"), previous.columns, next.columns);
  applyJsonMapChanges(
    mapAt(doc, next.data.id, "rowData"),
    indexedData(previous.data.rowData, previous.rows),
    indexedData(next.data.rowData, next.rows),
  );
  applyJsonMapChanges(
    mapAt(doc, next.data.id, "columnData"),
    indexedData(previous.data.columnData, previous.columns),
    indexedData(next.data.columnData, next.columns),
  );
  applyJsonMapChanges(mapAt(doc, next.data.id, "cells"), cellFields(previous), cellFields(next));
  applyJsonMapChanges(mapAt(doc, next.data.id, "merges"), stableMerges(previous), stableMerges(next));
}

/** Apply only local Univer changes, preserving newer remote fields in the Y.Doc. */
export function reconcileSpreadsheetDocChanges(
  doc: Y.Doc,
  previous: SpreadsheetWorkbookData,
  next: SpreadsheetWorkbookData,
  origin: unknown = SPREADSHEET_LOCAL_ORIGIN,
): void {
  if (!hasStructuredSpreadsheet(doc)) seedWorkbook(doc, previous, origin);
  const order = next.sheetOrder.filter((id) => next.sheets[id]);
  if (order.length === 0 || order.length > MAX_SHEETS) throw new Error("A spreadsheet must contain between 1 and 200 sheets");
  doc.transact(() => {
    const previousMetadata = clone(previous) as Record<string, unknown>;
    const nextMetadata = clone(next) as Record<string, unknown>;
    for (const key of ["styles", "sheetOrder", "sheets"]) {
      delete previousMetadata[key];
      delete nextMetadata[key];
    }
    const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
    meta.set("formatVersion", LATTICE_SPREADSHEET_VERSION);
    meta.set("initialized", true);
    if (!jsonEqual(previousMetadata, nextMetadata)) {
      meta.set("workbook", applyRecordChanges(meta.get("workbook"), previousMetadata, nextMetadata));
    }
    applyJsonMapChanges(
      doc.getMap(SPREADSHEET_STYLES_KEY),
      previous.styles as Record<string, unknown>,
      next.styles as Record<string, unknown>,
    );
    applySequenceChanges(doc.getArray<string>(SPREADSHEET_SHEET_ORDER_KEY), previous.sheetOrder, order);
    const sheets = doc.getMap<boolean>(SPREADSHEET_SHEETS_KEY);
    const previousIds = new Set(previous.sheetOrder);
    const nextIds = new Set(order);
    for (const id of previousIds) if (!nextIds.has(id)) sheets.delete(id);
    for (const id of order) {
      if (!previousIds.has(id)) {
        if (!sheets.has(id)) {
          sheets.set(id, true);
          seedSheet(doc, clone(next.sheets[id]));
        }
      } else if (previous.sheets[id]) {
        applySheetChanges(doc, previous.sheets[id], next.sheets[id]);
      }
    }
  }, origin);
}

/** Reconcile a Univer snapshot into stable row/column CRDT structures. */
export function reconcileSpreadsheetDoc(
  doc: Y.Doc,
  workbook: SpreadsheetWorkbookData,
  origin: unknown = SPREADSHEET_LOCAL_ORIGIN,
): void {
  if (!hasStructuredSpreadsheet(doc)) seedWorkbook(doc, workbook, origin);
  doc.transact(() => {
    const metadata = clone(workbook) as Record<string, unknown>;
    for (const key of ["styles", "sheetOrder", "sheets"]) delete metadata[key];
    const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
    meta.set("formatVersion", LATTICE_SPREADSHEET_VERSION);
    meta.set("initialized", true);
    if (!jsonEqual(meta.get("workbook"), metadata)) meta.set("workbook", metadata);
    syncJsonMap(doc.getMap(SPREADSHEET_STYLES_KEY), workbook.styles ?? {});
    const order = workbook.sheetOrder.filter((id) => workbook.sheets[id]);
    if (order.length === 0 || order.length > MAX_SHEETS) throw new Error("A spreadsheet must contain between 1 and 200 sheets");
    syncArray(doc.getArray<string>(SPREADSHEET_SHEET_ORDER_KEY), order);
    const sheets = doc.getMap<boolean>(SPREADSHEET_SHEETS_KEY);
    for (const id of order) {
      if (!sheets.has(id)) {
        sheets.set(id, true);
        seedSheet(doc, clone(workbook.sheets[id]));
      } else {
        reconcileSheet(doc, workbook.sheets[id]);
      }
    }
    for (const id of sheets.keys()) if (!order.includes(id)) sheets.delete(id);
  }, origin);
}

export function replaceSpreadsheetDocFromSource(doc: Y.Doc, source: string, origin: unknown = SPREADSHEET_LOCAL_ORIGIN): void {
  const parsed = parseSpreadsheetFile(source);
  if (!parsed) throw new Error("Invalid .lattice-sheet document");
  reconcileSpreadsheetDoc(doc, parsed.workbook, origin);
}

export type SpreadsheetDocInternals = {
  sheet: Y.Map<unknown>;
  rows: Y.Array<string>;
  columns: Y.Array<string>;
  rowData: Y.Map<unknown>;
  columnData: Y.Map<unknown>;
  cells: Y.Map<unknown>;
  merges: Y.Map<StableMerge>;
};

/** Internal structured access for the semantic Agent adapter. */
export function spreadsheetDocInternals(doc: Y.Doc, sheetId: string): SpreadsheetDocInternals {
  const sheet = sheetMapFor(doc, sheetId);
  if (!sheet) throw new Error(`Spreadsheet sheet not found: ${sheetId}`);
  return {
    sheet,
    rows: arrayAt(doc, sheetId, "rows"),
    columns: arrayAt(doc, sheetId, "columns"),
    rowData: mapAt(doc, sheetId, "rowData"),
    columnData: mapAt(doc, sheetId, "columnData"),
    cells: mapAt(doc, sheetId, "cells"),
    merges: mapAt(doc, sheetId, "merges"),
  };
}

export function spreadsheetCellKey(rowId: string, columnId: string): string {
  return cellKey(rowId, columnId);
}
