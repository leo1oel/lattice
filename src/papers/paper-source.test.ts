import { describe, expect, it } from "vitest";
import { canDownloadPaper, isTitleQuery } from "./paper-source";

describe("paper source routing", () => {
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
