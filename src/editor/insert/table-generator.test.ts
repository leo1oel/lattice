import { describe, expect, it } from "vitest";
import { buildTabularSnippet } from "./table-generator";

describe("table generator", () => {
  it.each([
    ["a booktabs float with the requested dimensions", { rows: 2, cols: 3, booktabs: true, float: true, caption: "Results", label: "tab:results" },
      ["\\begin{table}[t]", "\\begin{tabular}{lll}", "\\caption{Results}", "\\label{tab:results}", "\\toprule"], []],
    ["a bare tabular", { rows: 1, cols: 2, booktabs: false, float: false, caption: "", label: "" },
      ["\\begin{tabular}{ll}"], ["\\begin{table}"]],
  ])("builds %s", (_name, options, present, absent) => {
    const snippet = buildTabularSnippet(options);
    for (const part of present) expect(snippet.insert).toContain(part);
    for (const part of absent) expect(snippet.insert).not.toContain(part);
    expect(snippet.cursorOffset).toBe(snippet.insert.indexOf(options.float ? "Results" : "Col 1"));
  });
});
