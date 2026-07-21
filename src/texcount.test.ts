import { describe, expect, it } from "vitest";

/** Mirror of Rust `estimate_from_latex` for UI copy / smoke checks. */
function roughBodyWords(source: string): number {
  let text = source
    .split("\n")
    .map((line) => line.split("%")[0] ?? "")
    .join("\n");
  for (const env of ["figure", "table", "equation", "align", "gather", "verbatim", "lstlisting"]) {
    text = text.replace(new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g"), " ");
  }
  text = text
    .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?(\{[^}]*\})*/g, " ")
    .replace(/[{}$&#_~^]/g, " ");
  return text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

describe("body word estimate heuristics", () => {
  it("ignores comments and common commands", () => {
    const words = roughBodyWords(`
\\documentclass{article}
\\begin{document}
Hello world paper.
% TODO ignore this
\\textbf{Bold}
\\end{document}
`);
    expect(words).toBeGreaterThanOrEqual(3);
    expect(words).toBeLessThan(10);
  });
});
