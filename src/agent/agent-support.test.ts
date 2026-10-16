import { describe, expect, it } from "vitest";
import type { LiteratureHit } from "../papers/literature-discovery-panel";
import {
  anchorSupport, claimContext, parseSupportReply, parseTermsReply, plainClaim, supportPapers, supportPrompt, supportTermsPrompt,
} from "./agent-support";

const JAIN = "Attention mechanisms have seen wide adoption in neural NLP models. "
  + "We find that learned attention weights are frequently uncorrelated with gradient-based measures of feature importance, "
  + "and one can identify very different attention distributions that nonetheless yield equivalent predictions. "
  + "Our findings show that standard attention modules do not provide meaningful explanations.";
const hit = (title: string, abstract: string | null, extra: Partial<LiteratureHit> = {}): LiteratureHit => ({
  source: "openalex", title, authors: ["A. Author"], year: 2019, abstract, ...extra,
});

describe("the claim as it reads", () => {
  it("drops citations, labels and comments, unwraps formatting, and typesets quotes and dashes", () => {
    expect(plainClaim("Attention maps are \\emph{not} explanations~\\citep{jain2019} % TODO\n -- see ``faithfulness''\\label{x}."))
      .toBe("Attention maps are not explanations – see “faithfulness”.");
    expect(plainClaim("A 50\\% gain \\textbf{\\emph{always}}.")).toBe("A 50% gain always.");
  });

  it("reads the paragraph around the claim, never across a blank line", () => {
    const source = "Earlier paragraph.\n\nThe sentence before. The claim itself. The one after.\n\nNext paragraph.";
    const from = source.indexOf("The claim");
    expect(claimContext(source, from, from + "The claim itself.".length)).toBe("The sentence before. The claim itself. The one after.");
  });
});

describe("asking the agent", () => {
  it("asks for English keywords and reads the last marked answer", () => {
    expect(supportTermsPrompt({ claim: "C", context: "P" })).toContain("<claim>C</claim>");
    expect(parseTermsReply("Thinking…\n<terms>attention\n \"explanation\" faithfulness</terms>")).toBe("attention explanation faithfulness");
    expect(parseTermsReply("<terms> </terms>")).toBeNull();
  });

  it("sends only papers with an abstract, numbered, and reads its judgements", () => {
    const papers = supportPapers([hit("No abstract", null), hit("Attention is not Explanation", JAIN), hit("Blank", "  ")]);
    expect(papers.map((paper) => [paper.id, paper.hit.title])).toEqual([["p1", "Attention is not Explanation"]]);
    const prompt = supportPrompt({ claim: "Attention is not explanation.", context: "…", papers });
    expect(prompt).toContain("<paper id=\"p1\" year=\"2019\">");
    expect(prompt).toContain(`<abstract>${JAIN}</abstract>`);
    expect(parseSupportReply("<support>{\"papers\":[{\"id\":\"p1\",\"signal\":\"supports\",\"passage\":\"x\"},{\"id\":\"p2\",\"signal\":\"maybe\",\"passage\":\"y\"},{\"id\":\"p3\"}]}</support>"))
      .toEqual([{ id: "p1", signal: "supports", passage: "x" }, { id: "p2", signal: "mixed", passage: "y" }]);
    expect(parseSupportReply("no json here")).toBeNull();
    expect(parseSupportReply("{\"verdict\": 1}")).toBeNull();
  });
});

describe("holding the answer to the abstracts", () => {
  const papers = supportPapers([
    hit("Attention is not Explanation", JAIN, { doi: "10.18653/v1/n19-1357", venue: "NAACL" }),
    hit("Is Attention Interpretable?", "While attention noisily predicts input components' overall importance to a model, it is by no means a fail-safe indicator.", { arxivId: "1906.03731" }),
  ]);

  it("finds each passage in its abstract, loosely spaced or verbatim, and drops the rest", () => {
    const { candidates, dropped } = anchorSupport([
      { id: "p1", signal: "supports", passage: "learned attention weights are frequently uncorrelated with gradient-based  measures of feature importance," },
      { id: "p2", signal: "mixed", passage: "Attention is always a faithful explanation." },
      { id: "p9", signal: "supports", passage: "anything" },
      { id: "p1", signal: "supports", passage: "Attention mechanisms have seen wide adoption" },
    ], papers);
    expect(dropped).toBe(3);
    expect(candidates).toHaveLength(1);
    const [jain] = candidates;
    expect(jain).toMatchObject({ id: "p1", signal: "supports", venue: "NAACL", doi: "10.18653/v1/n19-1357", page: "https://doi.org/10.18653/v1/n19-1357" });
    expect(jain.abstract.slice(jain.passage.from, jain.passage.to))
      .toBe("learned attention weights are frequently uncorrelated with gradient-based measures of feature importance,");
  });
});
