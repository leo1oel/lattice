import type { CanvasMode, EditorPosition, PaperSummary } from "./app-types";
import { normalizeDocRelativeAssetUrl } from "./open-knowledge-core/markdown/resolve-image-url";

export const LATTICE_HOST_CONTEXT = "lattice:host-context";
export const LATTICE_HOST_CONTEXT_REQUEST = "lattice:request-host-context";
export const LATTICE_HOST_CONTEXT_SELECTION_CLEAR =
  "lattice:clear-host-context-selection";

const MAX_SELECTION_LENGTH = 12_000;
const MARKDOWN_IMAGE = /^!\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<([^>\n]*)>|((?:\\.|[^()\s])+))(?:\s+(?:"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\((?:\\.|[^)\n])*\)))?\s*\)$/;
const HTML_IMAGE = /^<img\b[\s\S]*>$/i;
const HTML_IMAGE_SOURCE = /\bsrc\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'=<>`]+))/i;
const AGENT_READABLE_IMAGE_EXTENSION = /\.(?:jpe?g|png|webp)$/i;

export type AgentHostSurface = "editor" | "pdf" | "paper";

export interface AgentHostSelectionImage {
  sourcePath: string;
  agentReadablePath: string;
  mimeType: "image/jpeg" | "image/png";
}

/** Resolve an explicitly selected Markdown image block to its project file. */
export function selectedMarkdownImageProjectPath(
  selection: string,
  sourcePath: string,
): string | null {
  const selected = selection.trim();
  const markdown = MARKDOWN_IMAGE.exec(selected);
  const html = HTML_IMAGE.test(selected) ? HTML_IMAGE_SOURCE.exec(selected) : null;
  const rawDestination = markdown?.[1] ?? markdown?.[2] ?? html?.[1] ?? html?.[2] ?? html?.[3];
  if (!rawDestination) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawDestination.replace(/\\(.)/g, "$1")).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const normalized = normalizeDocRelativeAssetUrl(decoded, sourcePath);
  if (!normalized.startsWith("/") || !AGENT_READABLE_IMAGE_EXTENSION.test(normalized)) {
    return null;
  }
  return normalized.slice(1);
}

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
    selectionImage?: AgentHostSelectionImage;
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
    selectionImage?: AgentHostSelectionImage;
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
  selectionImage?: (AgentHostSelectionImage & { source: AgentHostSurface }) | null;
  activeSurface: AgentHostSurface;
  now?: () => Date;
}): AgentHostContextSnapshot {
  const bounded = boundedSelection(input.selection);
  const selected = (surface: AgentHostSurface) => (
    input.selectionSource === surface ? bounded : {}
  );
  const selectedImage = (surface: AgentHostSurface) => (
    input.selectionSource === surface
      && bounded.selection
      && input.selectionImage?.source === surface
      ? {
          selectionImage: {
            sourcePath: input.selectionImage.sourcePath,
            agentReadablePath: input.selectionImage.agentReadablePath,
            mimeType: input.selectionImage.mimeType,
          },
        }
      : {}
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
        ...selectedImage("paper"),
      },
    };
  }

  const editor = input.activeFile
    ? {
        path: input.editorPosition?.path || input.activeFile,
        line: Math.max(1, Math.floor(input.editorPosition?.line ?? 1)),
        column: Math.max(0, Math.floor(input.editorPosition?.column ?? 0)),
        ...(input.secondaryFile ? { secondaryPath: input.secondaryFile } : {}),
        ...selected("editor"),
        ...selectedImage("editor"),
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
