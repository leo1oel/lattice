import { describe, expect, it } from "vitest";
import { formatBibDocument } from "./bib-format";

describe("formatBibDocument", () => {
  it("formats regular entries without reserializing values", () => {
    const source = "@Article { Key42 , TITLE={{Keep NASA} and \\TeX},year= 2024 # suffix,note=\"a, b and }\"}";
    expect(formatBibDocument(source)).toBe([
      "@Article{Key42,",
      "  TITLE = {{Keep NASA} and \\TeX},",
      "  year = 2024 # suffix,",
      '  note = "a, b and }"',
      "}",
    ].join("\n"));
  });

  it("is idempotent and retains a missing trailing comma", () => {
    const formatted = "@book{key,\n  title = {A title},\n  year = 12\n}";
    expect(formatBibDocument(formatted)).toBe(formatted);
    expect(formatBibDocument(formatBibDocument(formatted))).toBe(formatted);
  });

  it("leaves unfinished and unsupported entries unchanged", () => {
    const source = "@article{draft, title={still editing\n@article{bad, not a field}\n";
    expect(formatBibDocument(source)).toBe(source);
  });

  it("preserves comments, directives, and free text", () => {
    const source = [
      "% @article{inside, title={a}}",
      "Free text with @article{inline, title={untouched}}.",
      "@string{J = \"Journal\"}",
      "@preamble{\"\\newcommand{\\noop}{}\"}",
      "@comment{anything, even = braces}",
      "@article{commented, % keep this here",
      " title={As written}}",
    ].join("\n");
    expect(formatBibDocument(source)).toBe(source);
  });

  it("supports parenthesis entries and delimiters nested in values", () => {
    const source = "@inproceedings( key ,title={Functions (and commas, too)},note=\"close ) here\",year=2026,)";
    expect(formatBibDocument(source)).toBe([
      "@inproceedings(key,",
      "  title = {Functions (and commas, too)},",
      '  note = "close ) here",',
      "  year = 2026,",
      ")",
    ].join("\n"));
  });

  it("uses CRLF throughout newly formatted entries", () => {
    const source = "@article{x,title={X},year=1}\r\n\r\n@book{y,title={Y}}\r\n";
    const result = formatBibDocument(source);
    expect(result).not.toMatch(/(?<!\r)\n/);
    expect(result).toContain("@article{x,\r\n  title = {X},\r\n  year = 1\r\n}");
  });

  it("normalizes whitespace-only gaps between conventional entries", () => {
    const source = "@article{a,title={A}}\n \t\n\n\n@book{b,title={B}}";
    expect(formatBibDocument(source)).toBe(
      "@article{a,\n  title = {A}\n}\n\n@book{b,\n  title = {B}\n}",
    );
  });

  it("separates adjacent entries while preserving CRLF", () => {
    const source = "@article{a,title={A}}@book{b,title={B}}\r\n";
    expect(formatBibDocument(source)).toBe(
      "@article{a,\r\n  title = {A}\r\n}\r\n\r\n@book{b,\r\n  title = {B}\r\n}\r\n",
    );
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
