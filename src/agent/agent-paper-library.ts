import type { PaperSummary } from "../app-types";

export const LATTICE_PAPER_LIBRARY = "lattice:paper-library";
export const LATTICE_PAPER_LIBRARY_REQUEST = "lattice:request-paper-library";

export const MAX_AGENT_PAPER_LIBRARY_SIZE = 2_000;

interface AgentPaperLibraryEntry {
  title: string;
  arxivId: string;
  citationKey?: string;
  path: string;
  view: "blog" | "fulltext";
}

export interface AgentPaperLibrarySnapshot {
  type: typeof LATTICE_PAPER_LIBRARY;
  version: 1;
  workspaceRoot: string;
  papers: AgentPaperLibraryEntry[];
}

/** The locally cached Markdown view of a paper the Agent can read. */
export function agentPaperPath(arxivId: string, view: "blog" | "fulltext"): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- project-relative file path
  return `.research/papers/${arxivId}/${view === "blog" ? "blog.md" : "paper.md"}`;
}

export function buildAgentPaperLibrary(input: {
  workspaceRoot: string;
  papers: readonly PaperSummary[];
}): AgentPaperLibrarySnapshot {
  const papers = input.papers
    .filter((paper) => paper.hasFullText || paper.hasBlog)
    .slice(0, MAX_AGENT_PAPER_LIBRARY_SIZE)
    .map((paper) => {
      const view = paper.hasFullText ? "fulltext" as const : "blog" as const;
      return {
        title: paper.title,
        arxivId: paper.arxivId,
        ...(paper.citationKey ? { citationKey: paper.citationKey } : {}),
        path: agentPaperPath(paper.arxivId, view),
        view,
      };
    });

  return {
    type: LATTICE_PAPER_LIBRARY,
    version: 1,
    workspaceRoot: input.workspaceRoot,
    papers,
  };
}
