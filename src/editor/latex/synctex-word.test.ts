import { describe, expect, it } from "vitest";
import { clickedWordIn, sourceColumnForWord, sourceWords } from "./synctex-word";

/** The clicked word as the PDF reads it: `marker` stands where the double-click landed. */
function clicked(pdfLine: string, marker = "|") {
  const offset = pdfLine.indexOf(marker);
  return clickedWordIn(pdfLine.replace(marker, ""), offset)!;
}

describe("clickedWordIn", () => {
  it("names the word, which of its occurrences on the line it is, and its neighbours", () => {
    expect(clicked("the cat saw |the dog and the bird")).toEqual({
      word: "the", occurrence: 1, count: 3, before: "saw", after: "dog",
    });
    expect(clicked("the cat saw the d|og")).toEqual({ word: "dog", occurrence: 0, count: 1, before: "the", after: null });
  });

  it("reads ligatures, accents and case as the source spells them", () => {
    expect(clicked("a ﬁ|eld near Café")).toMatchObject({ word: "field", before: "a", after: "near" });
    expect(clicked("near Ca|fé")).toMatchObject({ word: "cafe" });
  });

  it("is null on a space or punctuation", () => {
    expect(clickedWordIn("one, two", 3)).toBeNull();
    expect(clickedWordIn("one, two", 4)).toBeNull();
  });
});

describe("sourceWords", () => {
  it("reads the printed words, skipping command names, keys and comments", () => {
    const line = String.raw`As \emph{shown} in~\cite[p.~3]{knuth84}, \textbf{all} works.% not this`;
    expect(sourceWords(line).map((word) => word.key)).toEqual(["as", "shown", "in", "all", "works"]);
    expect(sourceWords(line).map((word) => line.slice(word.from, word.from + 3))).toEqual(["As ", "sho", "in~", "all", "wor"]);
  });

  it("keeps accents and hyphenation points inside their word", () => {
    expect(sourceWords(String.raw`Dvo\v{r}\'ak's na\"{\i}ve hy\-phen`).map((word) => word.key))
      .toEqual(["dvorak", "s", "naive", "hyphen"]);
    expect(sourceWords(String.raw`Caf\'e`).map((word) => word.key)).toEqual(["cafe"]);
  });

  it("separates words at escapes, ties and line breaks", () => {
    expect(sourceWords(String.raw`R\&D 50\% Mr.~Smith one\\two`).map((word) => word.key))
      .toEqual(["r", "d", "50", "mr", "smith", "one", "two"]);
  });
});

describe("sourceColumnForWord", () => {
  const paragraph = String.raw`The model is trained on the corpus. We then evaluate \emph{the} model on the held-out split.`;

  it("lands on a word the line holds once", () => {
    const column = sourceColumnForWord(paragraph, clicked("we then ev|aluate the"));
    expect(paragraph.slice(column!)).toMatch(/^evaluate/);
  });

  it("tells repeated words apart by their neighbours", () => {
    // The PDF line is the middle of the paragraph: its own count of "the" says nothing.
    const column = sourceColumnForWord(paragraph, clicked("evaluate t|he model on"));
    expect(paragraph.slice(column!)).toMatch(/^the} model on the held/);
    const held = sourceColumnForWord(paragraph, clicked("model on |the held-out"));
    expect(paragraph.slice(held!)).toMatch(/^the held-out/);
  });

  it("uses one side when markup on the page has no word in the source", () => {
    const line = String.raw`see the proof \cite{knuth} the result holds, and the rest`;
    // The PDF prints the citation's number where the source names a key.
    const column = sourceColumnForWord(line, clicked("the proof [12] |the result holds"));
    expect(line.slice(column!)).toMatch(/^the result/);
  });

  it("uses the word's place on the line when its neighbours repeat too", () => {
    const line = "a b a b a b";
    const column = sourceColumnForWord(line, clicked("a b |a b a b"));
    expect(column).toBe(4);
  });

  it("falls back to the line when the occurrences cannot be told apart", () => {
    // Only a slice of the source line is on this PDF line, and "a b a" occurs twice in it.
    expect(sourceColumnForWord("x a b a b a y", clicked("a b |a"))).toBeNull();
  });

  it("is null when the word is not on the line", () => {
    expect(sourceColumnForWord("Nothing here.", clicked("some|thing"))).toBeNull();
    // A word hyphenated across PDF lines is only part of the source word.
    expect(sourceColumnForWord("an example", clicked("an ex|am-"))).toBeNull();
  });

  it("ignores words in a comment", () => {
    expect(sourceColumnForWord("Text % draft text", clicked("t|ext"))).toBe(0);
  });
});
