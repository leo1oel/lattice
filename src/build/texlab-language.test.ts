import { describe, expect, it } from "vitest";
import { isCiteOrRefCompletionContext } from "./texlab-language";

describe("isCiteOrRefCompletionContext", () => {
  it("detects citation and reference argument contexts", () => {
    expect(isCiteOrRefCompletionContext("see \\cite{vas")).toBe(true);
    expect(isCiteOrRefCompletionContext("see \\ref{fig:")).toBe(true);
    expect(isCiteOrRefCompletionContext("\\usepackage{ams")).toBe(false);
    expect(isCiteOrRefCompletionContext("\\begin{eq")).toBe(false);
  });
});
