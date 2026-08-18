import { describe, expect, it } from "vitest";
import { buildTabularSnippet } from "./table-generator";

describe("table generator", () => {
  it("builds a booktabs float with the requested dimensions", () => {
    const snippet = buildTabularSnippet({
      rows: 2,
      cols: 3,
      booktabs: true,
      float: true,
      caption: "Results",
      label: "tab:results",
    });
    expect(snippet.insert).toContain("\\begin{table}[t]");
    expect(snippet.insert).toContain("\\begin{tabular}{lll}");
    expect(snippet.insert).toContain("\\caption{Results}");
    expect(snippet.insert).toContain("\\label{tab:results}");
    expect(snippet.insert).toContain("\\toprule");
    expect(snippet.cursorOffset).toBe(snippet.insert.indexOf("Results"));
  });

  it("can emit a bare tabular", () => {
    const snippet = buildTabularSnippet({
      rows: 1,
      cols: 2,
      booktabs: false,
      float: false,
      caption: "",
      label: "",
    });
    expect(snippet.insert).toContain("\\begin{tabular}{ll}");
    expect(snippet.insert).not.toContain("\\begin{table}");
  });
});
