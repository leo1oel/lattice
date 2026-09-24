import { describe, expect, it, vi } from "vitest";
import { parseLocalLabels } from "./latex-text";

describe("live label parsing", () => {
  it("preserves lines and snippets across duplicate, empty, and multiline labels", () => {
    const source = "  \\label{first} \\label{second}  \r\n\n😀 \\label{first}\n\\label{ }\n  \\label{\n last\n} tail";
    expect(parseLocalLabels("body.tex", source)).toEqual([
      { label: "first", kind: "reference", title: "first", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "second", kind: "reference", title: "second", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "last", kind: "reference", title: "last", path: "body.tex", line: 5, snippet: "\\label{" },
    ]);
  });

  it("does not split the whole live buffer once per label", () => {
    const source = Array.from({ length: 100 }, (_, i) => `prose\n\\label{eq:${i}}\n`).join("");
    const split = vi.spyOn(String.prototype, "split");
    let fullBufferSplits: number;
    try {
      const labels = parseLocalLabels("main.tex", source);
      fullBufferSplits = split.mock.contexts.filter((value) => String(value) === source).length;
      expect(labels).toHaveLength(100);
      expect(labels[99]).toMatchObject({ label: "eq:99", line: 200, snippet: "\\label{eq:99}" });
    } finally {
      split.mockRestore();
    }
    expect(fullBufferSplits).toBeLessThanOrEqual(1);
  });
});
