import { describe, expect, it } from "vitest";
import { engineSchema } from "../editor/markdown/engine/engine-schema";
import { openMarkdown } from "../editor/markdown/engine/markdown-document";
import {
  canDownloadPaper, citationSourceUrl, findPaperSource, isTitleQuery, paperPdfUrl, paperSourceCitation, paperSourceHref,
  sourceLinkMarkdown, sourceQuoteAnchors, sourceQuoteMarkdown,
} from "./paper-source";
import { findSourceQuote } from "./source-quote";

describe("paper source routing", () => {
  it("opens bibliography web identities but rejects unsafe and credential-bearing URLs", () => {
    expect(citationSourceUrl({ url: "https://publisher.test/paper", doi: "10.1234/fallback" })).toBe("https://publisher.test/paper");
    expect(citationSourceUrl({ doi: "10.1234/a#b?c" })).toBe("https://doi.org/10.1234/a%23b%3Fc");
    expect(citationSourceUrl({ url: "broken", arxivId: "1706.03762" })).toBe("https://arxiv.org/pdf/1706.03762");
    for (const url of ["javascript:alert(1)", "file:///private/paper.pdf", "https://user:secret@example.test/paper", "data:text/html,paper"]) {
      expect(citationSourceUrl({ url })).toBeNull();
    }
    expect(citationSourceUrl({ doi: "not a DOI" })).toBeNull();
    expect(citationSourceUrl()).toBeNull();
  });

  it("preserves direct PDF URL fragments but ignores them for source identity", () => {
    const paper = { arxivId: "web-abc", url: "https://example.test/report.PDF?download=1#page=2" };
    expect(paperPdfUrl(paper)).toBe(paper.url);
    expect(paperSourceCitation(paper, "https://example.test/report.PDF?download=1#page=8", "First … Last"))
      .toEqual({ page: 8, first: "First", last: "Last" });
    expect(paperSourceCitation(paper, "https://example.test/report.PDF?download=2#page=8", "First … Last")).toBeNull();
  });

  it("resolves AlphaXiv PDFs without treating unrelated webpages as papers", () => {
    expect(paperPdfUrl({ arxivId: "web-abc", url: "https://www.alphaxiv.org/abs/2609.report" })).toBe("https://www.alphaxiv.org/abs/2609.report.pdf");
    expect(paperPdfUrl({ arxivId: "web-abc", url: "https://alphaxiv.org/pdf/2609.reportv2" })).toBe("https://www.alphaxiv.org/abs/2609.reportv2.pdf");
    expect(paperPdfUrl({ arxivId: "1706.03762v2" })).toBe("https://arxiv.org/pdf/1706.03762v2");
    expect(paperPdfUrl({ arxivId: "web-abc", url: "https://other.test/abs/2609.report" })).toBeNull();
    expect(paperPdfUrl({ arxivId: "web-abc", url: "https://alphaxiv.org.evil.test/abs/2609.report" })).toBeNull();
  });

  it("routes only the current work's page citations and retains quote boundaries", () => {
    const paper = { arxivId: "web-abc", url: "https://www.alphaxiv.org/abs/2609.report" };
    expect(paperSourceCitation(paper, `${paper.url}.pdf#page=8`, "First words … Last words"))
      .toEqual({ page: 8, first: "First words", last: "Last words" });
    expect(paperSourceCitation(paper, "https://www.alphaxiv.org/abs/2609.other.pdf#page=8", "First … Last")).toBeNull();
    for (const page of ["0", "-1", "8x", "1.5", "9007199254740992"]) {
      expect(paperSourceCitation(paper, `${paper.url}.pdf#page=${page}`, "First … Last")).toBeNull();
    }
    expect(paperSourceCitation({ arxivId: "1706.03762" }, "https://www.alphaxiv.org/abs/1706.03762.pdf#page=3", ""))
      .toEqual({ page: 3, first: "", last: "" });
  });

  it("reviews titles but preserves explicit imports", () => {
    expect(isTitleQuery("Visual object processing in optic aphasia: A case of semantic access agnosia")).toBe(true);
    for (const query of ["10.1080/02643298708252038", "doi: 10.1080/02643298708252038", "https://example.org/article", "1706.03762", "arxiv:1706.03762", "@article{x, title={Title}}"])
      expect(isTitleQuery(query)).toBe(false);
  });

  it("does not mistake a DOI landing page for full text", () => {
    const paper = { arxivId: "", title: "Visual object processing", hasFullText: false, hasBlog: false };
    expect(canDownloadPaper({ ...paper, doi: "10.1093/neucas/3.3.209-w", url: "https://doi.org/10.1093/neucas/3.3.209-w" })).toBe(false);
    expect(canDownloadPaper({ ...paper, url: "https://doi.org/10.1080/02643298708252038" })).toBe(false);
    expect(canDownloadPaper({ ...paper, doi: "10.1080/02643298708252038", url: "https://publisher.test/article" })).toBe(false);
    expect(canDownloadPaper({ ...paper, doi: "10.1080/02643298708252038", url: "https://repository.test/paper.PDF?download=1" })).toBe(true);
    expect(canDownloadPaper({ ...paper, url: "https://example.org/blog" })).toBe(true);
    expect(canDownloadPaper({ ...paper, arxivId: "1706.03762" })).toBe(true);
    expect(canDownloadPaper(paper)).toBe(false);
  });
});

/** The first link mark in `markdown` as the visual editor reads it. */
function linkOf(markdown: string): { href: string; title: string | null } | undefined {
  const opened = openMarkdown(markdown, engineSchema());
  if ("unavailable" in opened) throw new Error(opened.unavailable);
  let link: { href: string; title: string | null } | undefined;
  opened.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (mark && !link) link = { href: String(mark.attrs.href), title: mark.attrs.title as string | null };
  });
  return link;
}

describe("source links made from a selection", () => {
  const paper = { arxivId: "1706.03762v7", hasFullText: true, hasBlog: false };

  it("links the paper's own PDF at the page, whatever fragment its URL carried", () => {
    expect(paperSourceHref(paper, 5)).toBe("https://arxiv.org/pdf/1706.03762v7#page=5");
    expect(paperSourceHref({ arxivId: "web-abc", url: "https://example.test/report.pdf#page=2" }, 8)).toBe("https://example.test/report.pdf#page=8");
    expect(paperSourceHref({ arxivId: "web-abc", url: "https://example.test/article" }, 1)).toBeNull();
  });

  it("anchors a quote with the fewest edge words that find only it", () => {
    const quote = "the model attends to every position in the input sequence at once and so learns long range structure";
    expect(sourceQuoteAnchors(quote)).toEqual({ first: "the model attends to", last: "learns long range structure" });
    // Four words recur on the page, so the anchors grow until the passage is the only match.
    const page = `the model attends to the left only. ${quote}. the model attends to nothing else; learns long range structure.`;
    const anchors = sourceQuoteAnchors(quote, (first, last) => findSourceQuote(page, first, last) !== null)!;
    expect(anchors.first.split(" ").length).toBeGreaterThan(4);
    expect(findSourceQuote(page, anchors.first, anchors.last)).not.toBeNull();
    // A short quote is its own anchors; unspaced text is anchored by characters.
    expect(sourceQuoteAnchors("Attention is all you need")).toEqual({ first: "Attention is all you need", last: "Attention is all you need" });
    expect(sourceQuoteAnchors("自注意力机制让模型在一次计算中同时关注输入序列的每一个位置从而学到长距离的结构关系"))
      .toEqual({ first: "自注意力机制让模型在", last: "学到长距离的结构关系" });
    expect(sourceQuoteAnchors("   ")).toBeNull();
  });

  it("writes Markdown that the reader's link parser reads back to the same page and quote", () => {
    const anchors = { first: 'the "attention" is', last: "C:\\path [sic]" };
    const href = paperSourceHref(paper, 5)!;
    const markdown = sourceLinkMarkdown("p. 5", href, anchors);
    const link = linkOf(markdown);
    expect(link).toEqual({ href, title: 'the "attention" is … C:\\path [sic]' });
    expect(paperSourceCitation(paper, link!.href, link!.title!)).toEqual({ page: 5, ...anchors });
    // A URL with spaces or parentheses keeps its exact address inside angle brackets.
    const odd = "https://example.test/a (draft).pdf#page=2";
    expect(linkOf(sourceLinkMarkdown("p. 2", odd, { first: "a", last: "b" }))?.href).toBe(odd);
    expect(sourceQuoteMarkdown("  a *starred*\n  line ", "[p. 5](x)")).toBe("> a \\*starred\\* line [p. 5](x)");
  });

  it("finds the library paper a link points into, and only a readable one", () => {
    const unread = { arxivId: "2401.00001", hasFullText: false, hasBlog: false };
    const papers = [unread, paper];
    const href = "https://arxiv.org/pdf/1706.03762v7#page=3";
    expect(findPaperSource(papers, href, "a … b")).toEqual({ paper, citation: { page: 3, first: "a", last: "b" } });
    expect(findPaperSource(papers, "https://arxiv.org/pdf/2401.00001#page=3", "a … b")).toBeNull();
    expect(findPaperSource(papers, "https://arxiv.org/pdf/1706.03762v7", "a … b")).toBeNull();
    expect(findPaperSource(papers, "https://example.test/other.pdf#page=3", "a … b")).toBeNull();
  });
});
