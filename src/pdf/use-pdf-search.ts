import { useCallback, useEffect, useState, type RefObject } from "react";
import { isPdfCopyField, pdfSelectedOrCachedPlainText } from "./pdf-text-layer-selection";
import { addListeners, normalizePdfSelection } from "./pdf-viewer-utils";
import type { PdfFindMatches } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";

const NO_MATCHES: PdfFindMatches = { current: 0, total: 0 };

/**
 * PDFSlick find-bar state, plus Command/Ctrl-F while the PDF surface is the
 * last thing the reader pointed at or focused: it seeds the query from the
 * PDF selection and focuses the search field.
 */
export function usePdfSearch(
  recordRef: ActiveViewerRef,
  generation: number,
  loadKey: string,
  previewRef: RefObject<HTMLDivElement | null>,
  inputRef: RefObject<HTMLInputElement | null>,
) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matches, setMatches] = useState(NO_MATCHES);

  const find = useCallback((text: string, findPrevious = false, again = false) => {
    const slick = recordRef.current?.slick;
    if (!slick) return;
    if (!text.trim()) {
      slick.dispatch("findbarclose", { source: slick });
      setMatches(NO_MATCHES);
      return;
    }
    slick.dispatch("find", {
      source: slick,
      type: again ? "again" : "",
      query: text,
      caseSensitive: matchCase,
      entireWord: wholeWord,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }, [matchCase, recordRef, wholeWord]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !loadKey) return;
    let surfaceActive = false;
    const inside = (target: EventTarget | null) => target instanceof Node && preview.contains(target);
    const onFindShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() !== "f"
        || (!event.metaKey && !event.ctrlKey)
        || event.altKey
        || event.shiftKey
      ) return;
      event.preventDefault();
      event.stopPropagation();
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      let selectedText = selection && !selection.isCollapsed && anchor && recordRef.current?.root.contains(anchor)
        ? normalizePdfSelection(selection.toString())
        : "";
      if (!selectedText && isPdfCopyField(event.target)) selectedText = pdfSelectedOrCachedPlainText();
      if (selectedText) setQuery(selectedText);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    return addListeners(document, {
      pointerdown: (event: PointerEvent) => {
        surfaceActive = inside(event.target);
      },
      // The hidden copy field takes focus after a PDF drag; it still belongs to the surface.
      focusin: (event: FocusEvent) => {
        if (!isPdfCopyField(event.target)) surfaceActive = inside(event.target);
      },
      keydown: (event: KeyboardEvent) => {
        if (surfaceActive) onFindShortcut(event);
      },
    }, { capture: true });
  }, [inputRef, loadKey, previewRef, recordRef]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize PDFSlick's imperative find controller after promotion or query changes.
    if (generation > 0) find(query);
  }, [find, generation, query]);

  return { query, setQuery, matchCase, setMatchCase, wholeWord, setWholeWord, matches, setMatches, find };
}
