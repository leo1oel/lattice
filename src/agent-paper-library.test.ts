import { describe, expect, it } from "vitest";
import {
  buildAgentPaperLibrary,
  LATTICE_PAPER_LIBRARY,
  MAX_AGENT_PAPER_LIBRARY_SIZE,
} from "./agent-paper-library";

describe("agent paper library", () => {
  it("shares locally readable papers without adding citation-only entries", () => {
    expect(buildAgentPaperLibrary({
      workspaceRoot: "/tmp/paper",
      papers: [
        {
          arxivId: "1706.03762",
          title: "Attention Is All You Need",
          citationKey: "vaswani2017attention",
          hasFullText: true,
          hasBlog: true,
        },
        {
          arxivId: "2401.00001",
          title: "Overview only",
          hasFullText: false,
          hasBlog: true,
        },
        {
          arxivId: "10.1000/citation-only",
          title: "Citation only",
          hasFullText: false,
          hasBlog: false,
        },
      ],
    })).toEqual({
      type: LATTICE_PAPER_LIBRARY,
      version: 1,
      workspaceRoot: "/tmp/paper",
      papers: [
        {
          title: "Attention Is All You Need",
          arxivId: "1706.03762",
          citationKey: "vaswani2017attention",
          path: ".research/papers/1706.03762/paper.md",
          view: "fulltext",
        },
        {
          title: "Overview only",
          arxivId: "2401.00001",
          path: ".research/papers/2401.00001/blog.md",
          view: "blog",
        },
      ],
    });
  });

  it("bounds the shared catalog even for unusually large projects", () => {
    const snapshot = buildAgentPaperLibrary({
      workspaceRoot: "/tmp/paper",
      papers: Array.from({ length: MAX_AGENT_PAPER_LIBRARY_SIZE + 5 }, (_, index) => ({
        arxivId: String(index),
        title: `Paper ${index}`,
        hasFullText: true,
        hasBlog: false,
      })),
    });

    expect(snapshot.papers).toHaveLength(MAX_AGENT_PAPER_LIBRARY_SIZE);
    expect(snapshot.papers.at(-1)?.title).toBe(
      `Paper ${MAX_AGENT_PAPER_LIBRARY_SIZE - 1}`,
    );
  });
});
