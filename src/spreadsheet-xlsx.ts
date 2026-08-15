import type ExcelJS from "exceljs";
import type {
  SpreadsheetCellData,
  SpreadsheetWorkbookData,
  SpreadsheetWorksheetData,
} from "./spreadsheet-types";

type UniverColor = { rgb?: unknown };
type UniverBorder = { s?: unknown; cl?: UniverColor };
type UniverStyle = Record<string, unknown> & {
  ff?: unknown;
  fs?: unknown;
  it?: unknown;
  bl?: unknown;
  ul?: unknown;
  st?: unknown;
  bg?: UniverColor | null;
  bd?: Record<string, UniverBorder | null> | null;
  cl?: UniverColor | null;
  n?: { pattern?: unknown } | null;
  ht?: unknown;
  vt?: unknown;
  tb?: unknown;
};

const BORDER_STYLE: Record<number, ExcelJS.BorderStyle | undefined> = {
  1: "thin",
  2: "hair",
  3: "dotted",
  4: "dashed",
  5: "dashDot",
  6: "dashDotDot",
  7: "double",
  8: "medium",
  9: "mediumDashed",
  10: "mediumDashDot",
  11: "mediumDashDotDot",
  12: "slantDashDot",
  13: "thick",
};

function resolveStyle(
  style: unknown,
  styles: SpreadsheetWorkbookData["styles"],
): UniverStyle | undefined {
  if (typeof style === "string") return (styles[style] ?? undefined) as UniverStyle | undefined;
  if (style && typeof style === "object") return style as UniverStyle;
  return undefined;
}

function color(value: unknown): Partial<ExcelJS.Color> | undefined {
  const rgb = typeof value === "object" && value !== null && "rgb" in value
    ? (value as UniverColor).rgb
    : value;
  if (typeof rgb !== "string") return undefined;
  const hex = rgb.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex;
    return { argb: expanded.length === 8 ? expanded.toUpperCase() : `FF${expanded.toUpperCase()}` };
  }
  const channels = rgb.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?))?\s*\)$/i);
  if (!channels) return undefined;
  const toHex = (channel: number) => Math.max(0, Math.min(255, Math.round(channel)))
    .toString(16).padStart(2, "0").toUpperCase();
  const alpha = channels[4] === undefined || channels[4] === ""
    ? 255
    : Number(channels[4]) * 255;
  return {
    argb: `${toHex(alpha)}${toHex(Number(channels[1]))}${toHex(Number(channels[2]))}${toHex(Number(channels[3]))}`,
  };
}

function decorationEnabled(value: unknown): boolean {
  return value === 1 || (typeof value === "object" && value !== null && (value as { s?: unknown }).s === 1);
}

function excelBorder(value: UniverBorder | null | undefined): Partial<ExcelJS.Border> | undefined {
  if (!value || typeof value.s !== "number") return undefined;
  const style = BORDER_STYLE[value.s];
  if (!style) return undefined;
  const borderColor = color(value.cl);
  return { style, ...(borderColor ? { color: borderColor } : {}) };
}

function applyStyle(cell: ExcelJS.Cell, style: UniverStyle): void {
  const fontColor = color(style.cl);
  const font: Partial<ExcelJS.Font> = {
    ...(typeof style.ff === "string" ? { name: style.ff } : {}),
    ...(typeof style.fs === "number" ? { size: style.fs } : {}),
    ...(style.bl === 1 ? { bold: true } : {}),
    ...(style.it === 1 ? { italic: true } : {}),
    ...(decorationEnabled(style.ul) ? { underline: true } : {}),
    ...(decorationEnabled(style.st) ? { strike: true } : {}),
    ...(fontColor ? { color: fontColor } : {}),
  };
  if (Object.keys(font).length > 0) cell.font = font as ExcelJS.Font;

  const background = color(style.bg);
  if (background) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: background };
  }

  if (style.bd) {
    const border: Partial<ExcelJS.Borders> = {
      top: excelBorder(style.bd.t),
      right: excelBorder(style.bd.r),
      bottom: excelBorder(style.bd.b),
      left: excelBorder(style.bd.l),
      diagonal: excelBorder(style.bd.tl_br ?? style.bd.bl_tr),
    };
    for (const key of Object.keys(border) as Array<keyof ExcelJS.Borders>) {
      if (!border[key]) delete border[key];
    }
    if (Object.keys(border).length > 0) cell.border = border;
  }

  const horizontal = style.ht === 1 ? "left" : style.ht === 2 ? "center" : style.ht === 3 ? "right" : undefined;
  const vertical = style.vt === 1 ? "top" : style.vt === 2 ? "middle" : style.vt === 3 ? "bottom" : undefined;
  const alignment: Partial<ExcelJS.Alignment> = {
    ...(horizontal ? { horizontal } : {}),
    ...(vertical ? { vertical } : {}),
    ...(style.tb === 3 ? { wrapText: true } : {}),
    ...(style.tb === 2 ? { shrinkToFit: true } : {}),
  };
  if (Object.keys(alignment).length > 0) cell.alignment = alignment;
  if (typeof style.n?.pattern === "string") cell.numFmt = style.n.pattern;
}

function composedCellStyle(
  workbook: SpreadsheetWorkbookData,
  sheet: SpreadsheetWorksheetData,
  rowIndex: number,
  columnIndex: number,
  cell: SpreadsheetCellData,
): UniverStyle {
  return Object.assign(
    {},
    resolveStyle(workbook.defaultStyle, workbook.styles),
    resolveStyle(sheet.defaultStyle, workbook.styles),
    resolveStyle(sheet.columnData[columnIndex]?.s, workbook.styles),
    resolveStyle(sheet.rowData[rowIndex]?.s, workbook.styles),
    resolveStyle(cell.s, workbook.styles),
  ) as UniverStyle;
}

function populateSheet(
  target: ExcelJS.Worksheet,
  workbook: SpreadsheetWorkbookData,
  source: SpreadsheetWorksheetData,
): void {
  target.properties.defaultRowHeight = source.defaultRowHeight * 0.75;
  target.properties.defaultColWidth = Math.max(1, (source.defaultColumnWidth - 5) / 7);
  target.views = [{
    state: source.freeze.xSplit || source.freeze.ySplit ? "frozen" : "normal",
    xSplit: source.freeze.xSplit,
    ySplit: source.freeze.ySplit,
    topLeftCell: `${columnName(source.freeze.startColumn)}${source.freeze.startRow + 1}`,
    showGridLines: source.showGridlines !== 0,
    rightToLeft: source.rightToLeft === 1,
  }];

  for (const [rowKey, rowData] of Object.entries(source.rowData)) {
    const row = target.getRow(Number(rowKey) + 1);
    const height = typeof rowData.h === "number" ? rowData.h : rowData.ah;
    if (typeof height === "number") row.height = height * 0.75;
    row.hidden = rowData.hd === 1;
  }
  for (const [columnKey, columnData] of Object.entries(source.columnData)) {
    const column = target.getColumn(Number(columnKey) + 1);
    if (typeof columnData.w === "number") column.width = Math.max(1, (columnData.w - 5) / 7);
    column.hidden = columnData.hd === 1;
  }

  for (const [rowKey, columns] of Object.entries(source.cellData)) {
    const rowIndex = Number(rowKey);
    for (const [columnKey, sourceCell] of Object.entries(columns)) {
      const columnIndex = Number(columnKey);
      const cell = target.getCell(rowIndex + 1, columnIndex + 1);
      if (typeof sourceCell.f === "string" && sourceCell.f.length > 0) {
        cell.value = {
          formula: sourceCell.f.replace(/^=/, ""),
          ...(sourceCell.v === undefined || sourceCell.v === null ? {} : { result: sourceCell.v }),
        };
      } else {
        cell.value = sourceCell.v ?? null;
      }
      applyStyle(cell, composedCellStyle(workbook, source, rowIndex, columnIndex, sourceCell));
    }
  }

  for (const merge of source.mergeData) {
    target.mergeCells(
      merge.startRow + 1,
      merge.startColumn + 1,
      merge.endRow + 1,
      merge.endColumn + 1,
    );
  }
}

function columnName(index: number): string {
  let value = Math.max(0, index) + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

/** Convert Lattice's collaborative workbook snapshot into a portable Excel workbook. */
export function populateExcelWorkbook(
  target: ExcelJS.Workbook,
  source: SpreadsheetWorkbookData,
): void {
  target.creator = "Lattice";
  target.title = source.name;
  for (const sheetId of source.sheetOrder) {
    const sheet = source.sheets[sheetId];
    if (!sheet) continue;
    const targetSheet = target.addWorksheet(sheet.name, {
      state: sheet.hidden === 1 ? "hidden" : "visible",
      properties: {
        tabColor: color(sheet.tabColor),
      },
    });
    populateSheet(targetSheet, source, sheet);
  }
}

/** ExcelJS stays out of the eager app graph; it is loaded only when the user exports. */
export async function spreadsheetWorkbookToXlsx(
  source: SpreadsheetWorkbookData,
): Promise<Uint8Array> {
  const { default: ExcelJSModule } = await import("exceljs");
  const target = new ExcelJSModule.Workbook();
  populateExcelWorkbook(target, source);
  const buffer = await target.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
