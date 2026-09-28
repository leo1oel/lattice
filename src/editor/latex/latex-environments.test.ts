import { describe, expect, it } from "vitest";
import {
  beginEnvironmentClose,
  enclosingEnvironment,
  enclosingEnvironmentRange,
  matchingEnvironmentTarget,
  renameEnvironmentAt,
} from "./latex-environments";

const span = (source: string, text: string) => ({ from: source.indexOf(text), to: source.indexOf(text) + text.length });

describe("LaTeX environments", () => {
  it("auto-closes begin environments and skips existing ends", () => {
    expect(beginEnvironmentClose("\\begin{align}", "")).toEqual({ insert: "\n  \n\\end{align}", cursorOffset: 3 });
    expect(beginEnvironmentClose("\\begin{align}", "\n\\end{align}")).toBeNull();
    expect(beginEnvironmentClose("\\begin{align*}", "")?.insert).toContain("\\end{align*}");
  });

  it("renames the environment under the cursor", () => {
    const source = "\\begin{align}x\\end{align}";
    expect(renameEnvironmentAt(source, 2, "align*")).toEqual([
      { ...span(source, "\\begin{align}"), insert: "\\begin{align*}" },
      { ...span(source, "\\end{align}"), insert: "\\end{align*}" },
    ]);
  });

  it("jumps between matching begin and end environments", () => {
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
    expect(renameEnvironmentAt(source, inside, "quote")).toEqual([
      { ...beginCenter, insert: "\\begin{quote}" },
      { ...endCenter, insert: "\\end{quote}" },
    ]);
  });
});
