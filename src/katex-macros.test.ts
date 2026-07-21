import { describe, expect, it } from "vitest";
import { katexMacrosFromSources } from "./katex-macros";

describe("katexMacrosFromSources", () => {
  it("collects simple newcommand macros for KaTeX", () => {
    const macros = katexMacrosFromSources([
      String.raw`\newcommand{\R}{\mathbb{R}}`,
      String.raw`\renewcommand{\eps}{\varepsilon}`,
    ]);
    expect(macros).toEqual({
      "\\R": String.raw`\mathbb{R}`,
      "\\eps": String.raw`\varepsilon`,
    });
  });

  it("keeps the first definition when names collide", () => {
    const macros = katexMacrosFromSources([
      String.raw`\newcommand{\R}{first}`,
      String.raw`\newcommand{\R}{second}`,
    ]);
    expect(macros["\\R"]).toBe("first");
  });
});
