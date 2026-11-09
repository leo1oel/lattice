import { describe, expect, it } from "vitest";
import { fixGroup } from "./audit-groups";

const change = (field: string, before: string, after: string) => ({ field, before, after });

describe("fixGroup", () => {
  it("files a preprint's published version and blank fields as published", () => {
    // an2026toward: arXiv preprint to EMNLP Findings.
    expect(fixGroup([
      change("ENTRYTYPE", "misc", "inproceedings"),
      change("booktitle", "", "Findings of the Association for Computational Linguistics: EMNLP (Findings of EMNLP)"),
      change("doi", "", "10.18653/2026.findings-emnlp.220"),
      change("howpublished", "arXiv preprint arXiv:2605.25343", ""),
      change("pages", "", "4594--4644"),
      change("url", "https://arxiv.org/abs/2605.25343", "https://doi.org/10.18653/2026.findings-emnlp.220"),
    ])).toBe("published");
    // merity2016pointer: the preprint's year gives way to ICLR 2017's.
    expect(fixGroup([
      change("ENTRYTYPE", "misc", "inproceedings"),
      change("booktitle", "", "International Conference on Learning Representations (ICLR)"),
      change("howpublished", "arXiv preprint arXiv:1609.07843", ""),
      change("year", "2016", "2017"),
    ])).toBe("published");
    expect(fixGroup([change("pages", "", "8748--8763")])).toBe("published");
    expect(fixGroup([change("url", "https://arxiv.org/abs/2407.06438", "https://openreview.net/forum?id=nuzFG0Rbhy")])).toBe("published");
    // Case and braces alongside a publication stay with it.
    expect(fixGroup([
      change("ENTRYTYPE", "misc", "article"),
      change("journal", "", "Proceedings of the AAAI Conference on Artificial Intelligence"),
      change("title", "PIQA: Reasoning about Physical Commonsense in Natural Language", "{PIQA}: Reasoning about Physical Commonsense in Natural Language"),
    ])).toBe("published");
  });

  it("files braces and case alone as cosmetic", () => {
    expect(fixGroup([change("title", "Try ARC, the AI2 Reasoning Challenge", "Try {ARC}, the {AI2} Reasoning Challenge")])).toBe("cosmetic");
    expect(fixGroup([change("booktitle", "Conference of the North American Chapter", "Conference of the {N}orth {A}merican Chapter")])).toBe("cosmetic");
  });

  it("files a replaced value as disputed", () => {
    expect(fixGroup([change("publisher", "Curran Associates, Inc.", "Neural Information Processing Systems Foundation, Inc. (NeurIPS)")])).toBe("disputed");
    expect(fixGroup([change("pages", "9630--9640", "9650--9660")])).toBe("disputed");
    expect(fixGroup([change("booktitle", "International Conference on Learning Representations (ICLR)", "International Conference on Learning Representations (ICLR) Workshop Track")])).toBe("disputed");
    // A published record retyped, or its year moved, is not a preprint upgrade.
    expect(fixGroup([change("ENTRYTYPE", "inproceedings", "article"), change("journal", "", "Proceedings of the AAAI Conference on Artificial Intelligence")])).toBe("disputed");
    expect(fixGroup([change("year", "2023", "2024")])).toBe("disputed");
    // One disputed change holds back the whole proposal.
    expect(fixGroup([change("pages", "", "1--9"), change("publisher", "IEEE", "Springer")])).toBe("disputed");
  });
});
