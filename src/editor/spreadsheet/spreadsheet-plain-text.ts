import { isRecord } from "../../app-utils";
import type { SpreadsheetWorkbookData } from "./spreadsheet-types";

/**
 * Univer marks the structure of rich text with C0 control characters: a
 * link's range is \x1f…\x1e, a block \b, a table \x1a…\x0f. A plain cell
 * value holding one, or DEL, draws it as a missing-glyph box after the text,
 * and the cell editor reads it as structure: with \x1c the formula bar opens
 * empty, and with \x1c, \x1d, \x0e or \x0f what is typed stays hidden until
 * editing ends. Tab and line breaks are text and stay.
 *
 * AppKit's function-key characters (U+F700–U+F8FF, ← is U+F702) are never
 * text either: an input method that commits one leaves the same box, and the
 * page's view drops them as they are typed (`lattice-webview`'s
 * `native.rs`), so a value saved before that still loses them here.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what this removes
const RESERVED_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uf700-\uf8ff]/g;

export function plainCellText(text: string): string {
  return text.replace(RESERVED_CONTROLS, "");
}

/** Remove the reserved characters from every plain string value of a row → column → cell record, in place. */
export function stripReservedControls(cellValue: unknown): void {
  if (!isRecord(cellValue)) return;
  for (const row of Object.values(cellValue)) {
    if (!isRecord(row)) continue;
    for (const cell of Object.values(row)) {
      if (isRecord(cell) && typeof cell.v === "string") cell.v = plainCellText(cell.v);
    }
  }
}

/** The workbook as the editor shows it: its plain values without reserved characters, in place. */
export function withPlainCellText(workbook: SpreadsheetWorkbookData): SpreadsheetWorkbookData {
  for (const sheetId of workbook.sheetOrder) stripReservedControls(workbook.sheets[sheetId]?.cellData);
  return workbook;
}
