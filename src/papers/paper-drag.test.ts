import { describe, expect, it } from "vitest";
import { beginPaperDrag, PAPER_DRAG_TYPE, paperMarkdownCitation, resolvePaperDrag } from "./paper-drag";
import { latexCitationDrop } from "../editor/paper-drop";
import type { PaperSummary } from "../app-types";

const paper: PaperSummary = { arxivId: "1706.03762", title: "Attention [revisited]", citationKey: "vaswani2017", hasFullText: true, hasBlog: false };

function drop(marked: string, key = "new2026") {
  const position = marked.indexOf("|");
  const source = marked.replace("|", "");
  const edit = latexCitationDrop(source, position, key);
  return edit ? source.slice(0, edit.from) + edit.insert + source.slice(edit.to) : source;
}

describe("paper citation drop", () => {
  it.each([
    ["Before| after", "Before~\\citep{new2026} after"],
    ["\\ci|tep{alpha,beta}", "\\citep{new2026, alpha, beta}"],
    ["\\citep|{alpha,beta}", "\\citep{new2026, alpha, beta}"],
    ["\\citep{|alpha,beta}", "\\citep{new2026, alpha, beta}"],
    ["\\citep{a|lpha,beta}", "\\citep{new2026, alpha, beta}"],
    ["\\citep{alph|a,beta}", "\\citep{alpha, new2026, beta}"],
    ["\\citep{alpha,|beta}", "\\citep{alpha, new2026, beta}"],
    ["\\citep{alpha,beta|}", "\\citep{alpha, beta, new2026}"],
    ["\\citep{alpha,beta}|", "\\citep{alpha, beta, new2026}"],
    ["\\citep{alpha,beta} |", "\\citep{alpha,beta} ~\\citep{new2026}"],
    ["\\citep[see][p. 7]{alpha, |beta}", "\\citep[see][p. 7]{alpha, new2026, beta}"],
    ["\\citep*{|}", "\\citep*{new2026}"],
    ["\\textcite{alpha,, |beta,alpha,}", "\\textcite{alpha, new2026, beta}"],
    ["\\citep{alpha}\n\\citep{be|ta}", "\\citep{alpha}\n\\citep{new2026, beta}"],
  ])("inserts atomically at %s", (source, expected) => expect(drop(source)).toBe(expected));

  it("does not duplicate a key or invent a missing/invalid key", () => {
    expect(drop("\\citep{al|pha, beta}", "beta")).toBe("\\citep{alpha, beta}");
    for (const key of ["", "bad key", "bad,key", "bad}key"]) expect(drop("before|after", key)).toBe("beforeafter");
  });

  it("does not mistake a commented command for a live citation", () => {
    expect(drop("% \\citep{alpha|}")).toBe("% \\citep{alpha~\\citep{new2026}}");
    expect(drop("\\% \\citep{alpha|}")).toBe("\\% \\citep{alpha, new2026}");
  });

  it("uses @ labels and round-trip compatible local Markdown links", () => {
    expect(paperMarkdownCitation("notes/nested/test.md", paper)).toBe("[@vaswani2017](../../.research/papers/1706.03762/paper.md)");
    expect(paperMarkdownCitation("test.md", { ...paper, arxivId: "", hasFullText: false })).toBe("@vaswani2017");
    expect(paperMarkdownCitation("test.md", { ...paper, citationKey: undefined })).toBe("[@Attention \\[revisited\\]](.research/papers/1706.03762/paper.md)");
  });

  it("resolves native data against the current project and library", () => {
    const values = new Map<string, string>();
    const data = { setData: (type: string, value: string) => { values.set(type, value); }, getData: (type: string) => values.get(type) ?? "" } as DataTransfer;
    beginPaperDrag(data, "/project", paper);
    expect(data.effectAllowed).toBe("copy");
    expect(data.getData("text/plain")).toBe("@vaswani2017");
    expect(resolvePaperDrag(data, "/project", [paper])).toBe(paper);
    expect(resolvePaperDrag(data, "/other", [paper])).toBeUndefined();
    expect(resolvePaperDrag(data, "/project", [])).toBeUndefined();
    values.set(PAPER_DRAG_TYPE, "{}");
    expect(resolvePaperDrag(data, "/project", [paper])).toBeUndefined();
    values.delete(PAPER_DRAG_TYPE);
    expect(resolvePaperDrag(data, "/project", [paper])).toBe(paper);
    expect(resolvePaperDrag(data, "/other", [paper])).toBeUndefined();
    values.set("text/uri-list", "https://example.com/paper");
    expect(resolvePaperDrag(data, "/project", [paper])).toBeUndefined();
  });
});
