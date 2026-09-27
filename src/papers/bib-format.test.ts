import { describe, expect, it } from "vitest";
import { formatBibDocument } from "./bib-format";

describe("formatBibDocument", () => {
  const unchanged = (source: string) => [source, source];

  it.each([
    ["formats regular entries without reserializing values",
      "@Article { Key42 , TITLE={{Keep NASA} and \\TeX},year= 2024 # suffix,note=\"a, b and }\"}",
      ["@Article{Key42,", "  TITLE = {{Keep NASA} and \\TeX},", "  year = 2024 # suffix,", '  note = "a, b and }"', "}"].join("\n")],
    ["is idempotent and retains a missing trailing comma", ...unchanged("@book{key,\n  title = {A title},\n  year = 12\n}")],
    ["leaves unfinished and unsupported entries unchanged", ...unchanged("@article{draft, title={still editing\n@article{bad, not a field}\n")],
    ["preserves comments, directives, and free text", ...unchanged([
      "% @article{inside, title={a}}",
      "Free text with @article{inline, title={untouched}}.",
      "@string{J = \"Journal\"}",
      "@preamble{\"\\newcommand{\\noop}{}\"}",
      "@comment{anything, even = braces}",
      "@article{commented, % keep this here",
      " title={As written}}",
    ].join("\n"))],
    ["supports parenthesis entries and delimiters nested in values",
      "@inproceedings( key ,title={Functions (and commas, too)},note=\"close ) here\",year=2026,)",
      ["@inproceedings(key,", "  title = {Functions (and commas, too)},", '  note = "close ) here",', "  year = 2026,", ")"].join("\n")],
    ["normalizes whitespace-only gaps between conventional entries",
      "@article{a,title={A}}\n \t\n\n\n@book{b,title={B}}",
      "@article{a,\n  title = {A}\n}\n\n@book{b,\n  title = {B}\n}"],
    ["separates adjacent entries while preserving CRLF",
      "@article{a,title={A}}@book{b,title={B}}\r\n",
      "@article{a,\r\n  title = {A}\r\n}\r\n\r\n@book{b,\r\n  title = {B}\r\n}\r\n"],
  ])("%s", (_, source, expected) => {
    expect(formatBibDocument(source)).toBe(expected);
    // Formatting is idempotent.
    expect(formatBibDocument(expected)).toBe(expected);
  });

  it("uses CRLF throughout newly formatted entries", () => {
    const result = formatBibDocument("@article{x,title={X},year=1}\r\n\r\n@book{y,title={Y}}\r\n");
    expect(result).not.toMatch(/(?<!\r)\n/);
    expect(result).toContain("@article{x,\r\n  title = {X},\r\n  year = 1\r\n}");
  });

  it("does not normalize across non-entry content or scan at-signs inside it", () => {
    const source = [
      "@article{a,title={Contact a@b.test or write @book{fake,title={Fake}}}}",
      "",
      "% retain this comment and its spacing",
      "",
      "",
      "@string{J = \"Journal\"}",
      "",
      "",
      "Free text @book{inline,title={Untouched}}.",
      "",
      "",
      "@book{b,title={B}}",
      "",
      "",
      "@article{draft,title={unfinished}",
    ].join("\n");
    const result = formatBibDocument(source);
    expect(result).toContain("a@b.test or write @book{fake,title={Fake}}");
    expect(result).toContain("}\n\n% retain this comment and its spacing\n\n\n@string");
    expect(result).toContain('@string{J = "Journal"}\n\n\nFree text');
    expect(result).toContain("Free text @book{inline,title={Untouched}}.\n\n\n@book");
    expect(result).toContain("@article{draft,title={unfinished}");
  });
});
