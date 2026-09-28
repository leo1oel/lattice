import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  beginEnvironmentClose,
  enclosingEnvironment,
  enclosingEnvironmentRange,
  matchingEnvironmentTarget,
  renameEnvironmentAt,
} from "./latex-environments";

const closeAfter = (before: string, after: string, indent?: string) =>
  beginEnvironmentClose(before, Text.of((before + after).split("\n")), indent);
const span = (source: string, text: string) => ({ from: source.indexOf(text), to: source.indexOf(text) + text.length });

describe("LaTeX environments", () => {
  it("auto-closes begin environments and skips existing ends", () => {
    expect(closeAfter("\\begin{align}", "")).toEqual({ insert: "\n  \n\\end{align}", cursorOffset: 3 });
    expect(closeAfter("\\begin{align}", "\n\\end{align}")).toBeNull();
    expect(closeAfter("\\begin{itemize}", "\n\\item a\n\\item b\n\\end{itemize}")).toBeNull();
    expect(closeAfter("\\begin{itemize}", "\n\\begin{itemize}\\end{itemize}")?.insert).toContain("\\end{itemize}");
    expect(closeAfter("\\begin{itemize}\n\\item a\n\\begin{itemize}", "\n\\end{itemize}")?.insert).toContain("\\end{itemize}");
    expect(closeAfter("\\begin{itemize}\n\\begin{itemize}", "\n\\end{itemize}\n\\end{itemize}")).toBeNull();
    expect(closeAfter("\\begin{itemize}", "\n% \\end{itemize}")?.insert).toContain("\\end{itemize}");
    expect(closeAfter("\\begin{align*}", "")?.insert).toContain("\\end{align*}");
    expect(closeAfter("  \\begin{itemize}", "", "  ")).toEqual({ insert: "\n    \n  \\end{itemize}", cursorOffset: 5 });
  });

  it("jumps between matching begin and end environments and renames the one under the cursor", () => {
    const source = "\\begin{figure}\\begin{center}x\\end{center}\\end{figure}";
    const beginFigure = span(source, "\\begin{figure}");
    const endFigure = span(source, "\\end{figure}");
    const beginCenter = span(source, "\\begin{center}");
    const endCenter = span(source, "\\end{center}");
    const inside = source.indexOf("x");
    expect(matchingEnvironmentTarget(source, beginFigure.from + 2)).toEqual(endFigure);
    expect(matchingEnvironmentTarget(source, endFigure.from + 2)).toEqual(beginFigure);
    expect(matchingEnvironmentTarget(source, beginCenter.from + 2)).toEqual(endCenter);
    expect(matchingEnvironmentTarget(source, inside)).toEqual(beginCenter);
    expect(enclosingEnvironment(source, inside)?.name).toBe("center");
    expect(enclosingEnvironmentRange(source, inside)).toEqual({ from: beginCenter.from, to: endCenter.to });
    expect(renameEnvironmentAt(source, beginFigure.from + 2, "figure*")).toEqual([
      { ...beginFigure, insert: "\\begin{figure*}" },
      { ...endFigure, insert: "\\end{figure*}" },
    ]);
    expect(renameEnvironmentAt(source, inside, "quote")).toEqual([
      { ...beginCenter, insert: "\\begin{quote}" },
      { ...endCenter, insert: "\\end{quote}" },
    ]);
  });
});
