import { describe, expect, it } from "vitest";
import { mergeTodosWithBuffer, todoKindInLine, todosInText } from "./todo-scavenger";

describe("todo scavenger", () => {
  it("detects comment markers and \\todo", () => {
    expect(todoKindInLine("% TODO polish abstract")).toBe("TODO");
    expect(todoKindInLine("  % FIXME: citation")).toBe("FIXME");
    expect(todoKindInLine("% XXX hack")).toBe("XXX");
    expect(todoKindInLine("\\todo{add proof}")).toBe("todo");
    expect(todoKindInLine("\\todo[inline]{check}")).toBe("todo");
    expect(todoKindInLine("plain text TODO")).toBeNull();
  });

  it("collects line hits from a buffer", () => {
    const hits = todosInText(
      "sections/method.tex",
      "Intro\n% TODO rewrite\n\\todo{figure}\n",
    );
    expect(hits).toEqual([
      { path: "sections/method.tex", line: 2, kind: "TODO", preview: "% TODO rewrite" },
      { path: "sections/method.tex", line: 3, kind: "todo", preview: "\\todo{figure}" },
    ]);
  });

  it("numbers lines like a line split, across CRLF and several words per line", () => {
    const content = [
      "Intro with a todo word in prose",
      "% TODO first\r",
      "",
      "% todo lower, FIXME and XXX on one line",
      "\\Todo*{starred}\r",
      "%no marker here",
      "   % xxx indented",
    ].join("\n");
    const expected = content.split(/\r?\n/).flatMap((text, index) => {
      const kind = todoKindInLine(text);
      return kind ? [{ line: index + 1, kind, preview: text.trim() }] : [];
    });
    expect(todosInText("a.tex", content).map(({ line, kind, preview }) => ({ line, kind, preview }))).toEqual(expected);
    expect(expected.map(({ line }) => line)).toEqual([2, 4, 5, 7]);
  });

  it("overlays dirty active-file hits", () => {
    const merged = mergeTodosWithBuffer(
      [
        { path: "main.tex", line: 1, kind: "TODO", preview: "% TODO stale" },
        { path: "other.tex", line: 4, kind: "FIXME", preview: "% FIXME keep" },
      ],
      "main.tex",
      "% TODO fresh\n",
    );
    expect(merged).toEqual([
      { path: "main.tex", line: 1, kind: "TODO", preview: "% TODO fresh" },
      { path: "other.tex", line: 4, kind: "FIXME", preview: "% FIXME keep" },
    ]);
  });
});
