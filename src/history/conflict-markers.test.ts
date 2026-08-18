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

  it("treats an unterminated marker as ordinary text", () => {
    const broken = "before\n<<<<<<< ours\nstranded\n";
    expect(hasConflictMarkers(broken)).toBe(false);
    expect(resolveConflicts(broken, new Map())).toBe(broken);
  });
});
