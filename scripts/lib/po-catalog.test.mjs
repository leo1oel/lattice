import { describe, expect, it } from "vitest";
import { parseAllowlist, parsePo } from "./po-catalog.mjs";

const catalog = [
  'msgid ""',
  'msgstr ""',
  '"Language: zh-CN\\n"',
  "",
  "#: src/app/app.tsx:1",
  'msgid "Open"',
  'msgstr "打开"',
  "",
  'msgid ""',
  '"A long message "',
  '"on two lines"',
  'msgstr "长消息"',
  "",
].join("\n");

describe("parsePo", () => {
  it("reads single-line and continued entries, skipping the header", () => {
    expect(parsePo(catalog)).toEqual([
      { msgid: "Open", msgstr: "打开" },
      { msgid: "A long message on two lines", msgstr: "长消息" },
    ]);
  });

  it("reads a CRLF checkout the same as an LF one", () => {
    expect(parsePo(catalog.replaceAll("\n", "\r\n"))).toEqual(parsePo(catalog));
  });
});

describe("parseAllowlist", () => {
  const list = "# Same in every language\nPDF\n\nLaTeX\n";

  it("keeps one string per line, without comments or blank lines", () => {
    expect([...parseAllowlist(list)]).toEqual(["PDF", "LaTeX"]);
  });

  it("does not keep a CRLF checkout's carriage returns", () => {
    expect(parseAllowlist(list.replaceAll("\n", "\r\n"))).toEqual(parseAllowlist(list));
  });
});
