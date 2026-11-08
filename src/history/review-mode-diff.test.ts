import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
  acceptedBase, advancedBase, rejectAllEdits, rejectEdit, reviewChanges, reviewHunks,
} from "./review-mode-diff";

const textOf = (text: string) => Text.of(text.split("\n"));
const apply = (text: string, edits: { from: number; to: number; insert: string }[]) =>
  ChangeSet.of(edits, text.length).apply(textOf(text)).toString();

describe("review mode's changes", () => {
  it("finds nothing when the text is the base", () => {
    expect(reviewHunks("Same text.\n", "Same text.\n")).toEqual([]);
  });

  it("marks a corrected word, not its whole line", () => {
    const base = "\\section{Intro}\nAttention lets a decoder look at encoder states.\nMore.\n";
    const current = "\\section{Intro}\nAttention lets a decoder retrieve encoder states.\nMore.\n";
    const hunks = reviewHunks(base, current);
    expect(hunks).toHaveLength(1);
    const changes = reviewChanges(base, current, hunks);
    expect(changes.map(({ deletion, text }) => ({ deletion, text }))).toEqual([
      { deletion: true, text: "look at" },
      { deletion: false, text: "retrieve" },
    ]);
    // Both sit where the replacement is: the deletion struck before the insertion.
    expect(changes[0]!.position).toBe(current.indexOf("retrieve"));
    expect(changes[1]!.position).toBe(current.indexOf("retrieve"));
  });

  it("keeps changes in distant paragraphs apart", () => {
    const base = "One two three.\n\nFour five six.\n";
    const current = "One 2 three.\n\nFour five 6.\n";
    expect(reviewChanges(base, current, reviewHunks(base, current)).filter((change) => !change.deletion).map((change) => change.text))
      .toEqual(["2", "6"]);
  });

  it("reads Chinese a character at a time", () => {
    const base = "我们提出了一种新方法。\n";
    const current = "我们提出了一种简单方法。\n";
    const changes = reviewChanges(base, current, reviewHunks(base, current));
    expect(changes.map((change) => change.text)).toEqual(["新", "简单"]);
  });

  it("marks an equation and a figure caption edited in place", () => {
    const base = "\\begin{equation}\nE = mc^2\n\\end{equation}\n\\caption{Old results.}\n";
    const current = "\\begin{equation}\nE = mc^3\n\\end{equation}\n\\caption{New results.}\n";
    const inserted = reviewChanges(base, current, reviewHunks(base, current)).filter((change) => !change.deletion);
    expect(inserted.map((change) => change.text)).toEqual(["3", "New"]);
  });

  it("accepts a replacement into the base and rejects it out of the text", () => {
    const base = "We look at states.\nThen more.\n";
    const current = "We retrieve states.\nThen more.\n";
    const [hunk] = reviewHunks(base, current);
    // Accepted, the base reads as the text there, and nothing is left to review.
    const accepted = acceptedBase(base, current, hunk!);
    expect(accepted).toBe(current);
    expect(reviewHunks(accepted, current)).toEqual([]);
    // Rejected, the text reads as the base there.
    expect(apply(current, [rejectEdit(base, hunk!)])).toBe(base);
  });

  it("accepts one change of several and leaves the others waiting", () => {
    const base = "Alpha beta.\n\nGamma delta.\n";
    const current = "Alpha BETA.\n\nGamma DELTA.\n";
    const [first, second] = reviewHunks(base, current);
    const accepted = acceptedBase(base, current, first!);
    expect(accepted).toBe("Alpha BETA.\n\nGamma delta.\n");
    expect(reviewChanges(accepted, current, reviewHunks(accepted, current)).map((change) => change.text)).toEqual(["delta", "DELTA"]);
    const rejected = apply(current, [rejectEdit(base, second!)]);
    expect(reviewChanges(base, rejected, reviewHunks(base, rejected)).map((change) => change.text)).toEqual(["beta", "BETA"]);
  });

  it("rejects every change at once back to the base", () => {
    const base = "Alpha beta.\n\nGamma delta.\n\nEpsilon.\n";
    const current = "Alpha BETA.\n\nGamma.\n\nEpsilon zeta.\n\nNew paragraph.\n";
    expect(apply(current, rejectAllEdits(base, reviewHunks(base, current)))).toBe(base);
  });

  it("carries a co-author's edit into the base instead of marking it as the writer's", () => {
    const base = "The model is fast.\nIt is small.\n";
    // The writer changed "fast" to "quick".
    const before = "The model is quick.\nIt is small.\n";
    // A co-author then changed "small" to "tiny".
    const remote = ChangeSet.of([{ from: before.indexOf("small"), to: before.indexOf("small") + 5, insert: "tiny" }], before.length);
    const after = remote.apply(textOf(before)).toString();
    const advanced = advancedBase(base, before, reviewHunks(base, before), remote);
    expect(advanced).toEqual({ base: "The model is fast.\nIt is tiny.\n", touched: false });
    // Only the writer's change is still tracked.
    expect(reviewChanges(advanced.base, after, reviewHunks(advanced.base, after)).map((change) => change.text)).toEqual(["fast", "quick"]);
  });

  it("keeps a co-author's words typed inside the writer's insertion when that insertion is rejected", () => {
    const base = "Results.\n";
    const before = "Results are strong.\n";
    const at = before.indexOf("strong");
    const remote = ChangeSet.of([{ from: at, insert: "very " }], before.length);
    const after = remote.apply(textOf(before)).toString();
    const advanced = advancedBase(base, before, reviewHunks(base, before), remote);
    expect(advanced.touched).toBe(true);
    expect(advanced.base).toContain("very ");
    const rejected = apply(after, rejectAllEdits(advanced.base, reviewHunks(advanced.base, after)));
    expect(rejected).toBe(advanced.base);
    expect(rejected).toContain("very");
  });
});
