import type { CanvasMode, EditorPosition, PaperSummary } from "./app-types";

export const LATTICE_HOST_CONTEXT = "lattice:host-context";
export const LATTICE_HOST_CONTEXT_REQUEST = "lattice:request-host-context";
export const LATTICE_HOST_CONTEXT_SELECTION_CLEAR =
  "lattice:clear-host-context-selection";

const MAX_SELECTION_LENGTH = 12_000;

export type AgentHostSurface = "editor" | "pdf" | "paper";

export interface AgentHostContextSnapshot {
  type: typeof LATTICE_HOST_CONTEXT;
  version: 1;
  capturedAt: string;
  workspaceRoot: string;
  activeSurface: AgentHostSurface;
  editor?: {
    path: string;
    line: number;
    column: number;
    secondaryPath?: string;
    selection?: string;
    selectionOmittedChars?: number;
  };
  pdf?: {
    page: number;
    pageCount: number | null;
    selection?: string;
    selectionOmittedChars?: number;
  };
  paper?: {
    title: string;
    arxivId: string;
    citationKey?: string;
    path: string;
    view: "blog" | "fulltext";
    selection?: string;
    selectionOmittedChars?: number;
  };
}

function boundedSelection(value: string): { selection?: string; selectionOmittedChars?: number } {
  const normalized = value.trim();
  if (!normalized) return {};
  if (normalized.length <= MAX_SELECTION_LENGTH) return { selection: normalized };
  return {
    selection: normalized.slice(0, MAX_SELECTION_LENGTH),
    selectionOmittedChars: normalized.length - MAX_SELECTION_LENGTH,
  };
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
  activeSurface: AgentHostSurface;
  now?: () => Date;
}): AgentHostContextSnapshot {
  const bounded = boundedSelection(input.selection);
  const selected = (surface: AgentHostSurface) => (
    input.selectionSource === surface ? bounded : {}
  );
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();
  if (input.activePaper) {
    const paperPath = `.research/papers/${input.activePaper.arxivId}/${
      input.paperView === "blog" ? "blog.md" : "paper.md"
    }`;
    return {
      type: LATTICE_HOST_CONTEXT,
      version: 1,
      capturedAt,
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
        ...selected("paper"),
      },
    };
  }

  const editor = input.editorPosition && input.activeFile
    ? {
        path: input.editorPosition.path || input.activeFile,
        line: Math.max(1, Math.floor(input.editorPosition.line)),
        column: Math.max(0, Math.floor(input.editorPosition.column)),
        ...(input.secondaryFile ? { secondaryPath: input.secondaryFile } : {}),
        ...selected("editor"),
      }
    : undefined;
  const pdf = {
    page: Math.max(1, Math.floor(input.pdfPage)),
    pageCount: input.pdfPageCount,
    ...selected("pdf"),
  };

  const activeSurface: AgentHostSurface =
    input.activeSurface === "pdf" ? "pdf" : "editor";
  return {
    type: LATTICE_HOST_CONTEXT,
    version: 1,
    capturedAt,
    workspaceRoot: input.workspaceRoot,
    activeSurface,
    ...(editor ? { editor } : {}),
    pdf,
  };
}
