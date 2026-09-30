export const LATTICE_SPREADSHEET_FORMAT = "lattice-spreadsheet" as const;
export const LATTICE_SPREADSHEET_VERSION = 1 as const;
const LATTICE_SPREADSHEET_EXTENSION = ".lattice-sheet" as const;

export type SpreadsheetCellValue = string | number | boolean | null;

/**
 * A deliberately structural subset of Univer's ICellData. Unknown fields are
 * retained so a newer Univer snapshot can round-trip through Lattice without
 * the Y.Doc model needing to understand every plugin field.
 */
export type SpreadsheetCellData = {
  v?: SpreadsheetCellValue | null;
  f?: string | null;
  t?: number | null;
  s?: string | Record<string, unknown> | null;
  p?: Record<string, unknown> | null;
  custom?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type SpreadsheetRangeData = { startRow: number; startColumn: number; endRow: number; endColumn: number };

export type SpreadsheetWorksheetData = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: Record<number, Record<number, SpreadsheetCellData>>;
  rowData: Record<number, Record<string, unknown>>;
  columnData: Record<number, Record<string, unknown>>;
  mergeData: SpreadsheetRangeData[];
  tabColor: string;
  hidden: number;
  freeze: { xSplit: number; ySplit: number; startRow: number; startColumn: number };
  zoomRatio: number;
  scrollTop: number;
  scrollLeft: number;
  defaultColumnWidth: number;
  defaultRowHeight: number;
  rowHeader: { width: number; hidden?: number };
  columnHeader: { height: number; hidden?: number };
  showGridlines: number;
  rightToLeft: number;
  [key: string]: unknown;
};

export type SpreadsheetWorkbookData = {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, Record<string, unknown> | null>;
  sheetOrder: string[];
  sheets: Record<string, SpreadsheetWorksheetData>;
  defaultStyle?: string | Record<string, unknown> | null;
  resources?: unknown;
  custom?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type LatticeSpreadsheetFile = {
  format: typeof LATTICE_SPREADSHEET_FORMAT;
  version: typeof LATTICE_SPREADSHEET_VERSION;
  workbook: SpreadsheetWorkbookData;
};

/** Univer's `ht` / `vt` style codes are these positions plus one. */
export const HORIZONTAL_ALIGNMENTS = ["left", "center", "right"] as const;
export const VERTICAL_ALIGNMENTS = ["top", "middle", "bottom"] as const;

export type SpreadsheetSemanticFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  backgroundColor?: string;
  numberFormat?: string;
  horizontalAlignment?: (typeof HORIZONTAL_ALIGNMENTS)[number];
  verticalAlignment?: (typeof VERTICAL_ALIGNMENTS)[number];
  wrap?: boolean;
};

export const SPREADSHEET_READ_FIELDS = ["values", "formulas", "formats"] as const;
type SpreadsheetReadField = (typeof SPREADSHEET_READ_FIELDS)[number];

export type SpreadsheetBatchOperation =
  | { type: "set_values"; sheet?: string; range: string; values: SpreadsheetCellValue[][] }
  | { type: "set_formulas"; sheet?: string; range: string; formulas: string[][] }
  | { type: "clear"; sheet?: string; range: string; include?: SpreadsheetReadField[] }
  | { type: "format_range"; sheet?: string; range: string; format: SpreadsheetSemanticFormat }
  | { type: "insert_rows"; sheet?: string; before: number; count: number }
  | { type: "delete_rows"; sheet?: string; start: number; count: number }
  | { type: "insert_columns"; sheet?: string; before: string; count: number }
  | { type: "delete_columns"; sheet?: string; start: string; count: number }
  | { type: "add_sheet"; name: string; after?: string }
  | { type: "delete_sheet"; sheet: string }
  | { type: "rename_sheet"; sheet: string; name: string };

export type SpreadsheetReadRequest = { sheet?: string; range?: string; include?: SpreadsheetReadField[] };
export type SpreadsheetBatchUpdateRequest = { operations: SpreadsheetBatchOperation[] };

export function isSpreadsheetPath(path: string): boolean {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- locale tag for case folding
  return path.toLocaleLowerCase("en-US").endsWith(LATTICE_SPREADSHEET_EXTENSION);
}

/**
 * Worksheet fields per axis. Every row and column carries a stable ID in
 * `custom[idField]`, so CRDT cells stay attached across insertions and deletions.
 */
/* eslint-disable lingui/no-unlocalized-strings -- worksheet field names */
export const SPREADSHEET_AXES = {
  row: { idField: "__latticeRowId", count: "rowCount", data: "rowData", start: "startRow", end: "endRow", max: 1_048_576 },
  column: { idField: "__latticeColumnId", count: "columnCount", data: "columnData", start: "startColumn", end: "endColumn", max: 16_384 },
} as const;
/* eslint-enable lingui/no-unlocalized-strings */
export type SpreadsheetAxis = keyof typeof SPREADSHEET_AXES;

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A safe integer in [0, count). */
export function inBounds(index: unknown, count: number): boolean {
  return Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < count;
}

export function isSpreadsheetCellValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
