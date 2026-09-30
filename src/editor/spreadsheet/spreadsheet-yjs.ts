import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import * as Y from "yjs";
import { isRecord } from "../../app-utils";
import {
  LATTICE_SPREADSHEET_FORMAT,
  LATTICE_SPREADSHEET_VERSION,
  SPREADSHEET_AXES,
  clone,
  inBounds,
  isSpreadsheetCellValue,
  jsonEqual,
  newId,
  type LatticeSpreadsheetFile,
  type SpreadsheetAxis,
  type SpreadsheetCellData,
  type SpreadsheetRangeData,
  type SpreadsheetWorkbookData,
  type SpreadsheetWorksheetData,
} from "./spreadsheet-types";

export const SPREADSHEET_META_KEY = "spreadsheetMeta";
export const SPREADSHEET_LOCAL_ORIGIN = "spreadsheet-local";
export const SPREADSHEET_AGENT_ORIGIN = "spreadsheet-agent";
const SPREADSHEET_SEED_ORIGIN = "spreadsheet-seed";
const CONTENT_KEY = "content";
const STYLES_KEY = "spreadsheetStyles";
const SHEET_ORDER_KEY = "spreadsheetSheetOrder";
const SHEETS_KEY = "spreadsheetSheets";

const DEFAULT_ROWS = 100;
const DEFAULT_COLUMNS = 26;
const MAX_SHEETS = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const AXES = ["row", "column"] as const;
// Everything else on a worksheet or workbook is opaque settings/metadata that
// round-trips as one JSON value.
const SHEET_STRUCTURE_KEYS = ["id", "name", "rowCount", "columnCount", "cellData", "rowData", "columnData", "mergeData"];
const WORKBOOK_STRUCTURE_KEYS = ["styles", "sheetOrder", "sheets"];

/**
 * A malformed workbook. `message` stays English because the Agent's spreadsheet
 * tools return it verbatim; the editor shows the catalog `descriptor` instead.
 */
export class SpreadsheetDocumentError extends Error {
  constructor(message: string, readonly descriptor: MessageDescriptor) {
    super(message);
  }
}

type StableMerge = { startRowId: string; startColumnId: string; endRowId: string; endColumnId: string };

function omit(value: object, keys: readonly string[]): Record<string, unknown> {
  const output = clone(value) as Record<string, unknown>;
  for (const key of keys) delete output[key];
  return output;
}

const boundedCount = (value: unknown, fallback: number, maximum: number) =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : fallback;

function axisId(data: unknown, axis: SpreadsheetAxis): string | undefined {
  const value = isRecord(data) && isRecord(data.custom) ? data.custom[SPREADSHEET_AXES[axis].idField] : undefined;
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : undefined;
}

function withAxisId(data: unknown, axis: SpreadsheetAxis, id: string): Record<string, unknown> {
  const output = isRecord(data) ? clone(data) : {};
  output.custom = { ...(isRecord(output.custom) ? output.custom : {}), [SPREADSHEET_AXES[axis].idField]: id };
  return output;
}

/** Row or column metadata for a newly inserted line, with a fresh stable ID. */
export const newAxisData = (axis: SpreadsheetAxis) => withAxisId({}, axis, newId(axis));

function stableId(prefix: string, seed: string, index: number): string {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}_${index.toString(36)}`;
}

export function createWorksheet(id: string, name: string, rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS): SpreadsheetWorksheetData {
  const lines = (axis: SpreadsheetAxis, count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [index, withAxisId({}, axis, stableId(axis, id, index))]),
  );
  return {
    id, name, rowCount: rows, columnCount: columns, cellData: {}, rowData: lines("row", rows), columnData: lines("column", columns), mergeData: [],
    tabColor: "", hidden: 0, freeze: { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 },
    zoomRatio: 1, scrollTop: 0, scrollLeft: 0, defaultColumnWidth: 88, defaultRowHeight: 24,
    rowHeader: { width: 46 }, columnHeader: { height: 24 }, showGridlines: 1, rightToLeft: 0,
  };
}

const spreadsheetFile = (workbook: SpreadsheetWorkbookData): LatticeSpreadsheetFile =>
  ({ format: LATTICE_SPREADSHEET_FORMAT, version: LATTICE_SPREADSHEET_VERSION, workbook });

// Default names are stored workbook data: peers that open the same empty file
// independently must derive byte-identical workbooks, whatever their locale.
/* eslint-disable lingui/no-unlocalized-strings -- stored workbook defaults */
export function createDefaultSpreadsheet(name = "Spreadsheet", deterministic = false): LatticeSpreadsheetFile {
  const sheetId = deterministic ? "sheet_default" : newId("sheet");
  return spreadsheetFile({
    id: deterministic ? "workbook_default" : newId("workbook"),
    name,
    appVersion: "0.25.1",
    locale: "enUS",
    styles: {},
    sheetOrder: [sheetId],
    sheets: { [sheetId]: createWorksheet(sheetId, "Sheet1") },
  });
}
/* eslint-enable lingui/no-unlocalized-strings */

function normalizeCell(value: unknown): SpreadsheetCellData | null {
  if (!isRecord(value)) return null;
  const cell = clone(value) as SpreadsheetCellData;
  if (cell.v !== undefined && cell.v !== null && !isSpreadsheetCellValue(cell.v)) return null;
  if (cell.f !== undefined && cell.f !== null && typeof cell.f !== "string") return null;
  return cell;
}

function isValidRange(value: unknown, rows: number, columns: number): value is SpreadsheetRangeData {
  if (!isRecord(value)) return false;
  const { startRow, startColumn, endRow, endColumn } = value;
  return [startRow, startColumn, endRow, endColumn].every(Number.isSafeInteger)
    && Number(startRow) >= 0 && Number(startColumn) >= 0
    && Number(endRow) >= Number(startRow) && Number(endColumn) >= Number(startColumn)
    && Number(endRow) < rows && Number(endColumn) < columns;
}

function normalizeWorksheet(value: unknown, id: string, fallbackName: string): SpreadsheetWorksheetData | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" && value.name ? value.name : fallbackName;
  const rowCount = boundedCount(value.rowCount, DEFAULT_ROWS, SPREADSHEET_AXES.row.max);
  const columnCount = boundedCount(value.columnCount, DEFAULT_COLUMNS, SPREADSHEET_AXES.column.max);
  const output = { ...createWorksheet(id, name, 0, 0), ...clone(value), id, name, rowCount, columnCount } as SpreadsheetWorksheetData;
  for (const axis of AXES) {
    const { count, data } = SPREADSHEET_AXES[axis];
    const lines = output[data] = isRecord(value[data]) ? clone(value[data]) as SpreadsheetWorksheetData["rowData"] : {};
    // Keep authored IDs, then prefer the deterministic ID so peers that open
    // the same legacy file independently still agree on row identity.
    const existing = new Set(Object.values(lines).map((line) => axisId(line, axis)));
    const used = new Set<string>();
    for (let index = 0; index < output[count]; index++) {
      const current = axisId(lines[index], axis);
      const deterministic = stableId(axis, id, index);
      const lineId = current && !used.has(current)
        ? current
        : !existing.has(deterministic) && !used.has(deterministic) ? deterministic : newId(axis);
      used.add(lineId);
      lines[index] = withAxisId(lines[index], axis, lineId);
    }
  }
  output.cellData = {};
  for (const [rowKey, rowValue] of Object.entries(isRecord(value.cellData) ? value.cellData : {})) {
    const row = Number(rowKey);
    if (!inBounds(row, rowCount) || !isRecord(rowValue)) continue;
    for (const [columnKey, cellValue] of Object.entries(rowValue)) {
      const column = Number(columnKey);
      const cell = normalizeCell(cellValue);
      if (inBounds(column, columnCount) && cell) (output.cellData[row] ??= {})[column] = cell;
    }
  }
  output.mergeData = Array.isArray(value.mergeData)
    ? value.mergeData.filter((range): range is SpreadsheetRangeData => isValidRange(range, rowCount, columnCount)).map(clone)
    : [];
  return output;
}

/* eslint-disable lingui/no-unlocalized-strings -- stored workbook defaults */
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
  for (const [index, id] of sheetOrder.entries()) {
    const sheet = normalizeWorksheet(input.sheets[id], id, `Sheet${index + 1}`);
    if (!sheet) return null;
    sheets[id] = sheet;
  }
  return spreadsheetFile({
    ...clone(input),
    id: typeof input.id === "string" && input.id ? input.id : newId("workbook"),
    name: typeof input.name === "string" && input.name ? input.name : "Spreadsheet",
    appVersion: typeof input.appVersion === "string" ? input.appVersion : "0.25.1",
    locale: typeof input.locale === "string" ? input.locale : "enUS",
    styles: isRecord(input.styles) ? clone(input.styles) as SpreadsheetWorkbookData["styles"] : {},
    sheetOrder,
    sheets,
  });
}
/* eslint-enable lingui/no-unlocalized-strings */

function parseWorkbook(source: string): SpreadsheetWorkbookData {
  const parsed = parseSpreadsheetFile(source);
  if (parsed) return parsed.workbook;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing message; the descriptor is the UI copy
  throw new SpreadsheetDocumentError("Invalid .lattice-sheet document", msg`Invalid .lattice-sheet document`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalize(child)]));
}

export function serializeSpreadsheetFile(workbook: SpreadsheetWorkbookData): string {
  return `${JSON.stringify(canonicalize(spreadsheetFile(workbook)), null, 2)}\n`;
}

// ── Y.Doc layout ─────────────────────────────────────────────────────────────
// Each sheet is split into top-level Y types keyed `spreadsheetSheets:<id>:<part>`:
// `metadata` (name + settings), `rows`/`columns` (stable ID sequences),
// `rowData`/`columnData` (by line ID), `cells` (by `row|column|field`), and
// `merges` (by start cell). Field-level keys let peers edit one cell's value
// and format concurrently.

const partKey = (sheetId: string, part: string) => `${SHEETS_KEY}:${encodeURIComponent(sheetId)}:${part}`;
const sheetMap = <T = unknown>(doc: Y.Doc, sheetId: string, part: string) => doc.getMap<T>(partKey(sheetId, part));
const sheetArray = (doc: Y.Doc, sheetId: string, part: "rows" | "columns") => doc.getArray<string>(partKey(sheetId, part));
const cellKey = (rowId: string, columnId: string) => `${encodeURIComponent(rowId)}|${encodeURIComponent(columnId)}`;
const cellFieldKey = (rowId: string, columnId: string, field: string) => `${cellKey(rowId, columnId)}|${encodeURIComponent(field)}`;
const uniqueOrder = (order: Y.Array<string>) => [...new Set(order.toArray().filter((id) => typeof id === "string"))];

type SheetParts = ReturnType<typeof sheetParts>;

/** Project a worksheet onto the ID-keyed Y.Doc layout. */
function sheetParts(input: SpreadsheetWorksheetData) {
  const sheet = normalizeWorksheet(input, input.id, input.name);
  if (!sheet) {
    const name = input.name;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing message; the descriptor is the UI copy
    throw new SpreadsheetDocumentError(`Invalid worksheet: ${name}`, msg`Invalid worksheet: ${name}`);
  }
  const lineIds = (axis: SpreadsheetAxis) => {
    const lines = sheet[SPREADSHEET_AXES[axis].data];
    const seen = new Set<string>();
    return Array.from({ length: sheet[SPREADSHEET_AXES[axis].count] }, (_, index) => {
      let id = axisId(lines[index], axis);
      if (!id || seen.has(id)) id = newId(axis);
      seen.add(id);
      lines[index] = withAxisId(lines[index], axis, id);
      return id;
    });
  };
  const rows = lineIds("row");
  const columns = lineIds("column");
  const byId = (ids: string[], lines: SpreadsheetWorksheetData["rowData"]): Record<string, unknown> =>
    Object.fromEntries(ids.map((id, index) => [id, clone(lines[index] ?? {})]));
  const cells: Record<string, unknown> = {};
  for (const [row, cellsInRow] of Object.entries(sheet.cellData)) {
    for (const [column, cell] of Object.entries(cellsInRow)) {
      for (const [field, value] of Object.entries(cell)) cells[cellFieldKey(rows[Number(row)], columns[Number(column)], field)] = clone(value);
    }
  }
  const merges: Record<string, unknown> = Object.fromEntries(sheet.mergeData.map(({ startRow, startColumn, endRow, endColumn }) => [
    cellKey(rows[startRow], columns[startColumn]),
    { startRowId: rows[startRow], startColumnId: columns[startColumn], endRowId: rows[endRow], endColumnId: columns[endColumn] } satisfies StableMerge,
  ]));
  const { id, name } = sheet;
  return { id, name, settings: omit(sheet, SHEET_STRUCTURE_KEYS), rows, columns, rowData: byId(rows, sheet.rowData), columnData: byId(columns, sheet.columnData), cells, merges };
}

function syncArray(target: Y.Array<string>, desired: string[]): void {
  const wanted = new Set(desired);
  for (let index = target.length - 1; index >= 0; index--) {
    if (!wanted.has(target.get(index))) target.delete(index, 1);
  }
  if (target.length === 0) {
    if (desired.length > 0) target.insert(0, desired);
    return;
  }
  const current = target.toArray();
  for (let index = 0; index < desired.length; index++) {
    if (current[index] === desired[index]) continue;
    const existing = current.indexOf(desired[index], index + 1);
    if (existing >= 0) {
      target.delete(existing, 1);
      current.splice(existing, 1);
    }
    target.insert(index, [desired[index]]);
    current.splice(index, 0, desired[index]);
  }
  if (target.length > desired.length) target.delete(desired.length, target.length - desired.length);
}

function syncJsonMap(target: Y.Map<unknown>, desired: Record<string, unknown>): void {
  for (const key of target.keys()) if (!(key in desired)) target.delete(key);
  for (const [key, value] of Object.entries(desired)) {
    if (!jsonEqual(target.get(key), value)) target.set(key, clone(value));
  }
}

function changedKeys(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => !jsonEqual(previous[key], next[key]) || (key in previous) !== (key in next));
}

/** Apply the previous→next diff onto `current`, keeping fields a peer changed meanwhile. */
function applyRecordChanges(current: unknown, previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const output = isRecord(current) ? clone(current) : {};
  for (const key of changedKeys(previous, next)) {
    if (key in next) output[key] = clone(next[key]);
    else delete output[key];
  }
  return output;
}

function applyJsonMapChanges(target: Y.Map<unknown>, previous: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of changedKeys(previous, next)) {
    if (!(key in next)) target.delete(key);
    else if (isRecord(previous[key]) && isRecord(next[key])) target.set(key, applyRecordChanges(target.get(key), previous[key], next[key]));
    else target.set(key, clone(next[key]));
  }
}

function firstIndexOf(items: string[], candidates: string[]): number | undefined {
  for (const candidate of candidates) {
    const position = items.indexOf(candidate);
    if (position >= 0) return position;
  }
  return undefined;
}

function applySequenceChanges(target: Y.Array<string>, previous: string[], next: string[]): void {
  const previousIds = new Set(previous);
  const nextIds = new Set(next);
  for (let index = target.length - 1; index >= 0; index--) {
    const id = target.get(index);
    if (previousIds.has(id) && !nextIds.has(id)) target.delete(index, 1);
  }
  for (const [index, id] of next.entries()) {
    const current = target.toArray();
    if (previousIds.has(id) || current.includes(id)) continue;
    // Insert after the nearest earlier neighbor that still exists; failing
    // that (or when it is last), before the nearest later one.
    let insertion = (firstIndexOf(current, next.slice(0, index).reverse()) ?? current.length - 1) + 1;
    if (insertion === current.length) insertion = firstIndexOf(current, next.slice(index + 1)) ?? insertion;
    target.insert(insertion, [id]);
  }

  if (jsonEqual(previous.filter((id) => nextIds.has(id)), next.filter((id) => previousIds.has(id)))) return;
  const desired = next.filter((id) => target.toArray().includes(id));
  for (let index = 1; index < desired.length; index++) {
    const current = target.toArray();
    const currentIndex = current.indexOf(desired[index]);
    if (currentIndex > current.indexOf(desired[index - 1])) continue;
    target.delete(currentIndex, 1);
    target.insert(target.toArray().indexOf(desired[index - 1]) + 1, [desired[index]]);
  }
}

/** Two-way sync to `next`, or with `previous`, a three-way merge that preserves concurrent remote edits. */
function writeSheet(doc: Y.Doc, next: SheetParts, previous?: SheetParts): void {
  const metadata = sheetMap(doc, next.id, "metadata");
  if (previous) {
    if (previous.name !== next.name) metadata.set("name", next.name);
    if (!jsonEqual(previous.settings, next.settings)) metadata.set("settings", applyRecordChanges(metadata.get("settings"), previous.settings, next.settings));
  } else {
    if (metadata.get("name") !== next.name) metadata.set("name", next.name);
    if (!jsonEqual(metadata.get("settings"), next.settings)) metadata.set("settings", next.settings);
  }
  for (const part of ["rows", "columns"] as const) {
    if (previous) applySequenceChanges(sheetArray(doc, next.id, part), previous[part], next[part]);
    else syncArray(sheetArray(doc, next.id, part), next[part]);
  }
  for (const part of ["rowData", "columnData", "cells", "merges"] as const) {
    if (previous) applyJsonMapChanges(sheetMap(doc, next.id, part), previous[part], next[part]);
    else syncJsonMap(sheetMap(doc, next.id, part), next[part]);
  }
}

function sheetOrderOf(workbook: SpreadsheetWorkbookData): string[] {
  const order = workbook.sheetOrder.filter((id) => workbook.sheets[id]);
  if (order.length === 0 || order.length > MAX_SHEETS) {
    throw new SpreadsheetDocumentError(
      // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing message; the descriptor is the UI copy
      "A spreadsheet must contain between 1 and 200 sheets",
      msg`A spreadsheet must contain between 1 and 200 sheets`,
    );
  }
  return order;
}

function initializedMeta(doc: Y.Doc): Y.Map<unknown> {
  const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
  meta.set("formatVersion", LATTICE_SPREADSHEET_VERSION);
  meta.set("initialized", true);
  return meta;
}

const hasStructuredSpreadsheet = (doc: Y.Doc) => doc.getMap<unknown>(SPREADSHEET_META_KEY).get("initialized") === true;

export function seedSpreadsheetDoc(doc: Y.Doc): boolean {
  if (hasStructuredSpreadsheet(doc)) return false;
  reconcileSpreadsheetDoc(doc, parseWorkbook(doc.getText(CONTENT_KEY).toString()), SPREADSHEET_SEED_ORIGIN);
  return true;
}

function sheetFromDoc(doc: Y.Doc, sheetId: string): SpreadsheetWorksheetData {
  const metadata = sheetMap(doc, sheetId, "metadata");
  // eslint-disable-next-line lingui/no-unlocalized-strings -- stored fallback sheet name
  const name = typeof metadata.get("name") === "string" ? String(metadata.get("name")) : "Sheet";
  const settings = metadata.get("settings");
  const ids = { row: uniqueOrder(sheetArray(doc, sheetId, "rows")), column: uniqueOrder(sheetArray(doc, sheetId, "columns")) };
  const index = { row: new Map(ids.row.map((id, position) => [id, position])), column: new Map(ids.column.map((id, position) => [id, position])) };
  const sheet = {
    ...createWorksheet(sheetId, name, 0, 0),
    ...(isRecord(settings) ? clone(settings) : {}),
    id: sheetId,
    name,
    rowCount: ids.row.length,
    columnCount: ids.column.length,
    rowData: {},
    columnData: {},
    cellData: {},
    mergeData: [],
  } as SpreadsheetWorksheetData;
  for (const axis of AXES) {
    const lines = sheet[SPREADSHEET_AXES[axis].data];
    sheetMap(doc, sheetId, SPREADSHEET_AXES[axis].data).forEach((value, id) => {
      const position = index[axis].get(id);
      if (position !== undefined) lines[position] = withAxisId(value, axis, id);
    });
    ids[axis].forEach((id, position) => { lines[position] ??= withAxisId({}, axis, id); });
  }
  sheetMap(doc, sheetId, "cells").forEach((value, key) => {
    const [row, column, field] = key.split("|");
    if (column === undefined || field === undefined) return;
    const rowIndex = index.row.get(decodeURIComponent(row));
    const columnIndex = index.column.get(decodeURIComponent(column));
    if (rowIndex === undefined || columnIndex === undefined) return;
    ((sheet.cellData[rowIndex] ??= {})[columnIndex] ??= {})[decodeURIComponent(field)] = clone(value);
  });
  sheetMap<StableMerge>(doc, sheetId, "merges").forEach((merge) => {
    const [startRow, startColumn, endRow, endColumn] = [index.row.get(merge.startRowId), index.column.get(merge.startColumnId), index.row.get(merge.endRowId), index.column.get(merge.endColumnId)];
    if (startRow !== undefined && startColumn !== undefined && endRow !== undefined && endColumn !== undefined) sheet.mergeData.push({ startRow, startColumn, endRow, endColumn });
  });
  return sheet;
}

export function spreadsheetSnapshotFromDoc(doc: Y.Doc): SpreadsheetWorkbookData {
  if (!hasStructuredSpreadsheet(doc)) return parseWorkbook(doc.getText(CONTENT_KEY).toString());
  const meta = doc.getMap<unknown>(SPREADSHEET_META_KEY);
  const formatVersion = meta.get("formatVersion");
  if (formatVersion !== LATTICE_SPREADSHEET_VERSION || !isRecord(meta.get("workbook"))) {
    const version = String(formatVersion);
    throw new SpreadsheetDocumentError(
      // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing message; the descriptor is the UI copy
      `Unsupported spreadsheet collaboration format: ${version}`,
      msg`Unsupported spreadsheet collaboration format: ${version}`,
    );
  }
  const workbook = clone(meta.get("workbook")) as SpreadsheetWorkbookData;
  workbook.styles = clone(doc.getMap<Record<string, unknown> | null>(STYLES_KEY).toJSON());
  workbook.sheetOrder = uniqueOrder(doc.getArray<string>(SHEET_ORDER_KEY));
  workbook.sheets = {};
  const sheets = doc.getMap<boolean>(SHEETS_KEY);
  for (const sheetId of workbook.sheetOrder) {
    if (sheets.has(sheetId)) workbook.sheets[sheetId] = sheetFromDoc(doc, sheetId);
  }
  if (Object.keys(workbook.sheets).length === 0) {
    throw new SpreadsheetDocumentError(
      // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing message; the descriptor is the UI copy
      "A spreadsheet must contain at least one sheet",
      msg`A spreadsheet must contain at least one sheet`,
    );
  }
  return workbook;
}

export const spreadsheetDocContent = (doc: Y.Doc) => serializeSpreadsheetFile(spreadsheetSnapshotFromDoc(doc));

/** Apply sparse cell changes without walking the rest of a large worksheet. */
export function applySpreadsheetCellChanges(
  doc: Y.Doc,
  sheet: SpreadsheetWorksheetData,
  changes: Array<{ row: number; column: number; previous: SpreadsheetCellData | null; next: SpreadsheetCellData | null }>,
  origin: unknown = SPREADSHEET_LOCAL_ORIGIN,
): boolean {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const change of changes) {
    const rowId = axisId(sheet.rowData[change.row], "row");
    const columnId = axisId(sheet.columnData[change.column], "column");
    if (!rowId || !columnId) return false;
    for (const [field, value] of Object.entries(change.previous ?? {})) previous[cellFieldKey(rowId, columnId, field)] = value;
    for (const [field, value] of Object.entries(change.next ?? {})) next[cellFieldKey(rowId, columnId, field)] = value;
  }
  const cells = sheetMap(doc, sheet.id, "cells");
  doc.transact(() => {
    for (const key of changedKeys(previous, next)) {
      if (key in next) cells.set(key, clone(next[key]));
      else cells.delete(key);
    }
  }, origin);
  return true;
}

/** Apply only local Univer changes, preserving newer remote fields in the Y.Doc. */
export function reconcileSpreadsheetDocChanges(
  doc: Y.Doc,
  previous: SpreadsheetWorkbookData,
  next: SpreadsheetWorkbookData,
  origin: unknown = SPREADSHEET_LOCAL_ORIGIN,
): void {
  if (!hasStructuredSpreadsheet(doc)) reconcileSpreadsheetDoc(doc, previous, origin);
  const order = sheetOrderOf(next);
  doc.transact(() => {
    const meta = initializedMeta(doc);
    const [before, after] = [previous, next].map((workbook) => omit(workbook, WORKBOOK_STRUCTURE_KEYS));
    if (!jsonEqual(before, after)) meta.set("workbook", applyRecordChanges(meta.get("workbook"), before, after));
    applyJsonMapChanges(doc.getMap(STYLES_KEY), previous.styles, next.styles);
    applySequenceChanges(doc.getArray<string>(SHEET_ORDER_KEY), previous.sheetOrder, order);
    const sheets = doc.getMap<boolean>(SHEETS_KEY);
    const previousIds = new Set(previous.sheetOrder);
    for (const id of previousIds) if (!order.includes(id)) sheets.delete(id);
    for (const id of order) {
      if (!previousIds.has(id)) {
        if (sheets.has(id)) continue;
        sheets.set(id, true);
        writeSheet(doc, sheetParts(next.sheets[id]));
      } else if (previous.sheets[id] && sheets.has(id)) {
        writeSheet(doc, sheetParts(next.sheets[id]), sheetParts(previous.sheets[id]));
      }
    }
  }, origin);
}

/** Reconcile a whole Univer snapshot into stable row/column CRDT structures. */
export function reconcileSpreadsheetDoc(
  doc: Y.Doc,
  workbook: SpreadsheetWorkbookData,
  origin: unknown = SPREADSHEET_LOCAL_ORIGIN,
): void {
  const order = sheetOrderOf(workbook);
  doc.transact(() => {
    const meta = initializedMeta(doc);
    const metadata = omit(workbook, WORKBOOK_STRUCTURE_KEYS);
    if (!jsonEqual(meta.get("workbook"), metadata)) meta.set("workbook", metadata);
    syncJsonMap(doc.getMap(STYLES_KEY), workbook.styles ?? {});
    syncArray(doc.getArray<string>(SHEET_ORDER_KEY), order);
    const sheets = doc.getMap<boolean>(SHEETS_KEY);
    for (const id of order) {
      if (!sheets.has(id)) sheets.set(id, true);
      writeSheet(doc, sheetParts(workbook.sheets[id]));
    }
    for (const id of sheets.keys()) if (!order.includes(id)) sheets.delete(id);
  }, origin);
}

export const replaceSpreadsheetDocFromSource = (doc: Y.Doc, source: string, origin: unknown = SPREADSHEET_LOCAL_ORIGIN) =>
  reconcileSpreadsheetDoc(doc, parseWorkbook(source), origin);
