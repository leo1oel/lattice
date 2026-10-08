import {
  Fragment,
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
  type RefObject,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CornerUpLeft,
  CornerUpRight,
  Download,
  Ellipsis,
  LocateFixed,
  RectangleHorizontal,
  RectangleVertical,
  WholeWord,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PdfLoading } from "./pdf-loading";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { EmptyState } from "../components/ui/empty-state";
import { comboText } from "../app/key-combos";
import { REVEAL_IN_PDF_KEY } from "./pdf-keys";
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
import { PDF_MAX_SCALE, PDF_MIN_SCALE, parsePdfZoomPercent } from "./pdf-viewer-utils";
import { clamp } from "../settings/app-settings";
import { currentProjectPdf, saveProjectPdf, type ProjectPdfFile } from "./project-pdf";
import { pdfSource, usePdfDocument } from "./use-pdf-document";
import { usePdfSearch } from "./use-pdf-search";
import { useLatestRef } from "../hooks/use-latest-ref";
import { usePdfLocationHistory, usePdfViewState, type PdfViewerCallbacks } from "./use-pdf-view";
import { usePdfZoom } from "./use-pdf-zoom";
import { measurePdfSearchFold, type PdfSearchFold } from "./pdf-toolbar-min-width";
import "@pdfslick/core/dist/pdf_viewer.css";
import "./pdf-viewer.css";

export type { PdfSourceQuote, PdfSyncTarget };

/** Notification source label for the PDF preview. */
const PDF_SOURCE = "PDF";

/**
 * Focus the PDF surface on pointer down so keyboard shortcuts belong to it.
 * Portaled content (the toolbar's More menu) bubbles here through the React
 * tree; taking focus from it would dismiss the menu, so only DOM descendants count.
 */
function focusPdfSurface(event: ReactPointerEvent<HTMLDivElement>) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || !event.currentTarget.contains(target)) return;
  const interactiveSelector = ["a", "button", "input", "select", "textarea", `[${"contenteditable"}]`]
    .join(", ");
  if (target?.closest(interactiveSelector)) return;
  event.currentTarget.focus({ preventScroll: true });
}

/** Toolbar toggles must not take focus from the field or editor the reader is using. */
const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

function ToolbarButton({ label, shortcut, icon, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  icon: ReactNode;
}) {
  return <Tip label={label} shortcut={shortcut}><button type="button" {...props}>{icon}</button></Tip>;
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

/**
 * The control that takes focus from a menu whose trigger a wide toolbar hid:
 * the first enabled one the menu stood in for, in its zoom-first order (the
 * zoom steps lead the menu), or the preview itself when all are disabled.
 */
function nextVisibleControl(trigger: HTMLElement): HTMLElement | null {
  const toolbar = trigger.closest(".pdf-toolbar");
  const candidates = [".pdf-zoom-controls button.pdf-overflow", ".pdf-history-controls button"]
    .flatMap((selector) => [...toolbar?.querySelectorAll<HTMLElement>(selector) ?? []]);
  const control = candidates.find((candidate) => !candidate.matches(":disabled") && candidate.getClientRects().length > 0);
  return control ?? trigger.closest<HTMLElement>(".pdf-preview");
}

/**
 * The match controls' footprint while the search field is empty, shown only
 * for a minimum-width measurement: the buttons have a fixed width and the
 * counter reads as an idle one does. Plain inert elements rather than the
 * tooltip-wrapped buttons, which would add their render cost to every toolbar
 * update for controls nobody can see. Keep in step with the controls it stands in for.
 */
const IDLE_SEARCH_CONTROLS = (
  <>
    <button type="button" tabIndex={-1} aria-hidden="true" />
    <button type="button" tabIndex={-1} aria-hidden="true" />
    <small className="pdf-search-position" aria-hidden="true">0 / 0</small>
    <button type="button" tabIndex={-1} aria-hidden="true" />
    <button type="button" tabIndex={-1} aria-hidden="true" />
    <button type="button" tabIndex={-1} aria-hidden="true" />
  </>
);

type MenuAction = { label: string; icon: ReactNode; disabled?: boolean; checked?: boolean; run: () => void };

/**
 * How far the toolbar folds while a query is typed (measurePdfSearchFold):
 * read again whenever the toolbar's frame changes width (a divider drag, a
 * window resize) or the match counter changes length, and only while there is
 * a query, so an idle toolbar costs no observer.
 */
function usePdfSearchFold(previewRef: RefObject<HTMLDivElement | null>, searching: boolean, counter: string): PdfSearchFold {
  const [fold, setFold] = useState<PdfSearchFold>(0);
  useEffect(() => {
    const toolbar = previewRef.current?.querySelector<HTMLElement>(".pdf-toolbar");
    const frame = toolbar?.parentElement;
    if (!searching || !toolbar || !frame) {
      setFold(0);
      return;
    }
    // The frame's width is the pane's, whatever the fold, so a fold never re-triggers this.
    const observer = new ResizeObserver(() => setFold(measurePdfSearchFold(toolbar)));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [previewRef, searching, counter]);
  return fold;
}

/**
 * A narrow toolbar's home for what it sets aside (pdf-viewer.css): the zoom
 * steps and value, the fit mode not in use, location history and saving. It
 * is only reachable while the toolbar is narrow; a wide one shows each control.
 *
 * Widening the panel or window past the breakpoint with the menu open hides
 * its trigger, and the portaled menu would follow that empty box to the
 * window's corner. So while open, the toolbar's frame (its size container,
 * which a divider drag already resizes) is watched, and the menu closes once
 * the trigger is gone, handing focus to a control it stood in for.
 */
function PdfOverflowMenu({ open, onOpenChange, scale, stepZoom, onEnterZoom, groups }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only read while open; pass a constant otherwise, so zooming never re-renders the closed menu. */
  scale: number;
  stepZoom: (direction: 1 | -1) => void;
  /** Close the menu and type a percentage into the toolbar's own zoom field. */
  onEnterZoom: () => void;
  groups: MenuAction[][];
}) {
  const { t } = useLingui();
  const zoomEntryRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Where focus goes when the menu closes because its trigger was hidden: null
  // to leave it be (it was not in the menu), else the toolbar control to take it.
  const strandedFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => {
    const trigger = triggerRef.current;
    const frame = trigger?.closest(".pdf-toolbar-frame");
    if (!open || !trigger || !frame) return;
    const observer = new ResizeObserver(() => {
      if (trigger.getClientRects().length) return;
      const hadFocus = Boolean(contentRef.current?.contains(document.activeElement));
      strandedFocusRef.current = hadFocus ? nextVisibleControl(trigger) : null;
      onOpenChange(false);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [open, onOpenChange]);
  // Stepping keeps the menu open, so a reader can click until the page is right.
  const step = (direction: 1 | -1) => (event: Event) => {
    event.preventDefault();
    stepZoom(direction);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <Tip label={t`More PDF actions`}>
        <DropdownMenuTrigger asChild>
          <button ref={triggerRef} type="button" className="pdf-overflow-trigger"><Ellipsis size={14} /></button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        ref={contentRef}
        align="end"
        sideOffset={6}
        className="pdf-overflow-menu min-w-[13.5rem]"
        onCloseAutoFocus={(event) => {
          const stranded = strandedFocusRef.current;
          if (stranded !== undefined) {
            strandedFocusRef.current = undefined;
            zoomEntryRef.current = false;
            event.preventDefault();
            stranded?.focus();
            return;
          }
          if (!zoomEntryRef.current) return;
          zoomEntryRef.current = false;
          event.preventDefault();
          onEnterZoom();
        }}
      >
        <div className="pdf-overflow-zoom" role="group" aria-label={t`Zoom`}>
          <span className="pdf-overflow-zoom-label" aria-hidden="true">{t`Zoom`}</span>
          <DropdownMenuItem aria-label={t`Zoom out`} disabled={scale <= PDF_MIN_SCALE} onSelect={step(-1)}>
            <ZoomOut />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="pdf-overflow-zoom-value"
            aria-label={t`Enter a zoom percentage`}
            onSelect={() => { zoomEntryRef.current = true; }}
          >
            {Math.round(scale * 100)}%
          </DropdownMenuItem>
          <DropdownMenuItem aria-label={t`Zoom in`} disabled={scale >= PDF_MAX_SCALE} onSelect={step(1)}>
            <ZoomIn />
          </DropdownMenuItem>
        </div>
        {groups.filter((group) => group.length).map((group, index) => (
          <Fragment key={index}>
            <DropdownMenuSeparator />
            {group.map((action) => (
              <DropdownMenuItem
                key={action.label}
                disabled={action.disabled}
                onSelect={action.run}
                {...(action.checked === undefined ? {} : { role: "menuitemcheckbox", "aria-checked": action.checked })}
              >
                {action.icon}
                <span className="flex-1">{action.label}</span>
                {action.checked && <Check size={14} className="pdf-overflow-check" />}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PdfPreview({
  url,
  projectFile = null,
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
  loadErrorHint,
  outline,
  toolbarStart,
  toolbarEnd,
  notice = null,
  citations,
  canOpenCitation,
  onOpenCitation,
  ...callbackProps
}: PdfCitationProps & PdfViewerCallbacks & {
  url: string | null;
  /** A project PDF, read a range at a time instead of from `url` or `pdfBytes`. */
  projectFile?: ProjectPdfFile | null;
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
  /** What to try when the PDF cannot be read, under the error, such as building again for a compiled PDF. */
  loadErrorHint?: string;
  outline?: ReactNode;
  /** Context-specific actions rendered before the page controls. */
  toolbarStart?: ReactNode;
  /** Context-specific icon actions rendered before the save control. */
  toolbarEnd?: ReactNode;
  /** A short status shown over the pages, such as the file having been removed. */
  notice?: string | null;
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
  const source = pdfSource(url, pdfBytes, projectFile);
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
    onFindMatches: search.onFindMatches,
    timeoutMessage: timeoutMessage ?? t`PDF preview timed out. Click Build again, or open the PDF in Preview.`,
  });
  const { numPages, pdfError, pdfErrorDetail } = doc;
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  // A narrow toolbar shows its zoom field only while a percentage is typed into it.
  const [zoomEntry, setZoomEntry] = useState(false);
  useEffect(() => {
    if (zoomEntry) zoomLabelRef.current?.querySelector("input")?.focus();
  }, [zoomEntry, zoomLabelRef]);
  const matchPosition = search.matches.total ? `${search.matches.current} / ${search.matches.total}` : "0 / 0";
  const searchFold = usePdfSearchFold(previewRef, Boolean(search.query), matchPosition);
  const zoomInput = useDraftInput(String(Math.round(scale * 100)), (draft) => {
    const next = parsePdfZoomPercent(draft);
    if (next !== null) applyManualScale(next);
  });

  const loading = Boolean(loadKey && doc.loadedKey !== loadKey);
  const loadFeedback = doc.loadFeedback?.key === loadKey ? doc.loadFeedback : null;
  const showBlockingLoader = (loading && !hasActiveViewer) || loadFeedback?.blocking === true;
  const showQuietLoader = !showBlockingLoader && hasActiveViewer && (loading || loadFeedback !== null);
  const remoteSource = !source.bytes && !source.file;
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
        <div className="pdf-toolbar-frame">
          <div className="pdf-toolbar pdf-toolbar-empty">
            <div className="pdf-page-controls" />
            <div className="pdf-find-controls">
              {outline}
              <SearchField
                aria-label={t`Search PDF`}
                containerClassName="pdf-search"
                controlSize="compact"
                placeholder={t`Find in PDF`}
                disabled
                value=""
              />
            </div>
            <div className="pdf-zoom-controls" />
          </div>
        </div>
        <div className="pdf-placeholder">
          <EmptyState icon={<EmptyIllustration kind="preview" />} description={t`Build the project to preview the paper`} />
        </div>
      </div>
    );
  }

  // A project file is copied on disk as it is then, never read into the
  // webview; a remote paper is saved from the bytes the reader captures once
  // it has loaded.
  const canSave = Boolean(pdfBytes || projectFile);
  const download = () => {
    if (!canSave || savingPdf) return;
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
        const path = pdfBytes
          ? await invoke<string>("save_compiled_pdf", pdfBytes, {
            headers: { "x-pdf-destination": utf8ToBase64(destination) },
          })
          : await saveProjectPdf(await currentProjectPdf(projectFile!.path), destination);
        trace.ok(t({ message: `Saved to ${path}` }));
      })
      .catch((reason: unknown) => trace.fail(reason))
      .finally(() => setSavingPdf(false));
  };
  const saveName = saveLabel ?? t`Save PDF as…`;
  // A narrow toolbar keeps one fit control: the mode in use, or width when
  // neither is (a manual zoom); the other waits in the overflow menu.
  const shownFit = fitMode ?? "width";
  const fitWidth = { mode: "width" as const, label: t`Fit page to width`, icon: <RectangleHorizontal size={14} /> };
  const fitHeight = { mode: "height" as const, label: t`Fit page to height`, icon: <RectangleVertical size={14} /> };
  const otherFit = shownFit === "width" ? fitHeight : fitWidth;
  const pageCount = numPages ?? "–";
  const { query, matches } = search;
  const revealLabel = t`Reveal cursor in PDF`;
  // What the menu shows for a fold, read only while folded: zooming leaves a
  // fit and each edit makes a new SyncTeX callback, and an unfolded menu must
  // not re-render for either.
  const foldedFit = searchFold ? fitMode : null;
  const foldedReveal = searchFold ? onForwardSync : undefined;

  return (
    // Pinch and Ctrl-wheel zoom the PDF, never the workspace around it. The
    // compiled-preview host is marked already, but a PDF opened as a document
    // sits in the editor host, which is marked only for heavy documents.
    <div
      ref={previewRef}
      className="pdf-preview"
      data-trellis-owns-gestures=""
      tabIndex={-1}
      onPointerDownCapture={focusPdfSurface}
    >
      <PdfCitationHover key={doc.stableLoadKey} hostRef={hostRef} citations={citations}
        canOpenCitation={canOpenCitation} onOpenCitation={onOpenCitation} />
      <div className="pdf-toolbar-frame">
        <div className="pdf-toolbar" data-zoom-entry={zoomEntry || undefined} data-search-fold={searchFold || undefined}>
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
            <div className="pdf-history-controls pdf-overflow">
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
              containerClassName={query ? "pdf-search" : "pdf-search pdf-search-idle"}
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
              // A stand-in is mounted (and hidden) before the first character, so the
              // panel's minimum width can reserve the controls' room (pdf-toolbar-min-width.ts).
              trailing={query ? (
                <>
                  <ToolbarButton label={t`Match case`} icon={<CaseSensitive size={12} />}
                    className="pdf-search-option" aria-pressed={search.matchCase} onMouseDown={keepFocus}
                    onClick={() => search.setMatchCase((enabled) => !enabled)} />
                  <ToolbarButton label={t`Whole word`} icon={<WholeWord size={12} />}
                    className="pdf-search-option" aria-pressed={search.wholeWord} onMouseDown={keepFocus}
                    onClick={() => search.setWholeWord((enabled) => !enabled)} />
                  <small className="pdf-search-position" aria-live="polite">
                    {matchPosition}
                  </small>
                  <ToolbarButton label={t`Previous search result`} icon={<ChevronUp size={12} />}
                    disabled={!matches.total} onClick={() => search.find(query, true, true)} />
                  <ToolbarButton label={t`Next search result`} icon={<ChevronDown size={12} />}
                    disabled={!matches.total} onClick={() => search.find(query, false, true)} />
                  <ToolbarButton label={t`Clear PDF search`} icon={<X size={12} />} onClick={() => search.setQuery("")} />
                </>
              ) : IDLE_SEARCH_CONTROLS}
            />
          </div>
          <div className="pdf-zoom-controls">
            <ToolbarButton label={t`Zoom out`} icon={<ZoomOut size={14} />} className="pdf-overflow"
              disabled={scale <= PDF_MIN_SCALE} onClick={() => stepZoom(-1)} />
            <label
              ref={zoomLabelRef}
              className="pdf-zoom-value pdf-overflow"
              title={t`Enter a zoom percentage or scroll to zoom`}
            >
              <input
                aria-label={t`PDF zoom percentage`}
                inputMode="decimal"
                {...zoomInput.inputProps}
                onBlur={() => {
                  zoomInput.inputProps.onBlur();
                  setZoomEntry(false);
                }}
              />
              <span>%</span>
            </label>
            <ToolbarButton label={t`Zoom in`} icon={<ZoomIn size={14} />} className="pdf-overflow"
              disabled={scale >= PDF_MAX_SCALE} onClick={() => stepZoom(1)} />
            <i className="pdf-fit-divider pdf-overflow" aria-hidden="true" />
            {onForwardSync && (
              <>
                <ToolbarButton label={revealLabel} shortcut={comboText({ mod: true, ...REVEAL_IN_PDF_KEY })} className="pdf-search-fold"
                  icon={locatingPdf ? <InfinityLoader size={14} /> : <LocateFixed size={14} />}
                  disabled={!canForwardSync || locatingPdf} onMouseDown={keepFocus} onClick={onForwardSync} />
                <i className="pdf-fit-divider pdf-search-fold" aria-hidden="true" />
              </>
            )}
            {/* Written out, not mapped: each button then re-renders only when its own state changes. */}
            <ToolbarButton label={fitWidth.label} icon={fitWidth.icon}
              className={`pdf-search-fold${fitMode === "width" ? " active" : ""}${shownFit === "width" ? "" : " pdf-overflow"}`}
              aria-pressed={fitMode === "width"} disabled={!hasActiveViewer} onClick={() => toggleFit("width")} />
            <ToolbarButton label={fitHeight.label} icon={fitHeight.icon}
              className={`pdf-search-fold${fitMode === "height" ? " active" : ""}${shownFit === "height" ? "" : " pdf-overflow"}`}
              aria-pressed={fitMode === "height"} disabled={!hasActiveViewer} onClick={() => toggleFit("height")} />
            {toolbarEnd}
            {showSave && (
              <Tip label={saveName}>
                <MotionButton className="pdf-overflow" disabled={!canSave || savingPdf} onClick={download}>
                  {savingPdf ? <InfinityLoader size={14} /> : <Download size={14} />}
                </MotionButton>
              </Tip>
            )}
            <PdfOverflowMenu
              open={overflowOpen}
              onOpenChange={setOverflowOpen}
              scale={overflowOpen ? scale : 1}
              stepZoom={stepZoom}
              onEnterZoom={() => setZoomEntry(true)}
              groups={[
                // Folded for a query, SyncTeX and both fits wait here, each fit marked when in use.
                foldedReveal
                  ? [{ label: revealLabel, icon: <LocateFixed />, disabled: !canForwardSync || locatingPdf, run: foldedReveal }]
                  : [],
                searchFold
                  ? [fitWidth, fitHeight].map((fit) => ({
                    label: fit.label, icon: fit.icon, checked: foldedFit === fit.mode, disabled: !hasActiveViewer, run: () => toggleFit(fit.mode),
                  }))
                  : [{ label: otherFit.label, icon: otherFit.icon, disabled: !hasActiveViewer, run: () => toggleFit(otherFit.mode) }],
                [
                  { label: t`Previous PDF location`, icon: <CornerUpLeft />, disabled: !availability.back, run: () => navigate("back") },
                  { label: t`Next PDF location`, icon: <CornerUpRight />, disabled: !availability.forward, run: () => navigate("forward") },
                ],
                showSave ? [{ label: saveName, icon: <Download />, disabled: !canSave || savingPdf, run: download }] : [],
              ]}
            />
          </div>
        </div>
      </div>
      <div className="pdf-scroll-area">
        <div ref={hostRef} className="pdf-viewer-host" />
        <OverlayScrollbars key={generation} getViewport={getScrollViewport} />
        {notice ? <p className="pdf-notice" role="status">{notice}</p> : null}
        {pdfError && !hasActiveViewer
          ? (
            // A load failure names itself and quotes PDF.js; a timeout is its own advice.
            <div className="pdf-placeholder" role="alert">
              <EmptyState
                className="pdf-load-error"
                icon={<CircleAlert size={20} />}
                title={pdfErrorDetail ? pdfError : undefined}
                description={pdfErrorDetail ? loadErrorHint : pdfError}
                actions={pdfErrorDetail ? <small className="pdf-placeholder-detail">{pdfErrorDetail}</small> : null}
              />
            </div>
          )
          : null}
        {showBlockingLoader || showQuietLoader
          ? <PdfLoading label={loadLabel} percent={loadPercent} quiet={showQuietLoader} />
          : null}
      </div>
    </div>
  );
}
