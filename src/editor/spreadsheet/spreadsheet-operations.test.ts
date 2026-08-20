import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applySpreadsheetBatch } from "./spreadsheet-operations";
import { seedSpreadsheetDoc, spreadsheetSnapshotFromDoc } from "./spreadsheet-yjs";

function firstSheetCells(doc: Y.Doc) {
  const workbook = spreadsheetSnapshotFromDoc(doc);
  return workbook.sheets[workbook.sheetOrder[0]].cellData;
}

describe("spreadsheet set_values typing", () => {
  it("stores quoted plain numbers as numeric cells", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    applySpreadsheetBatch(doc, {
      operations: [{
        type: "set_values",
        range: "A1:F1",
        values: [["123", " 12.8 ", "-0.764", "+2", "1e3", 42]],
      }],
    });
    const row = firstSheetCells(doc)[0];
    expect(row[0]).toMatchObject({ v: 123, t: 2 });
    expect(row[1]).toMatchObject({ v: 12.8, t: 2 });
    expect(row[2]).toMatchObject({ v: -0.764, t: 2 });
    expect(row[3]).toMatchObject({ v: 2, t: 2 });
    expect(row[4]).toMatchObject({ v: 1000, t: 2 });
    expect(row[5]).toMatchObject({ v: 42, t: 2 });
  });

  it("keeps identifiers, grouped numbers, and percents as text", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    applySpreadsheetBatch(doc, {
      operations: [{
        type: "set_values",
        range: "A1:F1",
        values: [["0123", "1,234", "20%", "1.2.3", "9007199254740993", "result"]],
      }],
    });
    const row = firstSheetCells(doc)[0];
    expect(row[0]).toMatchObject({ v: "0123", t: 1 });
    expect(row[1]).toMatchObject({ v: "1,234", t: 1 });
    expect(row[2]).toMatchObject({ v: "20%", t: 1 });
    expect(row[3]).toMatchObject({ v: "1.2.3", t: 1 });
    expect(row[4]).toMatchObject({ v: "9007199254740993", t: 1 });
    expect(row[5]).toMatchObject({ v: "result", t: 1 });
  });

  it("treats a leading apostrophe as Excel force-string text", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    applySpreadsheetBatch(doc, {
      operations: [{
        type: "set_values",
        range: "A1:B1",
        values: [["'02115", "'123"]],
      }],
    });
    const row = firstSheetCells(doc)[0];
    expect(row[0]).toMatchObject({ v: "02115", t: 4 });
    expect(row[1]).toMatchObject({ v: "123", t: 4 });
  });
});
