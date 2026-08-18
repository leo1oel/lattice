export const LATTICE_SPREADSHEET_FORMAT = "lattice-spreadsheet" as const;
export const LATTICE_SPREADSHEET_VERSION = 1 as const;
const LATTICE_SPREADSHEET_EXTENSION = ".lattice-sheet" as const;

export type SpreadsheetCellValue = string | number | boolean | null;

/**
 * A deliberately structural subset of Univer's ICellData. Unknown fields are
 * retained so a newer Univer snapshot can round-trip through Lattice without
 * the collaboration layer needing to understand every plugin field.
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

export type SpreadsheetRangeData = {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

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

export type SpreadsheetPresence = {
  path: string;
  sheetId: string;
  activeCell?: string;
  selections: string[];
  pointer?: { row: number; column: number; xRatio: number; yRatio: number };
  editingCell?: string;
  agent?: boolean;
};

export type SpreadsheetPresenceUser = {
  id: string;
  name: string;
  color: string;
};

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
  horizontalAlignment?: "left" | "center" | "right";
  verticalAlignment?: "top" | "middle" | "bottom";
  wrap?: boolean;
};

export type SpreadsheetBatchOperation =
  | { type: "set_values"; sheet?: string; range: string; values: SpreadsheetCellValue[][] }
  | { type: "set_formulas"; sheet?: string; range: string; formulas: string[][] }
  | { type: "clear"; sheet?: string; range: string; include?: Array<"values" | "formulas" | "formats"> }
  | { type: "format_range"; sheet?: string; range: string; format: SpreadsheetSemanticFormat }
  | { type: "insert_rows"; sheet?: string; before: number; count: number }
  | { type: "delete_rows"; sheet?: string; start: number; count: number }
  | { type: "insert_columns"; sheet?: string; before: string; count: number }
  | { type: "delete_columns"; sheet?: string; start: string; count: number }
  | { type: "add_sheet"; name: string; after?: string }
  | { type: "delete_sheet"; sheet: string }
  | { type: "rename_sheet"; sheet: string; name: string };

export type SpreadsheetReadRequest = {
  sheet?: string;
  range?: string;
  include?: Array<"values" | "formulas" | "formats">;
};

export type SpreadsheetBatchUpdateRequest = {
  operations: SpreadsheetBatchOperation[];
};

export function isSpreadsheetPath(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(LATTICE_SPREADSHEET_EXTENSION);
}
