import type { CanvasMode, EditorPosition, PaperSummary } from "./app-types";

export const LATTICE_HOST_CONTEXT = "lattice:host-context";
export const LATTICE_HOST_CONTEXT_REQUEST = "lattice:request-host-context";

const MAX_SELECTION_LENGTH = 12_000;

export type AgentHostSurface = "editor" | "pdf" | "paper";

export interface AgentHostContextSnapshot {
  type: typeof LATTICE_HOST_CONTEXT;
  version: 1;
  workspaceRoot: string;
  activeSurface: AgentHostSurface;
  editor?: {
    path: string;
    line: number;
    column: number;
    secondaryPath?: string;
    selection?: string;
  };
  pdf?: {
    page: number;
    pageCount: number | null;
    selection?: string;
  };
  paper?: {
    title: string;
    arxivId: string;
    citationKey?: string;
    path: string;
    view: "blog" | "fulltext";
    selection?: string;
  };
}

function boundedSelection(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= MAX_SELECTION_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SELECTION_LENGTH)}…`;
}

export function buildAgentHostContext(input: {
  workspaceRoot: string;
  activeFile: string;
  secondaryFile: string | null;
  editorPosition: EditorPosition | null;
  activePaper: PaperSummary | null;
  canvasMode: CanvasMode;
  paperView: "blog" | "fulltext";
  pdfPage: number;
  pdfPageCount: number | null;
  selection: string;
  selectionSource: AgentHostSurface | null;
}): AgentHostContextSnapshot {
  const selection = boundedSelection(input.selection);
  if (input.activePaper) {
    const paperPath = `.research/papers/${input.activePaper.arxivId}/${
      input.paperView === "blog" ? "blog.md" : "paper.md"
    }`;
    return {
      type: LATTICE_HOST_CONTEXT,
      version: 1,
      workspaceRoot: input.workspaceRoot,
      activeSurface: "paper",
      paper: {
        title: input.activePaper.title,
        arxivId: input.activePaper.arxivId,
        ...(input.activePaper.citationKey
          ? { citationKey: input.activePaper.citationKey }
          : {}),
        path: paperPath,
        view: input.paperView,
        ...(input.selectionSource === "paper" && selection ? { selection } : {}),
      },
    };
  }

  const editor = input.editorPosition && input.activeFile
    ? {
        path: input.editorPosition.path || input.activeFile,
        line: Math.max(1, Math.floor(input.editorPosition.line)),
        column: Math.max(0, Math.floor(input.editorPosition.column)),
        ...(input.secondaryFile ? { secondaryPath: input.secondaryFile } : {}),
        ...(input.selectionSource === "editor" && selection ? { selection } : {}),
      }
    : undefined;
  const pdf = {
    page: Math.max(1, Math.floor(input.pdfPage)),
    pageCount: input.pdfPageCount,
    ...(input.selectionSource === "pdf" && selection ? { selection } : {}),
  };

  const activeSurface: AgentHostSurface =
    input.selectionSource === "pdf" ||
    input.canvasMode === "pdf" ||
    (!editor && input.pdfPageCount)
      ? "pdf"
      : "editor";
  return {
    type: LATTICE_HOST_CONTEXT,
    version: 1,
    workspaceRoot: input.workspaceRoot,
    activeSurface,
    ...(editor ? { editor } : {}),
    pdf,
  };
}
