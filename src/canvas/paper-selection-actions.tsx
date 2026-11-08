import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Link2, NotebookPen } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { hostErrorMessage } from "../app-utils";
import { InfinityLoader } from "../components/ui/activity-icons";
import { useLatestRef } from "../hooks/use-latest-ref";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { addToPaperNote, paperNotePath } from "../papers/paper-notes";
import { paperLinkHref } from "../papers/paper-link";
import {
  paperSourceHref, sourceLinkMarkdown, sourceQuoteAnchors, sourceQuoteMarkdown, type PaperSourceCitation,
} from "../papers/paper-source";
import { sourceQuoteDomRange } from "../papers/source-quote";
import { pdfSelectedPlainTextWithin } from "../pdf/pdf-text-layer-selection";
import { notifyCopied, notifyError, notifySuccess, notifyWarning } from "../telemetry/app-notify";
import type { usePaperPdf } from "./use-paper-pdf";

/**
 * A passage selected in the reader. `place` is known at once on the PDF; the
 * full text has no pages, so its passage is looked up in the PDF on demand.
 */
type PaperSelection = { text: string; place: PaperSourceCitation | null; left: number; top: number };

type Offer = { selection: PaperSelection | null; busy: "copy" | "note" | null };
type OfferAction = { type: "select"; selection: PaperSelection | null } | { type: "start"; busy: "copy" | "note" } | { type: "done" };

function offer(current: Offer, action: OfferAction): Offer {
  if (action.type === "start") return { ...current, busy: action.busy };
  if (action.type === "done") return { selection: null, busy: null };
  // A new selection waits for an action under way to finish with the old one.
  return current.busy || current.selection === action.selection ? current : { ...current, selection: action.selection };
}

/** A selection on the PDF: its text, page and anchors there, and where it ends on screen. */
function readPdfSelection(preview: HTMLElement): { text: string; place: PaperSourceCitation | null; end: DOMRect } | null {
  const text = pdfSelectedPlainTextWithin(preview).trim();
  const marks = Array.from(preview.querySelectorAll<HTMLElement>(".pdf-sel-rect"));
  const pageElement = marks[0]?.closest<HTMLElement>("[data-page-number]");
  if (!text || !pageElement) return null;
  const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
  const textLayer = pageElement.querySelector<HTMLElement>(".textLayer");
  // The anchors are checked against the text layer the reader's highlight searches.
  const anchors = textLayer && sourceQuoteAnchors(text, (first, last) => sourceQuoteDomRange(textLayer, first, last) !== null);
  return { text, place: page >= 1 && anchors ? { page, ...anchors } : null, end: marks.at(-1)!.getBoundingClientRect() };
}

/** A selection in the full text or overview, and where it ends on screen. */
function readMarkdownSelection(root: HTMLElement): { text: string; place: null; end: DOMRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString().trim();
  const end = Array.from(range.getClientRects()).at(-1);
  return text && end ? { text, place: null, end } : null;
}

/**
 * Copy source link and Add to note, offered where a selection in the Paper
 * reader ends, on the original PDF or in the full text. The link is the one
 * the alphaXiv overview writes: the paper's PDF at the passage's page, with
 * its first and last words in the title so following it highlights the
 * passage. Add to note appends the quote and that link to the paper's note.
 */
export function PaperSelectionActions({ shellRef, paper, pdf, overview, projectRoot, onOpenNote }: {
  shellRef: RefObject<HTMLElement | null>;
  /** The alphaXiv overview is in front: a summary, not the paper's words, so nothing in it is offered as a quote. */
  overview: boolean;
  paper: PaperSummary;
  pdf: ReturnType<typeof usePaperPdf>;
  projectRoot: string | undefined;
  onOpenNote: (path: string) => void;
}) {
  const { t } = useLingui();
  const [{ selection, busy }, dispatch] = useReducer(offer, { selection: null, busy: null });
  const barRef = useRef<HTMLDivElement | null>(null);
  const overviewRef = useLatestRef(overview);
  const hasPdf = Boolean(pdf.pdfSource);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame: number | null = null;
    const read = () => {
      frame = null;
      const bounds = shell.getBoundingClientRect();
      const preview = shell.querySelector<HTMLElement>(".paper-pdf-preview");
      const markdown = preview || overviewRef.current ? null : shell.querySelector<HTMLElement>(".markdown-preview");
      const found = preview ? readPdfSelection(preview) : markdown ? readMarkdownSelection(markdown) : null;
      dispatch({ type: "select", selection: found && {
        text: found.text,
        place: found.place,
        left: found.end.right - bounds.left,
        top: found.end.bottom - bounds.top,
      } });
    };
    const schedule = (event: MouseEvent) => {
      // Choosing an action keeps the selection; it is not a new one.
      if (event.target instanceof Element && event.target.closest(".paper-selection-actions")) return;
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The PDF's text layer draws its selection on the frame after the drag ends.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(read);
      });
    };
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest(".paper-selection-actions"))) dispatch({ type: "select", selection: null });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "select", selection: null });
    };
    shell.addEventListener("mouseup", schedule);
    // A press anywhere starts over (a new drag, a click elsewhere), and a scroll moves the passage from under the bar.
    document.addEventListener("pointerdown", dismiss, true);
    shell.addEventListener("scroll", dismiss, { capture: true, passive: true });
    shell.addEventListener("keydown", escape);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      shell.removeEventListener("mouseup", schedule);
      document.removeEventListener("pointerdown", dismiss, true);
      shell.removeEventListener("scroll", dismiss, { capture: true });
      shell.removeEventListener("keydown", escape);
    };
  }, [overviewRef, shellRef]);
  // Another reading, the PDF opening or closing, or another paper ends the offer.
  const viewKey = `${paper.arxivId}\n${pdf.pdfView?.key ?? ""}`;
  useEffect(() => dispatch({ type: "select", selection: null }), [viewKey]);

  // Keep the bar inside the reader: it stands at the selection's end, right-aligned there, until the edge.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const shell = shellRef.current;
    if (!bar || !shell || !selection) return;
    const margin = 8;
    const width = bar.offsetWidth;
    const left = Math.min(Math.max(margin, selection.left - width), shell.clientWidth - width - margin);
    const top = Math.min(selection.top + 4, shell.clientHeight - bar.offsetHeight - margin);
    bar.style.left = `${Math.max(margin, left)}px`;
    bar.style.top = `${Math.max(margin, top)}px`;
  }, [selection, shellRef]);

  if (!selection) return null;

  /** The passage's place on the PDF: known on the PDF, found in it for the full text; null when it is not there. */
  const locate = async () => selection.place ?? (hasPdf ? await pdf.locateQuote(selection.text) : null);
  const sourceLink = (place: PaperSourceCitation) => {
    const href = paperSourceHref(paper, place.page);
    return href ? sourceLinkMarkdown(t`p. ${place.page}`, href, place) : null;
  };
  const run = (kind: "copy" | "note", action: () => Promise<void>) => {
    dispatch({ type: "start", busy: kind });
    void action().catch((reason: unknown) => {
      notifyError(t`Papers`, kind === "copy" ? t`Could not copy the source link` : t`Could not add to the note`, { detail: hostErrorMessage(reason) });
    }).finally(() => dispatch({ type: "done" }));
  };
  const copy = () => run("copy", async () => {
    const place = await locate();
    const link = place && sourceLink(place);
    if (!link) {
      notifyWarning(t`Papers`, t`Could not find this passage in the PDF`);
      return;
    }
    await writeText(link).catch(() => navigator.clipboard?.writeText(link));
    notifyCopied(t`Source link copied`);
  });
  const addToNote = () => run("note", async () => {
    if (!projectRoot) return;
    const place = await locate();
    // A passage the PDF does not hold still links to the paper, in its reading here.
    const link = (place && sourceLink(place))
      ?? `[${t`Full text`}](${paperLinkHref(paperNotePath(paper), { ...paper, hasFullText: true })})`;
    const path = await addToPaperNote(projectRoot, paper, sourceQuoteMarkdown(selection.text, link));
    notifySuccess(t`Papers`, t`Added to ${path}`, { primaryAction: { label: t`Open note`, onClick: () => onOpenNote(path) } });
  });

  return (
    <div ref={barRef} className={`paper-selection-actions ${popupMotionClassName}`} role="toolbar" aria-label={t`Selected passage`}>
      {hasPdf && (
        <button type="button" className="paper-selection-action" disabled={busy !== null} aria-busy={busy === "copy" || undefined} onMouseDown={(event) => event.preventDefault()} onClick={copy}>
          {busy === "copy" ? <InfinityLoader size={13} /> : <Link2 size={13} aria-hidden="true" />}
          <span>{t`Copy source link`}</span>
        </button>
      )}
      {projectRoot && (
        <button type="button" className="paper-selection-action" disabled={busy !== null} aria-busy={busy === "note" || undefined} onMouseDown={(event) => event.preventDefault()} onClick={addToNote}>
          {busy === "note" ? <InfinityLoader size={13} /> : <NotebookPen size={13} aria-hidden="true" />}
          <span>{t`Add to note`}</span>
        </button>
      )}
    </div>
  );
}
