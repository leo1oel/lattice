import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { bylineOf, parsePastedReferences } from "./paper-add";

describe("bylineOf", () => {
  afterEach(() => activateAppLocale("en"));

  it("joins the parts it has with the comma the interface language writes", async () => {
    await activateAppLocale("en");
    expect(bylineOf(["Hewitt and Liang", " 2019 ", null, "EMNLP"])).toBe("Hewitt and Liang, 2019, EMNLP");
    await activateAppLocale("zh-CN");
    expect(bylineOf(["Hewitt 和 Liang", "2019", undefined, "正在查找…"])).toBe("Hewitt 和 Liang，2019，正在查找…");
  });
});

describe("parsePastedReferences", () => {
  it("reads a mixed paste one reference per line, each work once whatever shape it was pasted in", () => {
    const pasted = [
      "arXiv:1706.03762",
      "  https://arxiv.org/abs/1706.03762v5  ",
      "https://arxiv.org/pdf/1706.03762",
      "10.48550/arXiv.1706.03762",
      "",
      "% a comment",
      "10.1038/S41586-021-03819-2",
      "https://doi.org/10.1038/s41586-021-03819-2",
      "https://aclanthology.org/P19-1356/",
      "Attention is all you need",
      "Attention is all you need",
      "@article{jumper2021, title={Highly accurate protein structure prediction}, year={2021}}",
    ].join("\n");
    expect(parsePastedReferences(pasted).map(({ kind, input }) => [kind, input])).toEqual([
      ["arxiv", "arXiv:1706.03762"],
      ["doi", "10.1038/S41586-021-03819-2"],
      ["url", "https://aclanthology.org/P19-1356/"],
      ["title", "Attention is all you need"],
      ["bibtex", "@article{jumper2021, title={Highly accurate protein structure prediction}, year={2021}}"],
    ]);
  });

  it("keeps distinct works with nearby identifiers apart", () => {
    expect(parsePastedReferences("1706.03762\n1706.03763\n10.1/a\n10.1/b")).toHaveLength(4);
  });
});
