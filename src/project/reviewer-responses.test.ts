import { describe, expect, it } from "vitest";
import {
  EMPTY_RESPONSES,
  addComments,
  assembleParts,
  commentLabel,
  escapeLatex,
  initiallySkipped,
  nextReviewer,
  normalizePasted,
  parseResponses,
  pastedReviewerNumbers,
  responseLetter,
  responseStatus,
  reviewerNamed,
  splitPastedReviews,
  updateComment,
  type LinkPlace,
  type PastedReviewer,
} from "./reviewer-responses";

function comments(text: string, reviewers: PastedReviewer[] = splitPastedReviews(text)) {
  return reviewers.map((reviewer) => ({
    number: reviewer.number,
    name: reviewer.name,
    comments: assembleParts(text, reviewer.parts, new Set(), initiallySkipped(reviewers)),
  }));
}

describe("splitPastedReviews", () => {
  it("cuts a numbered list into comments and keeps each reviewer's own words", () => {
    const text = normalizePasted("1. The ablation omits the 50% setting.\r\n   It matters for Table 2.\r\n2. Typo in Eq. (3).\r\n");
    expect(comments(text)).toEqual([{
      number: null,
      name: null,
      comments: ["1. The ablation omits the 50% setting.\n   It matters for Table 2.", "2. Typo in Eq. (3)."],
    }]);
  });

  it("splits at reviewer headings and keeps their numbers", () => {
    const text = normalizePasted([
      "Reviewer #1 (score 6):",
      "W1: Missing baselines.",
      "W2: Unclear notation.",
      "",
      "**Reviewer 3**",
      "The method is not compared with X.",
      "",
      "Why is the learning rate fixed?",
      "",
      "审稿人 2：",
      "1、实验不足。",
      "2、写作需改进。",
    ].join("\n"));
    expect(comments(text)).toEqual([
      { number: 1, name: null, comments: ["W1: Missing baselines.", "W2: Unclear notation."] },
      { number: 3, name: null, comments: ["The method is not compared with X.", "Why is the learning rate fixed?"] },
      { number: 2, name: null, comments: ["1、实验不足。", "2、写作需改进。"] },
    ]);
  });

  it("reads OpenReview's reviewer names and proposes leaving out what asks for nothing", () => {
    const text = normalizePasted([
      "Official Review of Submission4211 by Reviewer xK7p",
      "Summary:",
      "The paper proposes a sparse attention scheme.",
      "Strengths:",
      "1. Clear writing.",
      "2. Strong results.",
      "Weaknesses:",
      "1. No latency numbers.",
      "  - especially on GPUs",
      "2. Limited datasets.",
      "Questions:",
      "1. How is k chosen?",
      "Rating: 6",
    ].join("\n"));
    const [reviewer] = splitPastedReviews(text);
    expect(reviewer.name).toBe("xK7p");
    expect(comments(text)[0].comments).toEqual([
      "1. No latency numbers.\n  - especially on GPUs",
      "2. Limited datasets.",
      "1. How is k chosen?",
    ]);
  });

  it("joins parts the writer joins and leaves out the ones they skip", () => {
    const text = normalizePasted("First point.\n\nIts continuation.\n\nSecond point.\n\nThanks.");
    const [{ parts }] = splitPastedReviews(text);
    expect(parts).toHaveLength(4);
    expect(assembleParts(text, parts, new Set([parts[1].start]), new Set([parts[3].start]))).toEqual([
      "First point.\n\nIts continuation.",
      "Second point.",
    ]);
  });
});

describe("numbering", () => {
  it("numbers per reviewer and never gives a removed comment's number again", () => {
    let state = addComments(EMPTY_RESPONSES, [
      { reviewer: 1, comments: ["a", "b"] },
      { reviewer: 2, name: "xK7p", comments: ["c"] },
    ], "t");
    expect(state.comments.map(commentLabel)).toEqual(["R1.1", "R1.2", "R2.1"]);
    state = { ...state, comments: state.comments.filter((comment) => commentLabel(comment) !== "R1.2") };
    state = addComments(state, [{ reviewer: 1, comments: ["d", "  "] }], "t");
    expect(state.comments.map(commentLabel)).toEqual(["R1.1", "R2.1", "R1.3"]);
    expect(nextReviewer(state)).toBe(3);
    expect(reviewerNamed(state, "XK7P")).toBe(2);
  });

  it("survives a round trip through the file and drops what it cannot read", () => {
    const state = addComments(EMPTY_RESPONSES, [{ reviewer: 1, comments: ["a"] }], "t");
    const stored = JSON.parse(JSON.stringify(state));
    expect(parseResponses(stored)).toEqual(state);
    stored.comments.push({ id: "x", reviewer: 0, number: 1, comment: "bad" }, { ...stored.comments[0] });
    stored.comments[0].replyChecked = true;
    expect(parseResponses(stored)?.comments).toEqual([{ ...state.comments[0], replyChecked: false }]);
    expect(parseResponses({ version: 2, comments: [] })).toBeNull();
  });
});

describe("status", () => {
  it("keeps answering and changing apart, and an edited reply has to be checked again", () => {
    let state = addComments(EMPTY_RESPONSES, [{ reviewer: 1, comments: ["a"] }], "t");
    const id = state.comments[0].id;
    expect(responseStatus(state.comments[0])).toBe("unanswered");
    state = updateComment(state, id, { change: "done" });
    expect(responseStatus(state.comments[0])).toBe("unanswered");
    state = updateComment(state, id, { reply: "We added it.", change: "todo" });
    expect(responseStatus(state.comments[0])).toBe("drafted");
    state = updateComment(state, id, { replyChecked: true });
    expect(responseStatus(state.comments[0])).toBe("changing");
    state = updateComment(state, id, { change: "none" });
    expect(responseStatus(state.comments[0])).toBe("done");
    state = updateComment(state, id, { reply: "We added it in §4." });
    expect(state.comments[0].replyChecked).toBe(false);
  });
});

describe("responseLetter", () => {
  const places: Record<number, LinkPlace> = {
    3: { state: "placed", path: "sections/method.tex", line: 42, quote: "We now report 50% sparsity." },
    4: { state: "moved", path: "main.tex", quote: "old text" },
  };
  const placeOf = (annotation: number) => places[annotation] ?? { state: "missing" as const };

  function fixture() {
    let state = addComments(EMPTY_RESPONSES, [
      { reviewer: 2, comments: ["Report 50% sparsity & latency_ms."] },
      { reviewer: 1, name: "xK7p", comments: ["Typo.", "Add a baseline."] },
    ], "t");
    const [r2, r1a, r1b] = state.comments;
    state = updateComment(state, r2.id, { reply: "Done, see \\cref{sec:sparsity}.", replyChecked: true, change: "done", annotations: [3, 4, 9] });
    state = updateComment(state, r1a.id, { reply: "Fixed.", change: "none" });
    state = updateComment(state, r1b.id, { change: "todo" });
    return state;
  }

  it("writes Markdown in reviewer order, opening with what is still open", () => {
    expect(responseLetter(fixture(), "markdown", placeOf)).toBe([
      "# Response to the reviewers",
      "",
      "> **Not yet answered:** R1.2",
      "> **Replies not yet checked:** R1.1",
      "> **Changes still to make:** R1.2",
      "",
      "## Reviewer 1 (xK7p)",
      "",
      "### R1.1",
      "",
      "> Typo.",
      "",
      "**Response.** Fixed.",
      "",
      "### R1.2",
      "",
      "> Add a baseline.",
      "",
      "**Response.** _No response yet._",
      "",
      "**Changes.** _Still to make._",
      "",
      "## Reviewer 2",
      "",
      "### R2.1",
      "",
      "> Report 50% sparsity & latency_ms.",
      "",
      "**Response.** Done, see \\cref{sec:sparsity}.",
      "",
      "**Changes.** `sections/method.tex`, line 42: “We now report 50% sparsity.”; `main.tex` (passage since rewritten): “old text”; annotation 9 (deleted).",
      "",
    ].join("\n"));
  });

  it("escapes the reviewer's words in LaTeX but keeps the reply's LaTeX", () => {
    const letter = responseLetter(fixture(), "latex", placeOf);
    expect(letter).toContain("Report 50\\% sparsity \\& latency\\_ms.");
    expect(letter).toContain("\\noindent\\textbf{Response.} Done, see \\cref{sec:sparsity}.");
    expect(letter).toContain("\\texttt{sections/method.tex}, line 42: ``We now report 50\\% sparsity.''");
    expect(letter).toContain("\\section*{Response to Reviewer 1 (xK7p)}");
    expect(letter.indexOf("Not yet answered")).toBeLessThan(letter.indexOf("\\section*"));
  });

  it("escapes every LaTeX special", () => {
    expect(escapeLatex("\\{}#$%&_^~")).toBe("\\textbackslash{}\\{\\}\\#\\$\\%\\&\\_\\^{}\\textasciitilde{}");
  });
});

describe("pastedReviewerNumbers", () => {
  it("keeps headed numbers, reuses known names and gives new names the lowest free number", () => {
    const state = addComments(EMPTY_RESPONSES, [{ reviewer: 1, name: "aaaa", comments: ["x"] }], "t");
    const pasted: PastedReviewer[] = [
      { number: null, name: null, parts: [] },
      { number: 4, name: null, parts: [] },
      { number: null, name: "AAAA", parts: [] },
      { number: null, name: "bbbb", parts: [] },
      { number: null, name: "bbbb", parts: [] },
    ];
    expect(pastedReviewerNumbers(state, pasted, 2)).toEqual([2, 4, 1, 3, 3]);
  });
});
