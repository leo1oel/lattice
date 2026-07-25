import { describe, expect, it } from "vitest";
import { changedFiles, isBinaryDiff, textFromDiffChunks } from "./overleaf-history-diff";
import type { OverleafFileEntry } from "./overleaf-history-types";

describe("isBinaryDiff", () => {
  it("narrows the binary half of the union", () => {
    expect(isBinaryDiff({ binary: true })).toBe(true);
  });

  it("narrows the chunk-array half", () => {
    expect(isBinaryDiff([{ u: "same\n" }])).toBe(false);
  });
});

describe("textFromDiffChunks", () => {
  it("reconstructs the before and after text from a run of chunks", () => {
    const result = textFromDiffChunks("main.tex", [
      { u: "intro\n" },
      { d: "old claim\n" },
      { i: "new claim\n" },
      { u: "conclusion\n" },
    ]);
    expect(result).toEqual({
      path: "main.tex",
      before: "intro\nold claim\nconclusion\n",
      after: "intro\nnew claim\nconclusion\n",
    });
  });

  it("handles a pure addition (no before text)", () => {
    const result = textFromDiffChunks("new.tex", [{ i: "brand new file\n" }]);
    expect(result.before).toBe("");
    expect(result.after).toBe("brand new file\n");
  });
});

describe("changedFiles", () => {
  it("keeps entries that have an operation and drops the ones that don't", () => {
    const entries: OverleafFileEntry[] = [
      { pathname: "main.tex", operation: "edited" },
      // No `operation`: present unchanged for the whole range, not part of this update.
      { pathname: "refs.bib" },
      { pathname: "figs/loss.png", operation: "added" },
    ];
    expect(changedFiles(entries)).toEqual([
      { pathname: "main.tex", operation: "edited" },
      { pathname: "figs/loss.png", operation: "added" },
    ]);
  });

  it("returns nothing when every file in range was unchanged", () => {
    const entries: OverleafFileEntry[] = [{ pathname: "main.tex" }, { pathname: "refs.bib" }];
    expect(changedFiles(entries)).toEqual([]);
  });
});
