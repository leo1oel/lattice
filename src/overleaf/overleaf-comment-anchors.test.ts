import { describe, expect, it } from "vitest";
import { groupThreadsByFile } from "./overleaf-comment-anchors";

const labels = { currentFile: "In this file", unknownFile: "Another file in this project", orphaned: "No longer in the document" };

/** Anchors keyed by thread id, from `threadId → docId` pairs. */
const anchorsFor = (docs: Record<string, string>) => new Map(Object.entries(docs).map(([threadId, docId]) => [
  threadId, { threadId, docId, position: 10, quote: "state of the art" },
]));

describe("groupThreadsByFile", () => {
  it("puts the open document's threads first, under their own group", () => {
    const groups = groupThreadsByFile(["t1", "t2"], anchorsFor({ t1: "doc-1", t2: "doc-2" }), "doc-1",
      (id) => (id === "doc-2" ? "intro.tex" : null), labels);
    expect(groups).toEqual([
      { key: "here", label: "In this file", threadIds: ["t1"] },
      { key: "doc-2", label: "intro.tex", threadIds: ["t2"] },
    ]);
  });

  it("gives every other file its own group, alphabetical by path rather than discovery order", () => {
    const paths: Record<string, string> = { "doc-a": "chapters/two.tex", "doc-b": "chapters/one.tex" };
    const groups = groupThreadsByFile(["t1", "t2"], anchorsFor({ t1: "doc-a", t2: "doc-b" }), null, (id) => paths[id] ?? null, labels);
    expect(groups.map((group) => [group.label, group.threadIds])).toEqual([["chapters/one.tex", ["t2"]], ["chapters/two.tex", ["t1"]]]);
  });

  it("sorts files whose path is not known yet after every named file", () => {
    const groups = groupThreadsByFile(["t1", "t2"], anchorsFor({ t1: "doc-unknown", t2: "doc-known" }), null,
      (id) => (id === "doc-known" ? "known.tex" : null), labels);
    expect(groups.map((group) => group.label)).toEqual(["known.tex", "Another file in this project"]);
  });

  it("files a thread with no anchor at all as orphaned, last, and omits empty groups", () => {
    const groups = groupThreadsByFile(["t1", "t2"], anchorsFor({ t1: "doc-1" }), "doc-1", () => null, labels);
    expect(groups).toEqual([
      { key: "here", label: "In this file", threadIds: ["t1"] },
      { key: "orphaned", label: "No longer in the document", threadIds: ["t2"] },
    ]);
    expect(groupThreadsByFile([], new Map(), "doc-1", () => null, labels)).toEqual([]);
  });
});
