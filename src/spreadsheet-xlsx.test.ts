import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createDefaultSpreadsheet } from "./spreadsheet-yjs";
import { spreadsheetWorkbookToXlsx } from "./spreadsheet-xlsx";

describe("spreadsheetWorkbookToXlsx", () => {
  it("writes values, formulas, formatting, dimensions, and merged ranges", async () => {
    const source = createDefaultSpreadsheet("Results").workbook;
    const sheet = source.sheets[source.sheetOrder[0]];
    source.styles.heading = {
      ff: "Arial",
      fs: 14,
      bl: 1,
      cl: { rgb: "#112233" },
      bg: { rgb: "#E5E7EB" },
      ht: 2,
      bd: { b: { s: 1, cl: { rgb: "#445566" } } },
    };
    sheet.cellData = {
      0: { 0: { v: "Revenue", s: "heading" } },
      1: {
        0: { v: 12.5, s: { n: { pattern: "$#,##0.00" } } },
        1: { v: 25, f: "=A2*2" },
      },
    };
    sheet.rowData = { 0: { h: 32 } };
    sheet.columnData = { 0: { w: 145 } };
    sheet.mergeData = [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }];

    const bytes = await spreadsheetWorkbookToXlsx(source);
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x50, 0x4b]);

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const exported = reloaded.getWorksheet("Sheet1");
    expect(exported).toBeDefined();
    expect(exported?.getCell("A1").value).toBe("Revenue");
    expect(exported?.getCell("A1").font).toMatchObject({ name: "Arial", size: 14, bold: true });
    expect(exported?.getCell("A1").font.color).toEqual({ argb: "FF112233" });
    expect(exported?.getCell("A1").fill).toMatchObject({ pattern: "solid", fgColor: { argb: "FFE5E7EB" } });
    expect(exported?.getCell("A1").alignment.horizontal).toBe("center");
    expect(exported?.getCell("A2").numFmt).toBe("$#,##0.00");
    expect(exported?.getCell("B2").value).toEqual({ formula: "A2*2", result: 25 });
    expect(exported?.getRow(1).height).toBe(24);
    expect(exported?.getColumn(1).width).toBe(20);
    expect(exported?.getCell("B1").isMerged).toBe(true);
  });
});
