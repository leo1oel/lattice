import { describe, expect, it } from "vitest";
import {
  applyProofreadEdits,
  proofreadContext,
  proofreadEditPreview,
  protectedChange,
  reviewProofread,
  type ProofreadEdit,
} from "./proofread-edits";

const none = { before: "", after: "" };
const changes = (original: string, edits: ProofreadEdit[]) => edits.map((edit) => [original.slice(edit.from, edit.to), edit.insert]);

describe("reviewProofread", () => {
  it("splits a suggestion into one edit per corrected word", () => {
    const original = "We beleive teh results.";
    const review = reviewProofread(original, "We believe the results.", none);
    expect(changes(original, review.edits)).toEqual([["beleive", "believe"], ["teh", "the"]]);
    expect(review.held).toEqual([]);
  });

  it("keeps changes inside one run of non-space characters together", () => {
    const original = "methods achieve state of the art results ,which";
    const review = reviewProofread(original, "methods achieves state-of-the-art results, which", none);
    expect(review.edits.map((edit) => proofreadEditPreview(original, edit)).map(({ deleted, inserted }) => [deleted, inserted]))
      .toEqual([["achieve", "achieves"], ["state of the art", "state-of-the-art"], ["results ,which", "results, which"]]);
  });

  it("joins a dropped or added word to the rewording next to it", () => {
    const original = "In this paper we show that it works.";
    const review = reviewProofread(original, "This paper shows that it works.", none);
    expect(review.edits.map((edit) => proofreadEditPreview(original, edit)).map(({ deleted, inserted }) => [deleted, inserted]))
      .toEqual([["In this", "This"], ["we show", "shows"]]);
  });

  it("applies any subset of the edits to the original", () => {
    const original = "We beleive teh results.";
    const { edits } = reviewProofread(original, "We believe the results!", none);
    expect(applyProofreadEdits(original, edits)).toBe("We believe the results!");
    expect(applyProofreadEdits(original, [edits[0]!, edits[2]!])).toBe("We believe teh results!");
    expect(applyProofreadEdits(original, [])).toBe(original);
  });

  it("holds back edits that alter math or citation keys and still offers the prose fix", () => {
    const original = "We beleive $x$ \\cite{a}.";
    const review = reviewProofread(original, "We believe $y$ \\cite{b}.", none);
    expect(changes(original, review.edits)).toEqual([["beleive", "believe"]]);
    expect(review.held.map((edit) => [original.slice(edit.from, edit.to), edit.insert, edit.kind]))
      .toEqual([["x", "y", "math"], ["a", "b", "reference"]]);
  });

  it("holds an edit unsafe throughout as one", () => {
    const original = "on $\\mathcal{D}$ here";
    const review = reviewProofread(original, "on $\\hat{\\mathcal{D}}$ here", none);
    expect(review.edits).toEqual([]);
    expect(review.held.map((edit) => edit.kind)).toEqual(["math"]);
    expect(applyProofreadEdits(original, review.held)).toBe("on $\\hat{\\mathcal{D}}$ here");
  });

  it("splits a joined edit when only part of it touches protected LaTeX", () => {
    const original = "teh$x$";
    const review = reviewProofread(original, "the$y$", none);
    expect(changes(original, review.edits)).toEqual([["teh", "the"]]);
    expect(review.held.map((edit) => edit.kind)).toEqual(["math"]);
  });

  it("holds back a removed escape or comment and a merged paragraph", () => {
    const original = "Our gain was 5\\% % check\nhigh.";
    const review = reviewProofread(original, "Our gain was 5% high.", none);
    expect(review.edits).toEqual([]);
    expect(review.held.length).toBeGreaterThan(0);
    for (const edit of review.held) expect(["command", "comment"]).toContain(edit.kind);
    expect(reviewProofread("One.\n\nTwo teh.", "One. Two the.", none)).toMatchObject({
      edits: [{ insert: "the" }],
      held: [{ insert: " ", kind: "paragraph" }],
    });
  });

  it("offers nothing for an unchanged suggestion", () => {
    expect(reviewProofread("Fine as is.", "Fine as is.", none)).toEqual({ edits: [], held: [] });
  });

  it("reads a selection that starts inside math with its context", () => {
    const doc = "Let $a + b$ hold.";
    const from = doc.indexOf("b$");
    const to = doc.length;
    const context = proofreadContext(doc, from, to);
    expect(context).toEqual({ before: "$a + ", after: "" });
    const original = doc.slice(from, to);
    // Out of context `b$ hold` reads as prose followed by an unclosed math span.
    const review = reviewProofread(original, "c$ holds.", context);
    expect(changes(original, review.edits)).toEqual([["hold", "holds"]]);
    expect(review.held.map((edit) => edit.kind)).toEqual(["math"]);
  });

  it("protects a command name the selection begins against", () => {
    const doc = "\\LaTeX: is great";
    expect(proofreadContext(doc, 6, doc.length)).toEqual({ before: "\\LaTeX", after: "" });
    expect(protectedChange(": is great", "is great", proofreadContext(doc, 6, doc.length))).toBe("command");
  });
});

describe("proofreadEditPreview", () => {
  it("shows a few words of context and makes whitespace-only edits visible", () => {
    const original = "One two three four  five six seven eight.";
    const { edits } = reviewProofread(original, "One two three four five six seven eight.", none);
    expect(proofreadEditPreview(original, edits[0]!)).toEqual({
      before: "…two three four", deleted: "␣", inserted: "", after: " five six seven…",
    });
  });
});
