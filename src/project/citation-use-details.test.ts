import { describe, expect, it } from "vitest";
import { citationSites, createCitationReason } from "../editor/latex/citation-reasons";
import { citationUseDetails } from "./citation-use-details";
import type { SymbolOccurrence } from "./references-panel";

const MAIN = "\\section{A}\nOne \\cite{smith} and again \\citep[p.~3]{smith}.\n\\section{B}\nLater \\cite{jones, smith}.";

const use = (line: number): SymbolOccurrence => ({ kind: "citation", symbol: "smith", role: "reference", path: "main.tex", line, snippet: "" });

describe("citationUseDetails", () => {
  it("gives each scanned use its own reason and page, two uses on one line included", () => {
    const sites = citationSites(MAIN).filter((site) => site.key === "smith");
    const reason = (index: number, role: "supporting" | "method", body: string) => createCitationReason({
      path: "main.tex", source: MAIN, site: sites[index]!, role, body, authorId: "me", authorName: "Me",
    })!;
    const second = reason(1, "method", "Their estimator");
    const third = reason(2, "supporting", "");
    const details = citationUseDetails([use(2), use(2), use(4)], new Map([["main.tex", MAIN]]), [third, second]);
    expect(details.map((detail) => [detail.reason?.citation?.role ?? null, detail.reason?.body ?? null, detail.page ?? null])).toEqual([
      [null, null, null],
      ["method", "Their estimator", 3],
      ["supporting", "", null],
    ]);
  });

  it("matches the scan's uses on a line that also has \\citeauthor, \\citeyear and a spaced \\cite", () => {
    const line = "\\citeauthor{smith} (\\citeyear{smith}) argue X; but see \\cite [p.~12] {smith}.";
    const site = citationSites(line).find((item) => item.from === line.lastIndexOf("smith"))!;
    const counter = createCitationReason({
      path: "main.tex", source: line, site, role: "counterexample", body: "", authorId: "me", authorName: "Me",
    })!;
    // list_citation_usages reads three uses of the key on this line: \citeauthor, \citeyear, then \cite.
    const details = citationUseDetails([use(1), use(1), use(1)], new Map([["main.tex", line]]), [counter]);
    expect(details.map((detail) => [detail.reason?.citation?.role ?? null, detail.page ?? null])).toEqual([
      [null, null],
      [null, null],
      ["counterexample", 12],
    ]);
  });

  it("leaves a use whose file was not read without detail", () => {
    expect(citationUseDetails([use(2)], new Map(), [])).toEqual([{}]);
  });
});
