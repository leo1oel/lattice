import { describe, expect, it } from "vitest";
import { anchorsByThreadId, groupThreadsByFile, type OverleafCommentAnchor } from "./overleaf-comment-anchors";

function anchor(overrides: Partial<OverleafCommentAnchor> = {}): OverleafCommentAnchor {
  return { threadId: "t1", docId: "doc-1", position: 10, quote: "state of the art", ...overrides };
}

describe("anchorsByThreadId", () => {
  it("keys the project's anchors by their thread id", () => {
    const map = anchorsByThreadId([anchor({ threadId: "t1" }), anchor({ threadId: "t2", docId: "doc-2" })]);
    expect(map.get("t1")?.docId).toBe("doc-1");
    expect(map.get("t2")?.docId).toBe("doc-2");
  });
});

describe("groupThreadsByFile", () => {
  it("puts the open document's threads first, under their own group", () => {
    const anchors = anchorsByThreadId([
      anchor({ threadId: "t1", docId: "doc-1" }),
      anchor({ threadId: "t2", docId: "doc-2" }),
    ]);
    const groups = groupThreadsByFile(["t1", "t2"], anchors, "doc-1", (id) => (id === "doc-2" ? "intro.tex" : null));
    expect(groups[0]).toMatchObject({ key: "here", label: "In this file", threadIds: ["t1"] });
    expect(groups[1]).toMatchObject({ key: "doc-2", label: "intro.tex", threadIds: ["t2"] });
  });

  it("gives every other file its own group instead of lumping them together", () => {
    const anchors = anchorsByThreadId([
      anchor({ threadId: "t1", docId: "doc-a" }),
      anchor({ threadId: "t2", docId: "doc-b" }),
    ]);
    const paths: Record<string, string> = { "doc-a": "chapters/two.tex", "doc-b": "chapters/one.tex" };
    const groups = groupThreadsByFile(["t1", "t2"], anchors, null, (id) => paths[id] ?? null);
    // Alphabetical by path, not by discovery order.
    expect(groups.map((group) => group.label)).toEqual(["chapters/one.tex", "chapters/two.tex"]);
    expect(groups.find((group) => group.label === "chapters/one.tex")?.threadIds).toEqual(["t2"]);
  });

  it("sorts files whose path is not known yet after every named file", () => {
    const anchors = anchorsByThreadId([
      anchor({ threadId: "t1", docId: "doc-unknown" }),
      anchor({ threadId: "t2", docId: "doc-known" }),
    ]);
    const groups = groupThreadsByFile(
      ["t1", "t2"],
      anchors,
      null,
      (id) => (id === "doc-known" ? "known.tex" : null),
    );
    expect(groups.map((group) => group.label)).toEqual(["known.tex", "Another file in this project"]);
  });

  it("files a thread with no anchor at all as orphaned, last, and does not confuse it for another file", () => {
    const anchors = anchorsByThreadId([anchor({ threadId: "t1", docId: "doc-1" })]);
    const groups = groupThreadsByFile(["t1", "t2"], anchors, "doc-1", () => null);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ key: "orphaned", label: "No longer in the document", threadIds: ["t2"] });
  });

  it("omits empty groups rather than rendering headings with nothing under them", () => {
    const groups = groupThreadsByFile([], new Map(), "doc-1", () => null);
    expect(groups).toEqual([]);
  });
});
