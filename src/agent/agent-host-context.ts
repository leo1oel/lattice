import type { CanvasMode, EditorPosition, PaperSummary } from "../app-types";
import type { AgentCommentsCollection } from "./agent-editor-comments";
import { documentRelativeProjectPath } from "../project/document-relative-path";
import { agentPaperPath } from "./agent-paper-library";

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

export interface AgentPresentationContext {
  slideId: string;
  pageIndex: number;
  pageNumber: number;
  totalPages: number;
  slideTitle: string;
  view: "slides" | "assets";
  pagePath: string;
  pendingComments: Array<{ id: string; line: number; ts: string; note: string; hint?: string }>;
  selection: { line: number; column: number; tagName: string; text: string } | null;
  /** Opens this page alone, without editor chrome, for the agent's post-edit screenshot. */
  previewUrl?: string;
  updatedAt: string;
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
    decoded = decodeURIComponent(rawDestination.replace(/\\(.)/g, "$1").split(/[?#]/, 1)[0] ?? "").replace(/\\/g, "/");
  } catch {
    return null;
  }
  const projectPath = documentRelativeProjectPath(decoded, sourcePath);
  return projectPath && AGENT_READABLE_IMAGE_EXTENSION.test(projectPath) ? projectPath : null;
}

const PRESENTATION_AUTHORING_CONTEXT = {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Agent-facing context, not shown in the interface
  nativeEntryPattern: "slides/<deck-id>/index.tsx",
  nativeFormat: "open_slide_tsx",
  skill: "authoring-presentations",
  defaultWhenOutputFormatUnspecified: true,
  unsupportedPptx: true,
  supportsHtmlExport: true,
  supportsPdfExport: true,
  explicitUnsupportedRequestPolicy: "explain_unsupported_offer_native",
} as const;

/** The bounded text selection a surface shares, if it owns the selection. */
type SelectionContext = { selection?: string; selectionOmittedChars?: number };
type ImageSelectionContext = SelectionContext & { selectionImage?: AgentHostSelectionImage };

export interface AgentHostContextSnapshot {
  type: typeof LATTICE_HOST_CONTEXT;
  version: 1;
  capturedAt: string;
  workspaceRoot: string;
  requestId?: string;
  editorComments?: AgentCommentsCollection;
  presentationAuthoring: typeof PRESENTATION_AUTHORING_CONTEXT;
  activeSurface: AgentHostSurface;
  editor?: ImageSelectionContext & { path: string; line: number; column: number };
  presentation?: AgentPresentationContext;
  /** The compiled preview, or the project PDF open as a document (`path`) that owns the selection. */
  pdf?: SelectionContext & { page: number; pageCount: number | null; path?: string };
  paper?: ImageSelectionContext & {
    title: string;
    arxivId: string;
    citationKey?: string;
    path: string;
    view: "blog" | "fulltext";
  };
}

function boundedSelection(value: string): SelectionContext {
  const normalized = value.trim();
  if (!normalized) return {};
  if (normalized.length <= MAX_SELECTION_LENGTH) return { selection: normalized };
  return {
    selection: normalized.slice(0, MAX_SELECTION_LENGTH),
    selectionOmittedChars: normalized.length - MAX_SELECTION_LENGTH,
  };
}

/** A project PDF open as a document, and where in it a selection was made. */
export type AgentPdfDocumentPlace = { path: string; page: number; pageCount: number | null };

export function buildAgentHostContext(input: {
  workspaceRoot: string;
  activeFile: string;
  editorPosition: EditorPosition | null;
  activePaper: PaperSummary | null;
  canvasMode: CanvasMode;
  paperView: "blog" | "fulltext";
  pdfPage: number;
  pdfPageCount: number | null;
  selection: string;
  selectionSource: AgentHostSurface | null;
  /** Set when the PDF selection came from a project PDF open as a document rather than the compiled preview. */
  selectionPdfDocument?: AgentPdfDocumentPlace | null;
  selectionImage?: (AgentHostSelectionImage & { source: AgentHostSurface }) | null;
  presentation?: AgentPresentationContext | null;
  activeSurface: AgentHostSurface;
  now?: () => Date;
}): AgentHostContextSnapshot {
  const bounded = boundedSelection(input.selection);
  const selected = (surface: AgentHostSurface) => (
    input.selectionSource === surface ? bounded : {}
  );
  const selectedImage = (surface: AgentHostSurface) => {
    if (input.selectionSource !== surface || !bounded.selection || input.selectionImage?.source !== surface) return {};
    const { sourcePath, agentReadablePath, mimeType } = input.selectionImage;
    return { selectionImage: { sourcePath, agentReadablePath, mimeType } };
  };
  const envelope = {
    type: LATTICE_HOST_CONTEXT,
    version: 1,
    capturedAt: (input.now ?? (() => new Date()))().toISOString(),
    workspaceRoot: input.workspaceRoot,
    presentationAuthoring: PRESENTATION_AUTHORING_CONTEXT,
  } as const;
  if (input.activePaper) {
    const { title, arxivId, citationKey } = input.activePaper;
    return {
      ...envelope,
      activeSurface: "paper",
      paper: {
        title,
        arxivId,
        ...(citationKey ? { citationKey } : {}),
        path: agentPaperPath(arxivId, input.paperView),
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
        ...selected("editor"),
        ...selectedImage("editor"),
      }
    : undefined;
  const pdfDocument = input.selectionSource === "pdf" ? input.selectionPdfDocument : null;
  const pdf = {
    ...(pdfDocument ? { path: pdfDocument.path } : {}),
    page: Math.max(1, Math.floor(pdfDocument?.page ?? input.pdfPage)),
    pageCount: pdfDocument ? pdfDocument.pageCount : input.pdfPageCount,
    ...selected("pdf"),
  };

  const activeSurface: AgentHostSurface =
    input.activeSurface === "pdf" ? "pdf" : "editor";
  const presentation = input.presentation
    && input.presentation.pagePath === input.activeFile
    ? input.presentation
    : null;
  return {
    ...envelope,
    activeSurface,
    ...(editor ? { editor } : {}),
    ...(presentation ? { presentation } : {}),
    pdf,
  };
}
