import { describe, expect, it } from "vitest";
import { changeKind, unifiedDiffLines } from "./history-diff";
import {
  checkKey,
  pathFromCheckKey,
  selectionForSection,
  type GitFileStatus,
} from "./git-panel";

describe("git panel diff helpers", () => {
  it("marks created files and maps after-line numbers for jump targets", () => {
    expect(changeKind(null, "alpha\nbeta\n")).toBe("created");
    const lines = unifiedDiffLines(null, "alpha\nbeta\n");
    expect(lines.filter((line) => line.type === "added")).toHaveLength(2);
    expect(lines[0]?.text).toBe("alpha");
  });

  it("keeps context lines for edited files", () => {
    const lines = unifiedDiffLines("alpha\n", "alpha\nbeta\n");
    expect(lines.some((line) => line.type === "context" && line.text === "alpha")).toBe(true);
    expect(lines.some((line) => line.type === "added" && line.text === "beta")).toBe(true);
  });
});

describe("git panel selection helpers", () => {
  const files: GitFileStatus[] = [
    { path: "main.tex", status: "modified", staged: false, unstaged: true },
    { path: "refs.bib", status: "modified", staged: false, unstaged: true },
  ];

  it("scopes checkbox keys by staged vs unstaged", () => {
    expect(checkKey("main.tex", false)).toBe("u:main.tex");
    expect(checkKey("main.tex", true)).toBe("s:main.tex");
    expect(pathFromCheckKey("u:main.tex")).toBe("main.tex");
  });

  it("reports select-all state for a section", () => {
    const empty = selectionForSection(files, false, new Set());
    expect(empty.all).toBe(false);
    expect(empty.some).toBe(false);
    expect(empty.keys).toEqual(["u:main.tex", "u:refs.bib"]);

    const partial = selectionForSection(files, false, new Set(["u:main.tex"]));
    expect(partial.all).toBe(false);
    expect(partial.some).toBe(true);

    const all = selectionForSection(files, false, new Set(["u:main.tex", "u:refs.bib"]));
    expect(all.all).toBe(true);
    expect(all.some).toBe(false);
  });
});
