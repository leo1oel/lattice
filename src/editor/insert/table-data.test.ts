import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { managedTableSource, newTableData, parseTableData, tableAtCursor, tableSource, validTableData } from "./table-data";

describe("data table round trips", () => {
  it("imports quoted CSV, Unicode, empty fields and multiline spreadsheet cells", () => {
    expect(parseTableData('方法,score,note,empty\r\n"A,B",0.0123,"a ""quote""",\r\n', ","))
      .toEqual([["方法", "score", "note", "empty"], ["A,B", "0.0123", 'a "quote"', ""]]);
    expect(parseTableData('a\t"two\nlines"\t\n', "\t")).toEqual([["a", "two\nlines", ""]]);
    expect(parseTableData('a,b\nc', ",")).toEqual([["a", "b"], ["c", ""]]);
  });
  it("rejects malformed quotes and oversized data without truncating", () => {
    for (const input of ['"open', '"a"x,b', Array(22).fill("a").join("\n"), Array(21).fill("a").join(",")]) {
      expect(parseTableData(input, ",")).toBeNull();
    }
  });
  it("retains a 5 by 4 experiment, raw math, formatting and caption across updates", () => {
    const data = newTableData();
    data.cells = parseTableData('方法\taccuracy\tnote\tformula\nA&B\t0.12345\t50%\t$x_1$\n中文\t.5\t\t\nC\t1\t_#{}\\~^$\t\nD\t0.2\t\t', "\t")!
      .map((row) => row.map((text) => ({ text, latex: false })));
    data.cells[1][3].latex = true;
    data.align = ["l", "r", "c", "l"];
    data.decimals = 3;
    data.caption = "中文 & 50%";
    data.label = "tab:results";
    expect(validTableData(data)).toBe(true);
    const source = tableSource(data);
    expect(source).toContain("A\\&B & 0.123 & 50\\% & $x_1$");
    expect(source).toContain("\\caption{中文 \\& 50\\%}");
    expect(source).toContain("\\begin{tabular}{lrcl}");
    const first = managedTableSource(data);
    expect(tableAtCursor(first, first.indexOf("\\begin"))?.data).toEqual(data);
    data.cells[1][1].text = "0.9";
    const second = managedTableSource(data);
    expect(tableAtCursor(second, second.indexOf("\\begin"))?.data).toEqual(data);
    // Replace exactly one table, leaving a second copy and surrounding prose intact.
    const before = `intro\n${first}middle\n${first}outro`;
    const target = tableAtCursor(before, before.indexOf("\\begin"))!;
    let state = EditorState.create({ doc: before, extensions: [history()] });
    state = state.update({ changes: { from: target.from, to: target.to, insert: second } }).state;
    expect(state.doc.toString()).toBe(`intro\n${second}middle\n${first}outro`);
    undo({ state, dispatch: (transaction) => { state = transaction.state; } });
    expect(state.doc.toString()).toBe(before);
  });
  it("refuses hand edits, malformed metadata and structural raw TeX", () => {
    const data = newTableData();
    const source = managedTableSource(data);
    for (const changed of [source.replace("Col 1", "Manual"), source.replace("%7B", "%XX")]) {
      expect(tableAtCursor(changed, changed.indexOf("\\begin"))?.data).toBeNull();
    }
    data.cells[0][0] = { text: "\\begin{tabular}{l}", latex: true };
    expect(validTableData(data)).toBe(false);
    expect(tableAtCursor(source, source.length)).toBeNull();
    expect(tableAtCursor(source, source.indexOf("\\begin"))?.data).not.toBeNull();
  });
});
