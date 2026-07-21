import { describe, expect, it } from "vitest";
import { findAppendixMarker } from "./appendix-pages";

describe("findAppendixMarker", () => {
  it("finds the first appendix switch ignoring comments", () => {
    expect(findAppendixMarker({
      "main.tex": "\\section{Intro}\n% \\appendix\n\\appendix\n\\section{Proofs}\n",
    })).toEqual({ path: "main.tex", line: 3 });
  });

  it("returns null when there is no appendix", () => {
    expect(findAppendixMarker({ "main.tex": "\\begin{document}\nHi\n\\end{document}\n" })).toBeNull();
  });
});
