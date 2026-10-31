import { describe, expect, it } from "vitest";
import { listItemNewline, sizedDelimiterClose } from "./latex-input";

/** `source` with `|` as the caret, after Enter; null when Enter is left to the plain newline. */
function enter(source: string): string | null {
  const cursor = source.indexOf("|");
  const text = source.replace("|", "");
  const edit = listItemNewline(text, cursor);
  if (!edit) return null;
  const result = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return `${result.slice(0, edit.cursor)}|${result.slice(edit.cursor)}`;
}

describe("list items on Enter", () => {
  it.each([
    ["continues an item at its indent",
      "\\begin{itemize}\n  \\item one|\n\\end{itemize}", "\\begin{itemize}\n  \\item one\n  \\item |\n\\end{itemize}"],
    ["moves the text after the caret into the new item",
      "\\begin{enumerate}\n\\item one |two\n\\end{enumerate}", "\\begin{enumerate}\n\\item one\n\\item |two\n\\end{enumerate}"],
    ["continues a labelled description item",
      "\\begin{description}\n\\item[Term]|\n\\end{description}", "\\begin{description}\n\\item[Term]\n\\item |\n\\end{description}"],
    ["leaves the list from an empty last item",
      "  \\begin{itemize}\n    \\item one\n    \\item |\n  \\end{itemize}\nAfter",
      "  \\begin{itemize}\n    \\item one\n  \\end{itemize}\n  |\nAfter"],
    ["leaves a nested list into the outer item",
      "\\begin{itemize}\n\\item a\n  \\begin{itemize}\n  \\item b\n  \\item|\n  \\end{itemize}\n\\end{itemize}",
      "\\begin{itemize}\n\\item a\n  \\begin{itemize}\n  \\item b\n  \\end{itemize}\n  |\n\\end{itemize}"],
    ["ends an empty item in the middle of a list",
      "\\begin{itemize}\n  \\item |\n  \\item two\n\\end{itemize}", "\\begin{itemize}\n  |\n  \\item two\n\\end{itemize}"],
  ])("%s", (_name, source, expected) => {
    expect(enter(source)).toBe(expected);
  });

  it("leaves other lines, and a caret before the \\item, to the plain newline", () => {
    expect(enter("\\begin{itemize}\n\\item one\nmore|\n\\end{itemize}")).toBeNull();
    expect(enter("\\begin{itemize}\n|\\item one\n\\end{itemize}")).toBeNull();
    expect(enter("\\itemsep=2pt|")).toBeNull();
    expect(enter("\\bibitem{key} Author|")).toBeNull();
  });
});

describe("sized delimiters", () => {
  const close = (before: string, after = "") => sizedDelimiterClose(before, after);

  it("closes each opener with its own size and delimiter", () => {
    expect(close("$\\left(")).toEqual({ replace: 0, insert: "\\right)" });
    expect(close("\\bigl[")).toEqual({ replace: 0, insert: "\\bigr]" });
    expect(close("\\Biggl\\{")).toEqual({ replace: 0, insert: "\\Biggr\\}" });
    expect(close("\\left\\langle")).toEqual({ replace: 0, insert: "\\right\\rangle" });
    expect(close("\\left|")).toEqual({ replace: 0, insert: "\\right|" });
    expect(close("\\left\\|")).toEqual({ replace: 0, insert: "\\right\\|" });
  });

  it("absorbs the bracket pairing already wrote", () => {
    expect(close("\\left(", ")$")).toEqual({ replace: 1, insert: "\\right)" });
    expect(close("\\left\\{", "}")).toEqual({ replace: 1, insert: "\\right\\}" });
    expect(close("\\left|", "|x|")).toEqual({ replace: 0, insert: "\\right|" });
  });

  it("writes nothing for other commands or an opener that already has its partner", () => {
    expect(close("\\leftarrow(")).toBeNull();
    expect(close("\\right(")).toBeNull();
    expect(close("\\left\\langl")).toBeNull();
    expect(close("\\left(", "x \\right)")).toBeNull();
    expect(close("\\left(", "x \\left[ y \\right] \\right)")).toBeNull();
    expect(close("\\left( a \\bigl[", "\\right)")).toEqual({ replace: 0, insert: "\\bigr]" });
  });
});
