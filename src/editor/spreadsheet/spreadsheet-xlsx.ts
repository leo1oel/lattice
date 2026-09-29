import type ExcelJS from "exceljs";
import { columnLabel } from "./spreadsheet-operations";
import {
  HORIZONTAL_ALIGNMENTS,
  VERTICAL_ALIGNMENTS,
  isRecord,
  type SpreadsheetCellData,
  type SpreadsheetWorkbookData,
  type SpreadsheetWorksheetData,
} from "./spreadsheet-types";

type UniverColor = { rgb?: unknown };
type UniverBorder = { s?: unknown; cl?: UniverColor };
type UniverStyle = Record<string, unknown> & {
  bg?: UniverColor | null;
  bd?: Record<string, UniverBorder | null> | null;
  cl?: UniverColor | null;
  n?: { pattern?: unknown } | null;
};

// Univer BorderStyleTypes, indexed by their numeric value.
const BORDER_STYLES: ReadonlyArray<ExcelJS.BorderStyle | undefined> = [
  undefined, "thin", "hair", "dotted", "dashed", "dashDot", "dashDotDot", "double",
  "medium", "mediumDashed", "mediumDashDot", "mediumDashDotDot", "slantDashDot", "thick",
];

function resolveStyle(style: unknown, styles: SpreadsheetWorkbookData["styles"]): UniverStyle | undefined {
  if (typeof style === "string") return (styles[style] ?? undefined) as UniverStyle | undefined;
  return isRecord(style) ? style as UniverStyle : undefined;
}

function color(value: unknown): Partial<ExcelJS.Color> | undefined {
  const rgb = isRecord(value) && "rgb" in value ? value.rgb : value;
  if (typeof rgb !== "string") return undefined;
  const hex = rgb.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- ARGB hex value
    return { argb: expanded.length === 8 ? expanded.toUpperCase() : `FF${expanded.toUpperCase()}` };
  }
  const channels = rgb.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?))?\s*\)$/i);
  if (!channels) return undefined;
  const toHex = (channel: number) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0").toUpperCase();
  const alpha = channels[4] === undefined || channels[4] === "" ? 255 : Number(channels[4]) * 255;
  return { argb: [alpha, ...channels.slice(1, 4).map(Number)].map(toHex).join("") };
}

function decorationEnabled(value: unknown): boolean {
  return value === 1 || (isRecord(value) && value.s === 1);
}

function excelBorder(value: UniverBorder | null | undefined): Partial<ExcelJS.Border> | undefined {
  const style = typeof value?.s === "number" ? BORDER_STYLES[value.s] : undefined;
  if (!style) return undefined;
  const borderColor = color(value?.cl);
  return { style, ...(borderColor ? { color: borderColor } : {}) };
}

/** Keep only the entries whose value is present, so ExcelJS writes no empty style blocks. */
function present<T extends object>(value: T): Partial<T> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== false);
  return entries.length > 0 ? Object.fromEntries(entries) as Partial<T> : undefined;
}

function applyStyle(cell: ExcelJS.Cell, style: UniverStyle): void {
  const font = present({
    name: typeof style.ff === "string" ? style.ff : undefined,
    size: typeof style.fs === "number" ? style.fs : undefined,
    bold: style.bl === 1,
    italic: style.it === 1,
    underline: decorationEnabled(style.ul),
    strike: decorationEnabled(style.st),
    color: color(style.cl),
  });
  if (font) cell.font = font as ExcelJS.Font;
  const background = color(style.bg);
  if (background) cell.fill = { type: "pattern", pattern: "solid", fgColor: background };
  const border = style.bd && present({
    top: excelBorder(style.bd.t),
    right: excelBorder(style.bd.r),
    bottom: excelBorder(style.bd.b),
    left: excelBorder(style.bd.l),
    diagonal: excelBorder(style.bd.tl_br ?? style.bd.bl_tr),
  });
  if (border) cell.border = border;
  const alignment = present({
    horizontal: typeof style.ht === "number" ? HORIZONTAL_ALIGNMENTS[style.ht - 1] : undefined,
    vertical: typeof style.vt === "number" ? VERTICAL_ALIGNMENTS[style.vt - 1] : undefined,
    wrapText: style.tb === 3,
    shrinkToFit: style.tb === 2,
  });
  if (alignment) cell.alignment = alignment;
  if (typeof style.n?.pattern === "string") cell.numFmt = style.n.pattern;
}

function populateSheet(target: ExcelJS.Worksheet, workbook: SpreadsheetWorkbookData, source: SpreadsheetWorksheetData): void {
  const width = (pixels: number) => Math.max(1, (pixels - 5) / 7);
  target.properties.defaultRowHeight = source.defaultRowHeight * 0.75;
  target.properties.defaultColWidth = width(source.defaultColumnWidth);
  target.views = [{
    state: source.freeze.xSplit || source.freeze.ySplit ? "frozen" : "normal",
    xSplit: source.freeze.xSplit,
    ySplit: source.freeze.ySplit,
    topLeftCell: `${columnLabel(source.freeze.startColumn)}${source.freeze.startRow + 1}`,
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
    if (typeof columnData.w === "number") column.width = width(columnData.w);
    column.hidden = columnData.hd === 1;
  }
  const styleOf = (rowIndex: number, columnIndex: number, cell: SpreadsheetCellData) => Object.assign(
    {},
    ...[workbook.defaultStyle, source.defaultStyle, source.columnData[columnIndex]?.s, source.rowData[rowIndex]?.s, cell.s]
      .map((style) => resolveStyle(style, workbook.styles)),
  ) as UniverStyle;
  for (const [rowKey, columns] of Object.entries(source.cellData)) {
    for (const [columnKey, sourceCell] of Object.entries(columns)) {
      const cell = target.getCell(Number(rowKey) + 1, Number(columnKey) + 1);
      cell.value = typeof sourceCell.f === "string" && sourceCell.f.length > 0
        ? { formula: sourceCell.f.replace(/^=/, ""), ...(sourceCell.v === undefined || sourceCell.v === null ? {} : { result: sourceCell.v }) }
        : sourceCell.v ?? null;
      applyStyle(cell, styleOf(Number(rowKey), Number(columnKey), sourceCell));
    }
  }
  for (const merge of source.mergeData) {
    target.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1);
  }
}

/** Convert Lattice's collaborative workbook snapshot into a portable Excel workbook. ExcelJS stays out of the eager app graph. */
export async function spreadsheetWorkbookToXlsx(source: SpreadsheetWorkbookData): Promise<Uint8Array> {
  const { default: ExcelJSModule } = await import("exceljs");
  const target = new ExcelJSModule.Workbook();
  target.creator = "Lattice";
  target.title = source.name;
  for (const sheet of source.sheetOrder.map((id) => source.sheets[id]).filter(Boolean)) {
    const worksheet = target.addWorksheet(sheet.name, {
      state: sheet.hidden === 1 ? "hidden" : "visible",
      properties: { tabColor: color(sheet.tabColor) },
    });
    populateSheet(worksheet, source, sheet);
  }
  return new Uint8Array(await target.xlsx.writeBuffer());
}
