import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CaseSensitive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CornerUpLeft,
  CornerUpRight,
  Download,
  FileText,
  LocateFixed,
  RectangleHorizontal,
  RectangleVertical,
  WholeWord,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PdfLoading } from "./pdf-loading";
import { PdfCitationHover, type PdfCitationProps } from "./pdf-citation-hover";
import { SearchField } from "../components/ui/search-field";
import { MotionButton } from "../components/ui/motion";
import { OverlayScrollbars } from "../components/ui/overlay-scrollbar";
import type { PdfFileViewState } from "../app-types";
import { logAction } from "../telemetry/app-notify";
import { utf8ToBase64 } from "./pdf-bytes";
import type { ViewerRecord } from "./pdf-slick";
import { usePdfSourceTargets, type PdfSourceQuote, type PdfSyncTarget } from "./pdf-source-targets";
import { usePdfSelectionReport } from "./pdf-text-layer-selection";
import { clamp, PDF_MAX_SCALE, PDF_MIN_SCALE, parsePdfZoomPercent } from "./pdf-viewer-utils";
import { pdfSource, usePdfDocument } from "./use-pdf-document";
import { usePdfSearch } from "./use-pdf-search";
import { useLatestRef } from "../hooks/use-latest-ref";
import { usePdfLocationHistory, usePdfViewState, type PdfViewerCallbacks } from "./use-pdf-view";
import { usePdfZoom } from "./use-pdf-zoom";
import "@pdfslick/core/dist/pdf_viewer.css";
import "./pdf-viewer.css";

export type { PdfSourceQuote, PdfSyncTarget };

/** Notification source label for the PDF preview. */
const PDF_SOURCE = "PDF";

/** Focus the PDF surface on pointer down so keyboard shortcuts belong to it. */
function focusPdfSurface(event: ReactPointerEvent<HTMLDivElement>) {
  const target = event.target instanceof Element ? event.target : null;
  const interactiveSelector = ["a", "button", "input", "select", "textarea", `[${"contenteditable"}]`]
    .join(", ");
  if (target?.closest(interactiveSelector)) return;
  event.currentTarget.focus({ preventScroll: true });
}

/** Toolbar toggles must not take focus from the field or editor the reader is using. */
const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

function ToolbarButton({ label, icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: ReactNode;
}) {
  return <Tip label={label}><button type="button" {...props}>{icon}</button></Tip>;
}

/**
 * A toolbar value that reads as text until focused, then edits a draft that is
 * committed on blur (Enter) or, with `cancelOnEscape`, dropped on Escape.
 */
function useDraftInput(
  value: string,
  commit: (draft: string) => void,
  { accept, cancelOnEscape = false }: { accept?: RegExp; cancelOnEscape?: boolean } = {},
) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  return {
    editing: draft !== null,
    draft: draft ?? "",
    inputProps: {
      value: draft ?? value,
      onFocus: (event: FocusEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        cancelledRef.current = false;
        setDraft(value);
        requestAnimationFrame(() => input.select());
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        if (!accept || accept.test(event.target.value)) setDraft(event.target.value);
      },
      onBlur: () => {
        if (!cancelledRef.current) commit(draft ?? "");
        cancelledRef.current = false;
        setDraft(null);
      },
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (cancelOnEscape && event.key === "Escape") {
          cancelledRef.current = true;
          event.currentTarget.blur();
        }
      },
    },
  };
}

export function PdfPreview({
  url,
  pdfBase64,
  pdfBytes = null,
  fileName = "paper.pdf",
  syncTarget = null,
  sourceQuote = null,
  canForwardSync = false,
  locatingPdf = false,
  onForwardSync,
  onLoadError,
  initialPage = 1,
  initialViewState,
  showSave = true,
  saveLabel,
  timeoutMessage,
  outline,
  toolbarStart,
  toolbarEnd,
  citations,
  canOpenCitation,
  onOpenCitation,
  ...callbackProps
}: PdfCitationProps & PdfViewerCallbacks & {
  url: string | null;
  pdfBase64: string | null;
  pdfBytes?: ArrayBuffer | null;
  fileName?: string;
  syncTarget?: PdfSyncTarget | null;
  sourceQuote?: PdfSourceQuote | null;
  canForwardSync?: boolean;
  locatingPdf?: boolean;
  onForwardSync?: () => void;
  onLoadError?: () => void;
  initialPage?: number;
  initialViewState?: PdfFileViewState;
  showSave?: boolean;
  saveLabel?: string;
  timeoutMessage?: string;
  outline?: ReactNode;
  /** Context-specific actions rendered before the page controls. */
  toolbarStart?: ReactNode;
  /** Context-specific icon actions rendered before the save control. */
  toolbarEnd?: ReactNode;
}) {
  const { t } = useLingui();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The active PDFSlick viewer is imperative; the generation is its React-owned
  // signal, bumped whenever staged document replacement promotes a viewer.
  const recordRef = useRef<ViewerRecord | null>(null);
  const [generation, setGeneration] = useState(0);
  const hasActiveViewer = generation > 0;
  // PDF.js owns the scrolling element, so the overlay bars read it through the
  // active record; the generation keys them to re-attach.
  const getScrollViewport = useCallback(() => recordRef.current?.root ?? null, []);
  const callbacks = useLatestRef<PdfViewerCallbacks>(callbackProps);
  const source = pdfSource(url, pdfBase64, pdfBytes);
  const loadKey = source.key;
  const [savingPdf, setSavingPdf] = useState(false);

  const view = usePdfViewState(recordRef, initialViewState, initialPage, callbacks);
  const { pageNumber, scale, fitMode, viewRef, setPageNumber } = view;
  const history = usePdfLocationHistory(recordRef, view);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const search = usePdfSearch(recordRef, generation, loadKey, previewRef, searchInputRef);
  const doc = usePdfDocument({
    hostRef,
    recordRef,
    setGeneration,
    source,
    view,
    history,
    callbacks,
    onFindMatches: search.setMatches,
    timeoutMessage: timeoutMessage ?? t`PDF preview timed out. Click Build again, or open the PDF in Preview.`,
  });
  const { numPages, pdfError } = doc;
  useEffect(() => {
    if (pdfError) onLoadError?.();
  }, [pdfError, onLoadError]);
  usePdfSelectionReport(recordRef, generation, callbacks);
  const { zoomLabelRef, applyManualScale, stepZoom, toggleFit } = usePdfZoom(recordRef, generation, view);
  usePdfSourceTargets(recordRef, {
    syncTarget, sourceQuote, numPages, scale, generation,
    pageRenderGeneration: doc.pageRenderGeneration, textLayerGeneration: doc.textLayerGeneration,
  });

  const goToPage = (nextPage: number) => {
    const slick = recordRef.current?.slick;
    if (!slick || !numPages) return;
    const page = clamp(Math.floor(nextPage), 1, numPages);
    slick.gotoPage(page);
    setPageNumber(page);
  };
  // The step buttons read the page when clicked rather than closing over it, so
  // scrolling through pages does not re-render them and their tooltip trees.
  const stepPage = (delta: 1 | -1) => goToPage(viewRef.current.page + delta);
  const { availability, navigate } = history;
  const pageInput = useDraftInput(String(pageNumber), (draft) => {
    const requested = Number.parseInt(draft, 10);
    if (Number.isFinite(requested)) goToPage(requested);
  }, { accept: /^\d*$/, cancelOnEscape: true });
  const zoomInput = useDraftInput(String(Math.round(scale * 100)), (draft) => {
    const next = parsePdfZoomPercent(draft);
    if (next !== null) applyManualScale(next);
  });

  const loading = Boolean(loadKey && doc.loadedKey !== loadKey);
  const loadFeedback = doc.loadFeedback?.key === loadKey ? doc.loadFeedback : null;
  const showBlockingLoader = (loading && !hasActiveViewer) || loadFeedback?.blocking === true;
  const showQuietLoader = !showBlockingLoader && hasActiveViewer && (loading || loadFeedback !== null);
  const remoteSource = !source.bytes && !pdfBase64;
  const loadPhase = loadFeedback?.phase ?? (remoteSource ? "loading" : "rendering");
  const loadPercent = loadPhase === "loading" ? loadFeedback?.percent ?? null : null;
  const loadLabel = showBlockingLoader
    ? loadPhase === "loading"
      ? t`Loading PDF…`
      : t`Rendering first page…`
    : t`Updating…`;

  if (!loadKey) {
    return (
      <div className="pdf-preview">
        <div className="pdf-toolbar pdf-toolbar-empty">
          <div className="pdf-page-controls" />
          <div className="pdf-find-controls">
            {outline}
            <SearchField
              aria-label={t`Search PDF`}
              containerClassName="pdf-search disabled"
              controlSize="compact"
              placeholder={t`Find in PDF`}
              disabled
              value=""
            />
          </div>
          <div className="pdf-zoom-controls" />
        </div>
        <div className="pdf-placeholder">
          <FileText size={28} />
          <p>{t`Build the project to preview the paper`}</p>
        </div>
      </div>
    );
  }

  const download = () => {
    if (!pdfBytes || savingPdf) return;
    setSavingPdf(true);
    const trace = logAction(PDF_SOURCE, t`Save PDF`, fileName);
    // A promise chain, not try/finally: that statement makes the React Compiler bail out.
    void saveDialog({
      title: t`Save compiled PDF`,
      defaultPath: fileName,
      filters: [{ name: t`PDF document`, extensions: ["pdf"] }],
    })
      .then(async (destination) => {
        if (!destination) return;
        const path = await invoke<string>("save_compiled_pdf", pdfBytes, {
          headers: { "x-pdf-destination": utf8ToBase64(destination) },
        });
        trace.ok(t({ message: `Saved to ${path}` }));
      })
      .catch((reason: unknown) => trace.fail(reason))
      .finally(() => setSavingPdf(false));
  };
  const pageCount = numPages ?? "–";
  const { query, matches } = search;

  return (
    <div
      ref={previewRef}
      className="pdf-preview"
      tabIndex={-1}
      onPointerDownCapture={focusPdfSurface}
    >
      <PdfCitationHover key={doc.stableLoadKey} hostRef={hostRef} citations={citations}
        canOpenCitation={canOpenCitation} onOpenCitation={onOpenCitation} />
      <div className="pdf-toolbar">
        <div className="pdf-navigation-controls">
          {toolbarStart}
          <div className="pdf-page-controls">
            <ToolbarButton label={t`Previous page`} icon={<ChevronLeft size={14} />}
              disabled={pageNumber <= 1} onClick={() => stepPage(-1)} />
            <label className={`pdf-page-value${pageInput.editing ? " editing" : ""}`} title={t`Enter a page number`}>
              <input
                aria-label={t`PDF page number`}
                inputMode="numeric"
                style={{ width: pageInput.editing ? `${Math.max(1, pageInput.draft.length)}ch` : undefined }}
                {...pageInput.inputProps}
              />
              {pageInput.editing
                ? <span className="pdf-page-total">/ {pageCount}</span>
                : <span className="pdf-page-display" aria-hidden="true">{pageNumber} / {pageCount}</span>}
            </label>
            <ToolbarButton label={t`Next page`} icon={<ChevronRight size={14} />}
              disabled={!numPages || pageNumber >= numPages} onClick={() => stepPage(1)} />
          </div>
          <div className="pdf-history-controls">
            <ToolbarButton label={t`Previous PDF location`} icon={<CornerUpLeft size={14} />}
              disabled={!availability.back} onClick={() => navigate("back")} />
            <ToolbarButton label={t`Next PDF location`} icon={<CornerUpRight size={14} />}
              disabled={!availability.forward} onClick={() => navigate("forward")} />
          </div>
        </div>
        <div className="pdf-find-controls">
          {outline}
          <SearchField
            ref={searchInputRef}
            aria-label={t`Search PDF`}
            containerClassName="pdf-search"
            controlSize="compact"
            showIcon={!query}
            value={query}
            placeholder={t`Find in PDF`}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query) {
                event.preventDefault();
                search.find(query, event.shiftKey, true);
              } else if (event.key === "Escape" && query) {
                event.preventDefault();
                search.setQuery("");
              }
            }}
            trailing={query ? (
              <>
                <ToolbarButton label={t`Match case`} icon={<CaseSensitive size={12} />}
                  className="pdf-search-option" aria-pressed={search.matchCase} onMouseDown={keepFocus}
                  onClick={() => search.setMatchCase((enabled) => !enabled)} />
                <ToolbarButton label={t`Whole word`} icon={<WholeWord size={12} />}
                  className="pdf-search-option" aria-pressed={search.wholeWord} onMouseDown={keepFocus}
                  onClick={() => search.setWholeWord((enabled) => !enabled)} />
                <small className="pdf-search-position" aria-live="polite">
                  {matches.total ? `${matches.current} / ${matches.total}` : "0 / 0"}
                </small>
                <ToolbarButton label={t`Previous search result`} icon={<ChevronUp size={12} />}
                  disabled={!matches.total} onClick={() => search.find(query, true, true)} />
                <ToolbarButton label={t`Next search result`} icon={<ChevronDown size={12} />}
                  disabled={!matches.total} onClick={() => search.find(query, false, true)} />
                <ToolbarButton label={t`Clear PDF search`} icon={<X size={12} />} onClick={() => search.setQuery("")} />
              </>
            ) : undefined}
          />
        </div>
        <div className="pdf-zoom-controls">
          <ToolbarButton label={t`Zoom out`} icon={<ZoomOut size={14} />} className="pdf-zoom-step"
            disabled={scale <= PDF_MIN_SCALE} onClick={() => stepZoom(-1)} />
          <label
            ref={zoomLabelRef}
            className="pdf-zoom-value pdf-zoom-step"
            title={t`Enter a zoom percentage or scroll to zoom`}
          >
            <input aria-label={t`PDF zoom percentage`} inputMode="decimal" {...zoomInput.inputProps} />
            <span>%</span>
          </label>
          <ToolbarButton label={t`Zoom in`} icon={<ZoomIn size={14} />} className="pdf-zoom-step"
            disabled={scale >= PDF_MAX_SCALE} onClick={() => stepZoom(1)} />
          <i className="pdf-fit-divider pdf-zoom-step" aria-hidden="true" />
          {onForwardSync && (
            <>
              <ToolbarButton label={t`Reveal cursor in PDF (⌘⇧J)`}
                icon={locatingPdf ? <InfinityLoader size={14} /> : <LocateFixed size={14} />}
                disabled={!canForwardSync || locatingPdf} onMouseDown={keepFocus} onClick={onForwardSync} />
              <i className="pdf-fit-divider" aria-hidden="true" />
            </>
          )}
          <ToolbarButton label={t`Fit page to width`} icon={<RectangleHorizontal size={14} />}
            className={fitMode === "width" ? "active" : ""} aria-pressed={fitMode === "width"}
            disabled={!hasActiveViewer} onClick={() => toggleFit("width")} />
          <ToolbarButton label={t`Fit page to height`} icon={<RectangleVertical size={14} />}
            className={fitMode === "height" ? "active" : ""} aria-pressed={fitMode === "height"}
            disabled={!hasActiveViewer} onClick={() => toggleFit("height")} />
          {toolbarEnd}
          {showSave && (
            <Tip label={saveLabel ?? t`Save PDF as…`}>
              <MotionButton disabled={!pdfBytes || savingPdf} onClick={download}>
                {savingPdf ? <InfinityLoader size={14} /> : <Download size={14} />}
              </MotionButton>
            </Tip>
          )}
        </div>
      </div>
      <div className="pdf-scroll-area">
        <div ref={hostRef} className="pdf-viewer-host" />
        <OverlayScrollbars key={generation} getViewport={getScrollViewport} />
        {pdfError && !hasActiveViewer
          ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div>
          : null}
        {showBlockingLoader || showQuietLoader
          ? <PdfLoading label={loadLabel} percent={loadPercent} quiet={showQuietLoader} />
          : null}
      </div>
    </div>
  );
}
