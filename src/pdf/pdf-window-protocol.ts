/**
 * What the compiled PDF's separate window and the workspace window that owns
 * it say to each other (`src-tauri/src/pdf_window.rs`).
 *
 * The owner keeps the build, SyncTeX and the documents: it sends the window
 * the state the PDF panel would render from (`PdfWindowState`), again
 * whenever that changes, and the window reads the compiled PDF itself when
 * the state names a new one. The window sends back what the reader does that
 * only the owner can carry out (`PdfWindowAction`), each signed with its
 * label, so a window the owner has since replaced is not heard.
 */
import type { PdfFileViewState, SyncTexWord } from "../app-types";
import type { CitationInfo } from "../editor/latex/latex-text";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { PdfSyncTarget } from "./pdf-source-targets";

/** Owner → window, addressed to the window's label. */
export const PDF_WINDOW_STATE_EVENT = "pdf-window:state";
/** Window → owners: every workspace window hears it and keeps its own window's. */
export const PDF_WINDOW_ACTION_EVENT = "pdf-window:action";
/** Backend → owner: the writer closed the window (its close button, ⌘W). */
export const PDF_WINDOW_CLOSED_EVENT = "pdf-window-closed";
/** Backend → owner: the window moved or was resized, to where (`PdfWindowFrame`). */
export const PDF_WINDOW_FRAME_EVENT = "pdf-window-frame";

export type PdfWindowState = {
  projectRoot: string;
  /**
   * Names the compiled PDF the owner shows, changing with each build that
   * changes it; null while there is none. The window reads the PDF again
   * (`read_compiled_pdf`) when this changes.
   */
  pdfKey: string | null;
  syncTarget: PdfSyncTarget | null;
  canForwardSync: boolean;
  locatingPdf: boolean;
  building: boolean;
  buildShortcut?: string;
  citations: CitationInfo[];
  /** The citations whose paper or source the owner can open. */
  openableCitations: string[];
  outline: { nodes: OutlineNode[]; activeId: string | null; available: boolean };
  /** Where the PDF was last read (zoom, page, scroll), for the viewer to start from. */
  viewState?: PdfFileViewState;
};

export type PdfWindowAction = { window: string } & (
  /** The window's page is listening: send it the state. */
  | { kind: "ready" }
  | { kind: "forward-sync" }
  | { kind: "source"; page: number; x: number; y: number; word: SyncTexWord | null }
  | { kind: "build" }
  /** Return to workspace. */
  | { kind: "dock" }
  | { kind: "citation"; key: string; page?: number }
  | { kind: "outline"; path: string; line: number }
  | { kind: "page-count"; count: number | null }
  | { kind: "page"; page: number }
  | { kind: "view-state"; state: PdfFileViewState }
  | { kind: "select"; text: string }
);

/** What the owner does for each action. */
export type PdfWindowHandlers = {
  ready: () => void;
  forwardSync: () => void;
  source: (page: number, x: number, y: number, word: SyncTexWord | null) => void;
  build: () => void;
  dock: () => void;
  openCitation: (key: string, page?: number) => void;
  navigateOutline: (path: string, line: number) => void;
  pageCount: (count: number | null) => void;
  page: (page: number) => void;
  viewState: (state: PdfFileViewState) => void;
  select: (text: string) => void;
};

/**
 * Carry out `action` when it comes from `window`, the owner's current
 * window; answers whether it did. A citation is opened only when the owner
 * could open it, as the docked PDF offers it only then.
 */
export function runPdfWindowAction(
  action: PdfWindowAction, window: string | null, handlers: PdfWindowHandlers, canOpenCitation: (key: string) => boolean,
): boolean {
  if (!window || action.window !== window) return false;
  switch (action.kind) {
    case "ready": handlers.ready(); break;
    case "forward-sync": handlers.forwardSync(); break;
    case "source": handlers.source(action.page, action.x, action.y, action.word); break;
    case "build": handlers.build(); break;
    case "dock": handlers.dock(); break;
    case "citation":
      if (!canOpenCitation(action.key)) return false;
      handlers.openCitation(action.key, action.page);
      break;
    case "outline": handlers.navigateOutline(action.path, action.line); break;
    case "page-count": handlers.pageCount(action.count); break;
    case "page": handlers.page(action.page); break;
    case "view-state": handlers.viewState(action.state); break;
    case "select": handlers.select(action.text); break;
    default: return false;
  }
  return true;
}
