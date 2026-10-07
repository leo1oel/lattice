import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CanvasMode, EditorPosition, PaperSummary, ProjectSnapshot } from "../app-types";
import {
  buildAgentHostContext,
  selectedMarkdownImageProjectPath,
  type AgentHostSelectionImage,
  type AgentHostSurface,
  type AgentPdfDocumentPlace,
} from "../agent/agent-host-context";
import { buildAgentPaperLibrary } from "../agent/agent-paper-library";
import type { OpenSlideContext } from "../editor/presentation/open-slide-bridge";
import { thenUnlessDisposed, useRefState } from "./effect-helpers";
import type { useSynaraHost } from "./use-synara-host";

type SelectionImage = AgentHostSelectionImage & { source: AgentHostSurface };

const DIRECT_IMAGE_TYPES: Array<[RegExp, AgentHostSelectionImage["mimeType"]]> = [
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
];

/**
 * What the embedded agent sees of the workspace, posted to Synara as the host
 * context and paper library snapshots: the one shared text selection (owned by
 * whichever surface — editor, PDF or Paper — last reported it), the surface
 * being worked in, and a readable copy of a selected Markdown image.
 */
export function useAgentContext({ synara, project, papers, agentVisible, workspace }: {
  synara: ReturnType<typeof useSynaraHost>;
  project: ProjectSnapshot | null;
  papers: PaperSummary[];
  agentVisible: boolean;
  workspace: {
    activeFile: string;
    activePaper: PaperSummary | null;
    activePaperPath: string | null;
    canvasMode: CanvasMode;
    paperView: "blog" | "fulltext";
    editorPosition: EditorPosition | null;
    pdfPage: number;
    pdfPageCount: number | null;
    presentation: OpenSlideContext | null;
  };
}) {
  const {
    activeFile, activePaper, activePaperPath, canvasMode, paperView, editorPosition, pdfPage,
    pdfPageCount, presentation,
  } = workspace;
  const [selection, setSelection] = useState("");
  // In split view the editor and PDF both live behind the one shared selection
  // chip. An empty report from one pane must not wipe a live selection the other
  // pane owns, or the chip flickers as they fight. The ref tracks the current owner.
  const [selectionSource, , sourceRef, setSelectionSource] = useRefState<AgentHostSurface | null>(null);
  // A PDF selection made in a project PDF open as a document, rather than in
  // the compiled preview, names that PDF and the page it was made on.
  const [selectionPdfDocument, setSelectionPdfDocument] = useState<AgentPdfDocumentPlace | null>(null);
  const [activeSurface, setActiveSurface] = useState<AgentHostSurface>("editor");
  // A content surface can re-report its DOM selection after Lattice has cleared
  // the one-shot Agent context. Scope that suppression to the original surface
  // so the same text selected in another surface remains valid.
  const dismissedRef = useRef<{ source: AgentHostSurface; text: string } | null>(null);

  const setOwner = useCallback((source: AgentHostSurface | null, text = "", pdfDocument: AgentPdfDocumentPlace | null = null) => {
    setSelection(text);
    setSelectionSource(source);
    setSelectionPdfDocument(pdfDocument);
  }, [setSelectionSource]);
  /** Clear the selection without letting its surface re-report the same text. */
  const dismissSelection = useCallback(() => {
    const source = sourceRef.current;
    dismissedRef.current = source && selection ? { source, text: selection } : null;
    setOwner(null);
  }, [selection, setOwner, sourceRef]);
  /** Forget the selection entirely, as when switching projects. */
  const resetSelection = useCallback(() => {
    dismissedRef.current = null;
    setOwner(null);
  }, [setOwner]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the working surface follows what the canvas shows
    setActiveSurface((current) => {
      if (activePaper) return "paper";
      if (canvasMode === "pdf") return "pdf";
      if (canvasMode === "split") return current === "paper" ? "editor" : current;
      return "editor";
    });
  }, [activePaper, canvasMode]);

  const activateSurface = useCallback((surface: AgentHostSurface) => {
    setActiveSurface(surface);
    const previousSource = sourceRef.current;
    // Pointer and focus capture both run while a block grip focuses the
    // visual editor. Re-activating the surface that already owns the
    // selection must not clear the context that the grip just published.
    if (previousSource === surface) return;
    if (previousSource) dismissSelection();
    else if (dismissedRef.current?.source === surface) dismissedRef.current = null;
  }, [dismissSelection, sourceRef]);

  const reportSelection = useCallback((source: AgentHostSurface, value: string, pdfDocument?: AgentPdfDocumentPlace) => {
    const dismissed = dismissedRef.current;
    if (value && dismissed?.source === source && dismissed.text === value) return;
    if (!value) {
      if (dismissed?.source === source) dismissedRef.current = null;
      if (sourceRef.current === source) setOwner(null);
      return;
    }
    dismissedRef.current = null;
    setActiveSurface(source);
    setOwner(source, value, pdfDocument);
  }, [setOwner, sourceRef]);

  // A selected Markdown image reaches the agent as a file it can read. PNG and
  // JPEG are readable as they are; WebP is converted first.
  const imagePath = useMemo(() => {
    const documentPath = selectionSource === "paper"
      ? activePaperPath
      : selectionSource === "editor" ? editorPosition?.path || activeFile : null;
    return documentPath ? selectedMarkdownImageProjectPath(selection, documentPath) : null;
  }, [activeFile, activePaperPath, editorPosition?.path, selection, selectionSource]);
  const imageEnabled = Boolean(
    imagePath && selectionSource && project?.root && synara.origin && synara.frameMounted && agentVisible,
  );
  const directImage = useMemo<SelectionImage | null>(() => {
    if (!imageEnabled || !imagePath || !selectionSource) return null;
    const mimeType = DIRECT_IMAGE_TYPES.find(([pattern]) => pattern.test(imagePath))?.[1];
    return mimeType ? { source: selectionSource, sourcePath: imagePath, agentReadablePath: imagePath, mimeType } : null;
  }, [imageEnabled, imagePath, selectionSource]);
  const [preparedImage, setPreparedImage] = useState<(SelectionImage & { projectRoot: string }) | null>(null);
  const projectRoot = project?.root;
  useEffect(() => {
    if (!imageEnabled || !imagePath || !selectionSource || !projectRoot || !/\.webp$/i.test(imagePath)) return;
    const preparing = invoke<string>("prepare_latex_figure", { path: imagePath, projectRoot }).catch(() => null);
    return thenUnlessDisposed(preparing, (agentReadablePath) => {
      if (agentReadablePath) setPreparedImage({ source: selectionSource, projectRoot, sourcePath: imagePath, agentReadablePath, mimeType: "image/png" });
    });
  }, [imageEnabled, imagePath, projectRoot, selectionSource]);
  const preparedMatches = preparedImage !== null
    && preparedImage.projectRoot === projectRoot
    && preparedImage.source === selectionSource
    && preparedImage.sourcePath === imagePath;
  const selectionImage = directImage ?? (imageEnabled && preparedMatches ? preparedImage : null);

  const hostContext = useMemo(() => project ? buildAgentHostContext({
    workspaceRoot: project.root, activeFile, editorPosition, activePaper, canvasMode, paperView,
    pdfPage, pdfPageCount, presentation, selection, selectionSource, selectionPdfDocument, selectionImage, activeSurface,
  }) : null, [
    activeFile, activePaper, activeSurface, canvasMode, editorPosition, paperView, pdfPage, pdfPageCount,
    presentation, project, selection, selectionImage, selectionPdfDocument, selectionSource,
  ]);
  const paperLibrary = useMemo(
    () => project ? buildAgentPaperLibrary({ workspaceRoot: project.root, papers }) : null,
    [papers, project],
  );
  // Keep the agent's view of the host (context and paper library) current while it is on screen.
  const { deliverable, latest, postMessage } = synara;
  useLayoutEffect(() => {
    Object.assign(latest.current, { hostContext, paperLibrary });
  }, [hostContext, latest, paperLibrary]);
  useEffect(() => {
    if (!hostContext || !deliverable) return;
    const frame = window.requestAnimationFrame(() => void postMessage(hostContext));
    return () => window.cancelAnimationFrame(frame);
  }, [deliverable, hostContext, postMessage]);
  useEffect(() => {
    if (!paperLibrary || !deliverable) return;
    const frame = window.requestAnimationFrame(() => void postMessage(paperLibrary));
    return () => window.cancelAnimationFrame(frame);
  }, [deliverable, paperLibrary, postMessage]);

  return { selection, selectionSource, reportSelection, activateSurface, dismissSelection, resetSelection };
}
