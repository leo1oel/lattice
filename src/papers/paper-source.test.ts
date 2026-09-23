import { describe, expect, it } from "vitest";
import { canDownloadPaper, isTitleQuery, paperPdfUrl, paperSourceCitation } from "./paper-source";

describe("paper source routing", () => {
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
