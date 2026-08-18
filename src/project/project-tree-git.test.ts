import { describe, expect, it } from "vitest";
import type { GitFileStatus } from "../app-types";
import { toPierreGitStatus } from "./project-tree-git";

describe("project tree Git status", () => {
  it("uses Pierre statuses and maps backend-only states conservatively", () => {
    const files: GitFileStatus[] = [
      { path: "main.tex", status: "modified", staged: false, unstaged: true },
      { path: "figures/result.png", status: "copied", staged: true, unstaged: false },
      { path: "references.bib", status: "conflict", staged: false, unstaged: true },
    ];

    expect(toPierreGitStatus(files)).toEqual([
      { path: "main.tex", status: "modified" },
      { path: "figures/result.png", status: "added" },
      { path: "references.bib", status: "modified" },
    ]);
  });
});
