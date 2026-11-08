import { describe, expect, it } from "vitest";
import type { CitationRole, EditorComment } from "../comments/editor-comment-data";
import { anchorCitationReasons, annotationAnchor, citationSites, createCitationReason, panelCitationReasons, reanchoredReason } from "./citation-reasons";

const SOURCE = [
  "\\section{Results}",
  "Our bound holds on every benchmark \\cite{smith2020}, as earlier work found.",
  "",
  "\\section{Limits}",
  "It fails for sparse inputs \\citep[p.~5]{jones2019, smith2020}; we return to this later.",
].join("\n");

let made = 0;
function reason(source: string, nth: number, key: string, role: CitationRole, body = ""): EditorComment {
  const site = citationSites(source).filter((item) => item.key === key)[nth]!;
  const created = createCitationReason({ path: "main.tex", source, site, role, body, authorId: "me", authorName: "Me" })!;
  made += 1;
  return { ...created, createdAt: `2026-11-08T00:00:0${made}Z` };
}

function placed(source: string, reasons: EditorComment[]) {
  const sites = anchorCitationReasons(source, "main.tex", reasons);
  return reasons.map((item) => {
    const site = sites.get(item.id);
    return site ? `${site.key}@${site.line}` : null;
  });
}

describe("citationSites", () => {
  it("lists every key of every citation with its line and cited page", () => {
    expect(citationSites(SOURCE).map(({ key, line, page }) => ({ key, line, page }))).toEqual([
      { key: "smith2020", line: 2, page: undefined },
      { key: "jones2019", line: 5, page: 5 },
      { key: "smith2020", line: 5, page: 5 },
    ]);
  });

  it("skips cites TeX never reads: in a comment, a verbatim environment or \\verb", () => {
    const source = [
      "% \\cite{smith2020} (old draft)",
      "Shown 100\\% here \\cite{smith2020}. % not \\cite{jones2019}",
      "\\begin{verbatim}",
      "\\cite{smith2020}",
      "\\end{verbatim}",
      "Write \\verb|\\cite{jones2019}| for that.",
    ].join("\n");
    expect(citationSites(source).map(({ key, line }) => `${key}@${line}`)).toEqual(["smith2020@2"]);
  });
});

describe("panelCitationReasons", () => {
  it("lists a reason whose cite is gone or whose file is gone, and waits for a file not read yet", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    const deleted = SOURCE.replace(" \\cite{smith2020}", "");
    expect(panelCitationReasons([supporting], () => SOURCE)).toEqual([]);
    expect(panelCitationReasons([supporting], () => deleted)).toEqual([supporting]);
    expect(panelCitationReasons([supporting], () => null)).toEqual([supporting]);
    expect(panelCitationReasons([supporting], () => undefined)).toEqual([]);
  });
});

describe("anchorCitationReasons", () => {
  it("anchors each reason to its own occurrence of a key cited twice", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting", "Same benchmark suite");
    const counter = reason(SOURCE, 1, "smith2020", "counterexample");
    expect(supporting.quote).toBe("smith2020");
    expect(supporting.citation).toEqual({ key: "smith2020", role: "supporting" });
    expect(placed(SOURCE, [supporting, counter])).toEqual(["smith2020@2", "smith2020@5"]);
    // The store's order does not decide it.
    expect(placed(SOURCE, [counter, supporting])).toEqual(["smith2020@5", "smith2020@2"]);
  });

  it("keeps its occurrence through edits before it and next to it", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    const counter = reason(SOURCE, 1, "smith2020", "counterexample");
    const edited = SOURCE
      .replace("\\section{Results}", "\\section{Main results}\nA new opening paragraph.\n")
      .replace("on every benchmark", "on every public benchmark we tried")
      .replace("; we return", "; we come back");
    expect(placed(edited, [supporting, counter])).toEqual(["smith2020@4", "smith2020@7"]);
  });

  it("follows a paragraph moved elsewhere in the file", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    const counter = reason(SOURCE, 1, "smith2020", "counterexample");
    const lines = SOURCE.split("\n");
    const moved = [lines[3], lines[4], "", lines[0], lines[1]].join("\n");
    expect(placed(moved, [supporting, counter])).toEqual(["smith2020@5", "smith2020@2"]);
  });

  it("orphans a reason whose cite was deleted instead of moving it to the other one", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    const counter = reason(SOURCE, 1, "smith2020", "counterexample");
    const deleted = SOURCE.replace(" \\cite{smith2020}", "");
    expect(placed(deleted, [supporting, counter])).toEqual([null, "smith2020@5"]);
    // Alone, too: the remaining cite's context is not the deleted one's.
    expect(placed(deleted, [supporting])).toEqual([null]);
    // The panel, which lists it, does not place it on the remaining cite either.
    expect(annotationAnchor(deleted, supporting)).toBeNull();
  });

  it("orphans a reason when its key is taken out of a citation with several", () => {
    const counter = reason(SOURCE, 1, "smith2020", "counterexample");
    const jones = reason(SOURCE, 0, "jones2019", "comparison");
    const trimmed = SOURCE.replace("{jones2019, smith2020}", "{jones2019}");
    expect(placed(trimmed, [counter, jones])).toEqual([null, "jones2019@5"]);
  });

  it("prefers the span the editor mapped through its own edits", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    // Both cites now read the same around the key; only the editor knows which is which.
    const twin = "x \\cite{smith2020} y\nx \\cite{smith2020} y";
    const second = citationSites(twin)[1]!;
    const sites = anchorCitationReasons(twin, "main.tex", [supporting], new Map([[supporting.id, second]]));
    expect(sites.get(supporting.id)?.line).toBe(2);
  });

  it("ignores reasons on other files and plain annotations", () => {
    const supporting = { ...reason(SOURCE, 0, "smith2020", "supporting"), path: "intro.tex" };
    expect(anchorCitationReasons(SOURCE, "main.tex", [supporting]).size).toBe(0);
  });
});

describe("reanchoredReason", () => {
  it("refreshes the stored anchor only when the occurrence moved or its context changed", () => {
    const supporting = reason(SOURCE, 0, "smith2020", "supporting");
    const site = anchorCitationReasons(SOURCE, "main.tex", [supporting]).get(supporting.id)!;
    expect(reanchoredReason(SOURCE, supporting, site)).toBeNull();
    const edited = `Intro.\n${SOURCE}`;
    const moved = anchorCitationReasons(edited, "main.tex", [supporting]).get(supporting.id)!;
    expect(reanchoredReason(edited, supporting, moved)).toMatchObject({ from: supporting.from + 7, quote: "smith2020" });
  });
});
