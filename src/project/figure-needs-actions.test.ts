import { describe, expect, it } from "vitest";
import { includesEntry } from "./figure-needs-actions";

const files: Record<string, string> = {
  "chapters/one.tex": "\\input{chapters/two}\n",
  "chapters/two.tex": "\\begin{figure}\\input{figures/scheme}\\end{figure}\n",
  "loop.tex": "\\input{loop}\n",
};
const read = (path: string) => (path in files ? Promise.resolve(files[path]) : Promise.reject(new Error("missing")));

describe("whether a document includes a figure", () => {
  it("finds it in the document or through the files it includes", async () => {
    expect(await includesEntry("main.tex", "\\input{figures/scheme}", "figures/scheme.tex", read)).toBe(true);
    expect(await includesEntry("main.tex", "\\include{chapters/one}", "figures/scheme.tex", read)).toBe(true);
  });
  it("is false for a commented include, another figure, or a loop", async () => {
    expect(await includesEntry("main.tex", "% \\input{figures/scheme}", "figures/scheme.tex", read)).toBe(false);
    expect(await includesEntry("main.tex", "\\input{figures/other}", "figures/scheme.tex", read)).toBe(false);
    expect(await includesEntry("main.tex", "\\input{loop}", "figures/scheme.tex", read)).toBe(false);
  });
});
