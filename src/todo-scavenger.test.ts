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
