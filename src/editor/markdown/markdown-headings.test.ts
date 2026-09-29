/**
 * Headings as the workspace index reads them (spec R-INL-6): ATX headings
 * outside fenced code, with their slugs, repeats told apart.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { describe, expect, it } from "vitest";
import { scanHeadings } from "./markdown-headings";

describe("scanHeadings", () => {
  it("reads ATX headings with slugs, skipping fenced code and telling repeats apart", () => {
    const lines = ["# Document title", "## Repeat", "```md", "# Hidden", "```", "~~~", "## Also hidden", "~~~~", "## Repeat ##", "#NotAHeading", "   ### Indented", "\t# Tabbed code"];
    expect(scanHeadings(lines)).toEqual([
      { level: 1, text: "Document title", slug: "document-title" },
      { level: 2, text: "Repeat", slug: "repeat" },
      { level: 2, text: "Repeat", slug: "repeat-1" },
      { level: 3, text: "Indented", slug: "indented" },
    ]);
  });

  it("keeps a fence open until one of the same character at least as long closes it", () => {
    expect(scanHeadings(["````", "```", "# Inside", "````", "# After"]).map((heading) => heading.text)).toEqual(["After"]);
    // A backtick info string may not hold a backtick: that line is not a fence.
    expect(scanHeadings(["``` a`b", "# Visible"]).map((heading) => heading.text)).toEqual(["Visible"]);
  });

  it("reads CRLF lines and empty headings", () => {
    expect(scanHeadings(["## Windows line\r", "#"])).toEqual([
      { level: 2, text: "Windows line", slug: "windows-line" },
      { level: 1, text: "", slug: "" },
    ]);
  });
});
