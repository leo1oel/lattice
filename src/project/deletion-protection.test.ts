import { describe, expect, it } from "vitest";
import { deletesProtectedPath, deletionProtectedPaths } from "./deletion-protection";

describe("Project tree deletion protection", () => {
  // The main document used to be protected, so its Delete item was missing
  // from the menu, alone or in a multi-selection, and from its folder's.
  it("lets the main document, a file it includes and their folder be deleted", () => {
    const protectedPaths = deletionProtectedPaths({ primaryBibliography: "references.bib" });
    expect(deletesProtectedPath(["main.tex"], protectedPaths)).toBe(false);
    expect(deletesProtectedPath(["main.tex", "sections/intro.tex"], protectedPaths)).toBe(false);
    expect(deletesProtectedPath(["paper"], deletionProtectedPaths({ primaryBibliography: "refs/library.bib" }))).toBe(false);
  });

  it("keeps the primary bibliography and the folder holding it", () => {
    const protectedPaths = deletionProtectedPaths({ primaryBibliography: "refs/library.bib" });
    expect(deletesProtectedPath(["refs/library.bib"], protectedPaths)).toBe(true);
    expect(deletesProtectedPath(["main.tex", "refs"], protectedPaths)).toBe(true);
    expect(deletesProtectedPath(["ref"], protectedPaths)).toBe(false);
  });

  it("protects nothing in a project without a bibliography", () => {
    expect(deletionProtectedPaths({ primaryBibliography: "" })).toEqual([]);
    expect(deletionProtectedPaths(undefined)).toEqual([]);
  });
});
