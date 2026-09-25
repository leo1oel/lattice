import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { CitationInfo } from "../editor/latex/latex-text";

export type PdfCitationProps = {
  citations?: CitationInfo[];
  canOpenCitation?: (key: string) => boolean;
  onOpenCitation?: (key: string) => void;
};

/** Hyperref/natbib use cite.KEY; biblatex uses cite.REFSECTION@KEY.
 * PDF.js encodes named destinations with legacy escape(), including %uXXXX.
 * Never infer a citation from its visible number or an external URL.
 */
function pdfCitationForLink(link: HTMLAnchorElement, citations: CitationInfo[]) {
  const href = link.getAttribute("href") ?? "";
  const hash = href.indexOf("#");
  if (hash < 0) return undefined;
  const destination = unescape(href.slice(hash + 1));
  if (!destination.startsWith("cite.")) return undefined;
  const key = destination.slice(5);
  return citations.find((citation) => citation.key === key)
    ?? citations.find((citation) => citation.key === key.replace(/^\d+@/, ""));
}

export function PdfCitationHover({ hostRef, citations = [], canOpenCitation, onOpenCitation }: PdfCitationProps & {
  hostRef: RefObject<HTMLDivElement | null>;
}) {
  const [target, setTarget] = useState<{ link: HTMLAnchorElement; citation: CitationInfo } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setTarget(null), 180);
  }, [cancelClose]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !citations.length) return;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const enter = (event: Event) => {
      const link = event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>(".annotationLayer [data-internal-link] a") : null;
      if (!link) return;
      const citation = pdfCitationForLink(link, citations);
      if (!citation) return;
      cancelClose();
      clearTimeout(openTimer);
      openTimer = setTimeout(() => setTarget({ link, citation }), event.type === "focusin" ? 0 : 250);
    };
    const leave = () => { clearTimeout(openTimer); closeSoon(); };
    const dismiss = () => {
      clearTimeout(openTimer);
      cancelClose();
      setTarget(null);
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    host.addEventListener("pointerover", enter);
    host.addEventListener("pointerout", leave);
    host.addEventListener("focusin", enter);
    host.addEventListener("focusout", leave);
    host.addEventListener("click", dismiss);
    // Scrolling/zooming invalidates a hover; don't leave a detached card behind.
    host.addEventListener("scroll", dismiss, true);
    host.addEventListener("wheel", dismiss, { passive: true });
    document.addEventListener("keydown", keydown);
    return () => {
      clearTimeout(openTimer);
      cancelClose();
      host.removeEventListener("pointerover", enter);
      host.removeEventListener("pointerout", leave);
      host.removeEventListener("focusin", enter);
      host.removeEventListener("focusout", leave);
      host.removeEventListener("click", dismiss);
      host.removeEventListener("scroll", dismiss, true);
      host.removeEventListener("wheel", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [hostRef, citations, cancelClose, closeSoon]);

  useEffect(() => {
    const card = cardRef.current;
    if (!target || !card) return;
    let disposed = false;
    const stop = autoUpdate(target.link, card, () => {
      if (!target.link.isConnected) { setTarget(null); return; }
      void computePosition(target.link, card, {
        strategy: "fixed", placement: "top",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (!disposed) Object.assign(card.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" });
      });
    });
    return () => { disposed = true; stop(); };
  }, [target]);

  if (!target || !citations.includes(target.citation)) return null;
  const citation = target.citation;
  const publication = [citation.venue, citation.year].filter(Boolean).join(" · ");
  return createPortal(<div
    ref={cardRef}
    className="citation-hover-card pdf-citation-hover"
    role="group"
    aria-label={citation.title || citation.key}
    style={{ position: "fixed", visibility: "hidden", zIndex: 1000 }}
    onPointerEnter={cancelClose}
    onPointerLeave={closeSoon}
    onFocus={cancelClose}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeSoon(); }}
  >
    <small>{citation.key}</small>
    {onOpenCitation && canOpenCitation?.(citation.key)
      ? <button type="button" className="citation-hover-open" onClick={() => {
        setTarget(null);
        onOpenCitation(citation.key);
      }}>{citation.title || citation.key}</button>
      : <strong>{citation.title || citation.key}</strong>}
    {citation.authors && <span>{citation.authors.replace(/ and /g, " · ")}</span>}
    {publication && <em>{publication}</em>}
  </div>, document.body);
}
