import { describe, expect, it } from "vitest";
import { findPaperSource } from "./paper-source";
import type { ZoteroAnnotation } from "./zotero";
import {
  withZoteroAnnotations, zoteroAnnotationHref, zoteroAnnotationMarkdown, zoteroCommentMarkdown, type AnnotationLabels,
} from "./zotero-annotations";

const LABELS: AnnotationLabels = { heading: "Zotero annotations", page: (page) => `p. ${page}` };
const LOCAL = { arxivId: "web-0123456789abcdef", citationKey: "Lee2024Sparse", title: "Sparse attention", hasFullText: true, hasLocalPdf: true };
const ARXIV = { arxivId: "1706.03762", citationKey: "vaswani2017attention", title: "Attention Is All You Need", hasFullText: true };
const CITED = { arxivId: "", citationKey: "He2016ResNet", title: "Deep Residual Learning", hasFullText: false };

const annotation = (fields: Partial<ZoteroAnnotation> = {}): ZoteroAnnotation => ({
  key: "ANNHIGH1", attachment: "PDF00001", kind: "highlight", text: "", comment: "", page: 3, pageLabel: "3", color: "#ffd400", ...fields,
});

describe("a Zotero annotation's links", () => {
  it("opens the annotation in Zotero's reader at its page", () => {
    expect(zoteroAnnotationHref(annotation())).toBe("zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1");
    expect(zoteroAnnotationHref(annotation({ page: null }))).toBe("zotero://open-pdf/library/items/PDF00001?annotation=ANNHIGH1");
  });

  it("quotes a highlight, linking the page in Lattice by its printed number and the passage's ends", () => {
    const text = "Sparse attention keeps long documents in reach of a single model without losing the thread";
    expect(zoteroAnnotationMarkdown(LOCAL, annotation({ text, page: 5, pageLabel: "583" }), LABELS)).toBe(
      "> Sparse attention keeps long documents in reach of a single model without losing the thread "
      + "[p. 583](/.research/papers/web-0123456789abcdef/original.pdf#page=5 \"Sparse attention keeps long … without losing the thread\") · "
      + "[Zotero](zotero://open-pdf/library/items/PDF00001?page=5&annotation=ANNHIGH1)",
    );
  });

  it("links an arXiv paper's page on its arXiv PDF", () => {
    expect(zoteroAnnotationMarkdown(ARXIV, annotation({ text: "Attention is all" }), LABELS))
      .toContain("[p. 3](https://arxiv.org/pdf/1706.03762#page=3 \"Attention is all … Attention is all\")");
  });

  it("names the page without a link for a paper Lattice has no PDF of", () => {
    expect(zoteroAnnotationMarkdown(CITED, annotation({ kind: "note", comment: "Check the ablation" }), LABELS))
      .toBe("Check the ablation p. 3 · [Zotero](zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1)");
  });

  it("puts a comment below its quote, and a note's comment before its links", () => {
    const highlighted = zoteroAnnotationMarkdown(LOCAL, annotation({ text: "dense retrieval", comment: "Key idea" }), LABELS);
    expect(highlighted.split("\n\n")).toEqual([expect.stringMatching(/^> dense retrieval \[p\. 3\]/), "Key idea"]);
    const note = zoteroAnnotationMarkdown(LOCAL, annotation({ kind: "note", comment: "Compare" }), LABELS);
    expect(note).toBe("Compare [p. 3](/.research/papers/web-0123456789abcdef/original.pdf#page=3) · [Zotero](zotero://open-pdf/library/items/PDF00001?page=3&annotation=ANNHIGH1)");
  });

  it("is followed back to the paper's own PDF at that page", () => {
    const papers = [{ ...LOCAL, url: undefined, hasBlog: false }];
    const href = new URL("/.research/papers/web-0123456789abcdef/original.pdf#page=3", window.location.href).href;
    expect(findPaperSource(papers, href, "dense … retrieval")).toEqual({
      paper: papers[0], citation: { page: 3, first: "dense", last: "retrieval" },
    });
    expect(findPaperSource([{ ...papers[0], hasLocalPdf: false }], href, "")).toBeNull();
    expect(findPaperSource(papers, "https://example.org/.research/papers/web-0123456789abcdef/original.pdf#page=3", "")).toBeNull();
  });
});

describe("a Zotero comment", () => {
  it("keeps its bold and italic and its paragraphs, and escapes what Markdown would read", () => {
    expect(zoteroCommentMarkdown("<b>Strong</b> claim; costs $5 &amp; <i>more</i><br/># not a heading")).toBe(
      "**Strong** claim; costs \\$5 & *more*\n\\# not a heading",
    );
    expect(zoteroCommentMarkdown("<p>One</p><p>Two</p>\n\n\n\n1. Three")).toBe("One\nTwo\n\n1\\. Three");
  });

  it("reads a lone angle bracket as text", () => {
    expect(zoteroCommentMarkdown("a < b and c > d, x<sub>2</sub>")).toBe("a \\< b and c \\> d, x2");
  });
});

describe("annotations in a paper's note", () => {
  const first = annotation({ text: "dense retrieval" });
  const second = annotation({ key: "ANNNOTE1", kind: "note", comment: "Compare", page: 1, pageLabel: "1" });

  it("start a new note below its title and a heading, in Zotero's order", () => {
    const { content, added } = withZoteroAnnotations(null, LOCAL, [first, second], LABELS);
    expect(added).toBe(2);
    const blocks = content.trimEnd().split("\n\n");
    expect(blocks[0]).toBe("# Sparse attention");
    expect(blocks[2]).toBe("## Zotero annotations");
    expect(blocks[3]).toMatch(/^> dense retrieval /);
    expect(blocks[4]).toMatch(/^Compare /);
  });

  it("come in once: a second import adds only the new ones, below what the writer kept", () => {
    const once = withZoteroAnnotations(null, LOCAL, [first], LABELS).content;
    const edited = `${once.trimEnd()}\n\nMy own thought.\n`;
    const again = withZoteroAnnotations(edited, LOCAL, [first, second, second], LABELS);
    expect(again.added).toBe(1);
    expect(again.content.startsWith(edited.trimEnd())).toBe(true);
    expect(again.content.match(/## Zotero annotations/g)).toHaveLength(1);
    expect(again.content.trimEnd().endsWith("annotation=ANNNOTE1)")).toBe(true);
    expect(withZoteroAnnotations(again.content, LOCAL, [first, second], LABELS)).toEqual({ content: again.content, added: 0 });
  });

  it("tell one annotation key from another that begins with it", () => {
    const note = "x [Zotero](zotero://open-pdf/library/items/PDF00001?annotation=ANNHIGH12)";
    expect(withZoteroAnnotations(note, LOCAL, [first], LABELS).added).toBe(1);
  });
});
