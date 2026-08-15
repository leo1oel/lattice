import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applySpreadsheetBatch,
  parseA1Range,
  readSpreadsheet,
} from "./spreadsheet-operations";
import {
  createDefaultSpreadsheet,
  parseSpreadsheetFile,
  reconcileSpreadsheetDoc,
  reconcileSpreadsheetDocChanges,
  seedSpreadsheetDoc,
  serializeSpreadsheetFile,
  spreadsheetDocContent,
  spreadsheetSnapshotFromDoc,
} from "./spreadsheet-yjs";

function syncedDocs(): [Y.Doc, Y.Doc] {
  const first = new Y.Doc();
  seedSpreadsheetDoc(first);
  const second = new Y.Doc();
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  return [first, second];
}

function exchange(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right));
  const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left));
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

function latticeRowId(data: Record<string, unknown>): unknown {
  return (data.custom as Record<string, unknown> | undefined)?.__latticeRowId;
}

describe("spreadsheet Yjs model", () => {
  it("round-trips the native file format and structured document", () => {
    const file = createDefaultSpreadsheet("Experiment data");
    file.workbook.sheets[file.workbook.sheetOrder[0]].cellData[0] = {
      0: { v: "Model", t: 1, s: { bl: 1 } },
      1: { v: "Accuracy", t: 1 },
    };
    const parsed = parseSpreadsheetFile(serializeSpreadsheetFile(file.workbook));
    expect(parsed?.workbook.name).toBe("Experiment data");

    const doc = new Y.Doc();
    reconcileSpreadsheetDoc(doc, parsed!.workbook);
    const restored = spreadsheetSnapshotFromDoc(doc);
    expect(restored.sheets[restored.sheetOrder[0]].cellData[0][0]).toMatchObject({ v: "Model", s: { bl: 1 } });
    expect(parseSpreadsheetFile(spreadsheetDocContent(doc))?.workbook.sheetOrder).toEqual(restored.sheetOrder);
  });

  it("merges concurrent edits to different cells", () => {
    const [left, right] = syncedDocs();
    applySpreadsheetBatch(left, { operations: [{ type: "set_values", range: "A1", values: [["left"]] }] });
    applySpreadsheetBatch(right, { operations: [{ type: "set_values", range: "B1", values: [["right"]] }] });

    exchange(left, right);

    expect(readSpreadsheet(left, { range: "A1:B1" }).values).toEqual([["left", "right"]]);
    expect(spreadsheetDocContent(left)).toBe(spreadsheetDocContent(right));
  });

  it("keeps first edits when two peers concurrently initialize an empty imported spreadsheet", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    seedSpreadsheetDoc(left);
    seedSpreadsheetDoc(right);
    applySpreadsheetBatch(left, { operations: [{ type: "set_values", range: "A1", values: [["left"]] }] });
    applySpreadsheetBatch(right, { operations: [{ type: "set_values", range: "B1", values: [["right"]] }] });

    exchange(left, right);

    expect(spreadsheetSnapshotFromDoc(left).sheetOrder).toEqual(["sheet_default"]);
    expect(readSpreadsheet(left, { range: "A1:B1" }).values).toEqual([["left", "right"]]);
    expect(spreadsheetDocContent(left)).toBe(spreadsheetDocContent(right));
  });

  it("merges concurrent value and format fields on the same new cell", () => {
    const [left, right] = syncedDocs();
    applySpreadsheetBatch(left, { operations: [{ type: "set_values", range: "C3", values: [[42]] }] });
    applySpreadsheetBatch(right, { operations: [{ type: "format_range", range: "C3", format: { bold: true, backgroundColor: "#ffeeaa" } }] });

    exchange(left, right);

    expect(readSpreadsheet(left, { range: "C3", include: ["values", "formats"] })).toMatchObject({
      values: [[42]],
      formats: [[{ bl: 1, bg: { rgb: "#ffeeaa" } }]],
    });
    expect(spreadsheetDocContent(left)).toBe(spreadsheetDocContent(right));
  });

  it("rebases local snapshot changes over newer remote cells and row insertions", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const previous = spreadsheetSnapshotFromDoc(doc);
    const local = structuredClone(previous);
    const localSheet = local.sheets[local.sheetOrder[0]];
    localSheet.cellData[0] = { 0: { v: "local", t: 1 } };

    applySpreadsheetBatch(doc, { operations: [
      { type: "insert_rows", before: 2, count: 1 },
      { type: "set_values", range: "B2", values: [["remote"]] },
    ] });
    reconcileSpreadsheetDocChanges(doc, previous, local);

    expect(readSpreadsheet(doc, { range: "A1:B2", include: ["values"] }).values).toEqual([
      ["local", null],
      [null, "remote"],
    ]);
  });

  it("applies a whole Agent batch as one transaction", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (transaction) => {
      if (transaction.changed.size > 0) origins.push(transaction.origin);
    });

    applySpreadsheetBatch(doc, {
      operations: [
        { type: "set_values", range: "A1:B2", values: [[1, 2], [3, 4]] },
        { type: "set_formulas", range: "C1:C2", formulas: [["=SUM(A1:B1)"], ["=SUM(A2:B2)"]] },
        { type: "format_range", range: "A1:C1", format: { bold: true } },
      ],
    });

    expect(origins).toEqual(["spreadsheet-agent"]);
    expect(readSpreadsheet(doc, { range: "A1:C2" })).toMatchObject({
      values: [[1, 2, null], [3, 4, null]],
      formulas: [[null, null, "=SUM(A1:B1)"], [null, null, "=SUM(A2:B2)"]],
    });
  });

  it("replaces incompatible rich-text and formula fields when Agent values change", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const workbook = spreadsheetSnapshotFromDoc(doc);
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    sheet.cellData[0] = {
      0: { f: "=1+1", v: 2, p: { body: { dataStream: "old" } }, si: "shared", ref: "A1:A2", xf: "spill" },
      1: { v: "old", t: 1, p: { body: { dataStream: "old" } }, ref: "B1:B2", xf: "spill" },
    };
    reconcileSpreadsheetDoc(doc, workbook);

    applySpreadsheetBatch(doc, { operations: [
      { type: "set_values", range: "A1", values: [["plain"]] },
      { type: "set_formulas", range: "B1", formulas: [["=A1"]] },
    ] });

    const cells = spreadsheetSnapshotFromDoc(doc).sheets[sheet.id].cellData[0];
    expect(cells[0]).toMatchObject({ v: "plain", t: 1 });
    expect(cells[0]).not.toHaveProperty("f");
    expect(cells[0]).not.toHaveProperty("p");
    expect(cells[0]).not.toHaveProperty("ref");
    expect(cells[1]).toMatchObject({ f: "=A1" });
    expect(cells[1]).not.toHaveProperty("v");
    expect(cells[1]).not.toHaveProperty("p");
    expect(cells[1]).not.toHaveProperty("xf");
  });

  it("preserves stable cells when rows and columns are inserted", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    applySpreadsheetBatch(doc, { operations: [{ type: "set_values", range: "B2", values: [["anchor"]] }] });
    applySpreadsheetBatch(doc, { operations: [
      { type: "insert_rows", before: 2, count: 2 },
      { type: "insert_columns", before: "B", count: 1 },
    ] });
    expect(readSpreadsheet(doc, { range: "C4" }).values).toEqual([["anchor"]]);
  });

  it("assigns a new stable ID to a blank Univer insertion without replacing shifted row IDs", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    applySpreadsheetBatch(doc, { operations: [{ type: "set_values", range: "B2", values: [["anchor"]] }] });
    const workbook = spreadsheetSnapshotFromDoc(doc);
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    const anchorRowId = latticeRowId(sheet.rowData[1]);
    sheet.rowData = Object.fromEntries(
      Object.entries(sheet.rowData).map(([index, data]) => [Number(index) >= 1 ? Number(index) + 1 : Number(index), data]),
    );
    sheet.cellData = Object.fromEntries(
      Object.entries(sheet.cellData).map(([index, data]) => [Number(index) >= 1 ? Number(index) + 1 : Number(index), data]),
    );
    sheet.rowData[1] = {};
    sheet.rowCount += 1;

    reconcileSpreadsheetDoc(doc, workbook);

    const restored = spreadsheetSnapshotFromDoc(doc).sheets[sheet.id];
    expect(latticeRowId(restored.rowData[2])).toBe(anchorRowId);
    expect(latticeRowId(restored.rowData[1])).not.toBe(anchorRowId);
    expect(readSpreadsheet(doc, { range: "B3", include: ["values"] }).values).toEqual([["anchor"]]);
  });

  it("round-trips structural Univer snapshots without losing formulas, styles, merges, or sheet metadata", () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const workbook = spreadsheetSnapshotFromDoc(doc);
    const first = workbook.sheets[workbook.sheetOrder[0]];
    first.name = "Results";
    first.cellData[0] = {
      0: { v: 4, t: 2, s: { bg: { rgb: "#ffeeaa" } } },
      1: { f: "=A1*2", s: "formula-style" },
    };
    first.mergeData = [{ startRow: 2, startColumn: 0, endRow: 2, endColumn: 2 }];
    first.freeze = { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 };
    workbook.styles["formula-style"] = { bl: 1, cl: { rgb: "#112233" } };
    const secondFile = createDefaultSpreadsheet("Second");
    const second = secondFile.workbook.sheets[secondFile.workbook.sheetOrder[0]];
    second.name = "Notes";
    workbook.sheetOrder.push(second.id);
    workbook.sheets[second.id] = second;

    reconcileSpreadsheetDoc(doc, workbook);
    const restored = spreadsheetSnapshotFromDoc(doc);

    expect(restored.sheetOrder).toEqual([first.id, second.id]);
    expect(restored.sheets[first.id]).toMatchObject({
      name: "Results",
      freeze: { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 },
      mergeData: [{ startRow: 2, startColumn: 0, endRow: 2, endColumn: 2 }],
      cellData: { 0: { 0: { v: 4 }, 1: { f: "=A1*2", s: "formula-style" } } },
    });
    expect(restored.styles["formula-style"]).toEqual({ bl: 1, cl: { rgb: "#112233" } });
  });

  it("validates A1 ranges and rejects partial invalid batches without edits", () => {
    expect(parseA1Range("'Data set'!$B$2:D4")).toEqual({
      sheetName: "Data set",
      startRow: 1,
      startColumn: 1,
      endRow: 3,
      endColumn: 3,
    });
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const before = spreadsheetDocContent(doc);
    expect(() => applySpreadsheetBatch(doc, { operations: [
      { type: "set_values", range: "A1", values: [["would be partial"]] },
      { type: "set_values", range: "B1:C2", values: [["wrong shape"]] },
    ] })).toThrow("2 × 2 matrix");
    expect(spreadsheetDocContent(doc)).toBe(before);
  });
});
