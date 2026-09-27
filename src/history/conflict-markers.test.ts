import { describe, expect, it } from "vitest";
import {
  conflictHunks,
  hasConflictMarkers,
  parseConflictBlocks,
  resolveConflicts,
} from "./conflict-markers";

const CONFLICTED = [
  "\\section{Intro}",
  "<<<<<<< ours",
  "my sentence",
  "=======",
  "their sentence",
  ">>>>>>> theirs",
  "\\section{End}",
].join("\n");

describe("conflict markers", () => {
  it("splits a file into text and conflict blocks", () => {
    const blocks = parseConflictBlocks(CONFLICTED);
    expect(blocks.map((block) => block.kind)).toEqual(["text", "conflict", "text"]);
    const hunks = conflictHunks(CONFLICTED);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ours).toBe("my sentence");
    expect(hunks[0].theirs).toBe("their sentence");
    expect(hunks[0].line).toBe(2);
  });

  it("reports whether a file still needs a decision", () => {
    expect(hasConflictMarkers(CONFLICTED)).toBe(true);
    expect(hasConflictMarkers("plain text\n")).toBe(false);
  });

  it("keeps either side, or both, and drops the markers", () => {
    const hunk = conflictHunks(CONFLICTED)[0];
    expect(resolveConflicts(CONFLICTED, new Map([[hunk.index, "ours"]])))
      .toBe("\\section{Intro}\nmy sentence\n\\section{End}");
    expect(resolveConflicts(CONFLICTED, new Map([[hunk.index, "theirs"]])))
      .toBe("\\section{Intro}\ntheir sentence\n\\section{End}");
    expect(resolveConflicts(CONFLICTED, new Map([[hunk.index, "both"]])))
      .toBe("\\section{Intro}\nmy sentence\ntheir sentence\n\\section{End}");
  });

  it("leaves undecided conflicts marked so a partial pass is safe", () => {
    const two = [
      "<<<<<<< ours",
      "a1",
      "=======",
      "b1",
      ">>>>>>> theirs",
      "middle",
      "<<<<<<< ours",
      "a2",
      "=======",
      "b2",
      ">>>>>>> theirs",
    ].join("\n");
    const hunks = conflictHunks(two);
    expect(hunks).toHaveLength(2);
    const resolved = resolveConflicts(two, new Map([[hunks[0].index, "ours"]]));
    expect(resolved).toContain("a1");
    expect(resolved).not.toContain("b1");
    // The second one is untouched and still needs a decision.
    expect(hasConflictMarkers(resolved)).toBe(true);
    expect(conflictHunks(resolved)).toHaveLength(1);
  });

  it("drops the diff3 base section Overleaf sync writes instead of keeping it as local text", () => {
    // The shape of the references.bib conflict: Overleaf emptied the file while
    // Lattice appended an entry, so the whole file sits in one diff3 block.
    const diff3 = [
      "<<<<<<< ours",
      "@misc{a,}",
      "",
      "@misc{b,}",
      "||||||| original",
      "@misc{a,}",
      "=======",
      ">>>>>>> theirs",
      "",
    ].join("\n");
    const [hunk] = conflictHunks(diff3);
    expect(hunk.oursLines).toEqual(["@misc{a,}", "", "@misc{b,}"]);
    expect(hunk.theirsLines).toEqual([]);
    expect(resolveConflicts(diff3, new Map([[hunk.index, "ours"]]))).toBe("@misc{a,}\n\n@misc{b,}\n");
    // An empty side resolves to nothing, not to a stray blank line.
    expect(resolveConflicts(diff3, new Map([[hunk.index, "theirs"]]))).toBe("");
    expect(resolveConflicts(diff3, new Map([[hunk.index, "both"]]))).toBe("@misc{a,}\n\n@misc{b,}\n");
    // Undecided spots keep their markers exactly, base section included.
    expect(resolveConflicts(diff3, new Map())).toBe(diff3);
  });

  it("removes a region cleanly when the kept side deleted it", () => {
    const deleted = "keep\n<<<<<<< ours\n=======\ntheirs line\n>>>>>>> theirs\nend";
    const [hunk] = conflictHunks(deleted);
    expect(resolveConflicts(deleted, new Map([[hunk.index, "ours"]]))).toBe("keep\nend");
  });

  it("treats an unterminated marker as ordinary text", () => {
    const broken = "before\n<<<<<<< ours\nstranded\n";
    expect(hasConflictMarkers(broken)).toBe(false);
    expect(resolveConflicts(broken, new Map())).toBe(broken);
  });
});
