import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { EditorPosition, PdfSyncResponse, SyncTexTarget } from "../app-types";
import { toMessage } from "../app-utils";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import type { TrellisController } from "../trellis/trellis-controller";
import { setError, setWarning, showingErrors } from "./notify";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { OpenDocuments } from "./use-open-documents";

export type SyncTexNavigationDeps = {
  documents: Pick<OpenDocuments,
    "file" | "asset" | "mode" | "text" | "savedText" | "live" | "openFile" | "save" | "scope" | "reveal">;
  captureProjectScope: () => () => boolean;
  /** Where the editor's caret is (the ref is current between renders). */
  editorPosition: EditorPosition | null;
  editorPositionRef: RefObject<EditorPosition | null>;
  build: Pick<ReturnType<typeof useBuildPipeline>, "pdfUrl" | "ensureCompiled">;
  trellis: TrellisController;
};

/**
 * Jumping between the LaTeX source and the PDF through SyncTeX: from the
 * editor's caret (or an outline entry) to its place in the PDF, and from a
 * double-click in the PDF to its source line. A jump is dropped when the
 * writer moves the caret, opens something else or switches projects before
 * it lands; the PDF panel comes back on screen for a forward jump.
 */
export function useSyncTexNavigation(deps: SyncTexNavigationDeps) {
  const { t } = useLingui();
  const { documents, captureProjectScope, editorPosition, editorPositionRef, trellis } = deps;
  const { file: activeFile, asset: activeAsset, mode } = documents;
  const { openFile, save, scope, reveal } = documents;
  const { file: activeFileRef } = documents.live;
  const { pdfUrl, ensureCompiled } = deps.build;
  const forwardSyncGenerationRef = useRef(0);
  const outlineSyncGenerationRef = useRef(0);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);

  // Forward SyncTeX starts from a .tex caret in the editor, not a preview or an asset.
  const forwardSyncPosition = editorPosition && pdfUrl && editorPosition.path.toLocaleLowerCase().endsWith(".tex")
    && (mode === "split" || mode === "pdf") && !activeAsset && editorPosition.path === activeFile
    ? editorPosition : null;

  /**
   * From the caret to its place in the PDF, saving first, and building when
   * the PDF was compiled before the latest change to the project: SyncTeX
   * answers in the lines the PDF was compiled from, so an older map sends
   * the jump to whatever passage used to stand on the caret's line.
   */
  const revealSourceInPdf = useCallback(async () => {
    if (!forwardSyncPosition || locatingPdf) return;
    const position = forwardSyncPosition;
    const requestGeneration = forwardSyncGenerationRef.current + 1;
    forwardSyncGenerationRef.current = requestGeneration;
    const ownsDocuments = scope();
    const isCurrentRequest = () => (
      forwardSyncGenerationRef.current === requestGeneration
      && ownsDocuments()
      && editorPositionRef.current?.path === position.path
      && editorPositionRef.current?.line === position.line
      && editorPositionRef.current?.column === position.column
    );
    setLocatingPdf(true);
    const locate = async () => {
      if (!(await save())) return;
      if (!isCurrentRequest()) return;
      const compiled = await ensureCompiled();
      if (!isCurrentRequest()) return;
      if (!compiled) {
        setWarning(t`The PDF is not compiled from this source yet, so Lattice cannot find the line in it. Fix the build, then try again.`);
        return;
      }
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path: position.path,
        line: position.line,
        column: position.column,
      });
      if (!isCurrentRequest()) return;
      // A jump SyncTeX cannot make is a warning.
      if (!target) {
        setWarning(t`This source line has no matching position in the PDF.`);
        return;
      }
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      reveal("pdf");
    };
    await locate().catch((reason: unknown) => {
      if (!isCurrentRequest()) return;
      const message = toMessage(reason);
      if (message === "This bibliography entry is not included in the compiled PDF.") setWarning(message);
      else setError(message);
    }).finally(() => {
      if (forwardSyncGenerationRef.current === requestGeneration) setLocatingPdf(false);
    });
  }, [
    editorPositionRef, ensureCompiled, forwardSyncPosition, locatingPdf, reveal, save, scope, t,
  ]);

  /**
   * Open an outline entry's line, then show the same place in the PDF when
   * SyncTeX knows it, through a PDF compiled from the current source as for
   * a jump from the caret.
   */
  const navigateOutline = useCallback(async (path: string, line: number) => {
    const requestGeneration = outlineSyncGenerationRef.current + 1;
    outlineSyncGenerationRef.current = requestGeneration;
    const ownsProject = captureProjectScope();
    const isCurrentRequest = (checkPosition = true) => (
      outlineSyncGenerationRef.current === requestGeneration
      && ownsProject()
      && activeFileRef.current === path
      && (!checkPosition || (
        editorPositionRef.current?.path === path
        && editorPositionRef.current?.line === line
      ))
    );
    await openFile(path, { line });
    if (!isCurrentRequest(false)) return;
    // The editor's jump stands alone when no build can bring the PDF up to date.
    if (!(await save()) || !isCurrentRequest(false) || !(await ensureCompiled()) || !isCurrentRequest()) return;
    const target = await invoke<PdfSyncResponse | null>("synctex_view", { path, line, column: 0 })
      // The source jump is still useful when this PDF has no SyncTeX map.
      .catch(() => undefined);
    if (target === undefined || !isCurrentRequest()) return;
    if (target) setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
    reveal("pdf");
  }, [activeFileRef, captureProjectScope, editorPositionRef, ensureCompiled, openFile, reveal, save]);

  /** From a double-click in the PDF to its source line. */
  const revealPdfSource = useCallback((page: number, x: number, y: number) => showingErrors(async () => {
    const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
    // A citation resolves into the bibliography, a macro into a .sty. Those
    // files own the whole editor area when opened deliberately, but a jump
    // out of the PDF must keep the preview it was made from on screen.
    await openFile(target.path, { line: target.line, revealSource: false });
    reveal("editor");
  }), [openFile, reveal]);

  // A forward search needs the PDF panel on screen: reopen or reveal it.
  useEffect(() => {
    const ws = trellis.ws;
    if (!ws || !pdfSyncTarget) return;
    const pdf = ws.view("pdf");
    if (!pdf || !pdf.visible) trellis.showPanel("pdf", { focus: false });
  }, [pdfSyncTarget, trellis]);

  return {
    pdfSyncTarget, locatingPdf, canForwardSync: Boolean(forwardSyncPosition),
    revealSourceInPdf, navigateOutline, revealPdfSource,
  };
}
