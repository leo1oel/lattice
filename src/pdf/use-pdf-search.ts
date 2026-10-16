import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isPdfCopyField, pdfSelectedOrCachedPlainText } from "./pdf-text-layer-selection";
import { addListeners, normalizePdfSelection } from "./pdf-viewer-utils";
import type { PdfFindMatches } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";

/** Matches, with the search they answer (searchKey); "" for none. */
type SearchMatches = PdfFindMatches & { search: string };

const NO_MATCHES: SearchMatches = { current: 0, total: 0, search: "" };

/** One search: the viewer showing it, the query and its options. */
function searchKey(generation: number, query: string, matchCase: boolean, wholeWord: boolean) {
  return `${generation}:${Number(matchCase)}${Number(wholeWord)}:${query}`;
}

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
  // PDF.js answers `findbarclose` with one last control-state event carrying
  // the closed query's count, after the toolbar has already reset to 0 / 0;
  // only results of a search still in progress may reach the toolbar.
  const searchingRef = useRef(false);
  // The search PDF.js is answering, stamped on each result it reports. PDF.js
  // waits a moment before matching a new query and reports nothing meanwhile,
  // so until a result carries the search on screen, the last count belongs to
  // another query (or options, or document) and the search reads as pending.
  const searchRef = useRef("");
  const onFindMatches = useCallback((next: PdfFindMatches) => {
    if (searchingRef.current) setMatches({ ...next, search: searchRef.current });
  }, []);

  const find = useCallback((text: string, findPrevious = false, again = false) => {
    const slick = recordRef.current?.slick;
    if (!slick) return;
    searchingRef.current = Boolean(text.trim());
    searchRef.current = searchKey(generation, text, matchCase, wholeWord);
    if (!searchingRef.current) {
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
  }, [generation, matchCase, recordRef, wholeWord]);

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
    // Synchronize PDFSlick's imperative find controller after promotion or query changes.
    if (generation > 0) find(query);
  }, [find, generation, query]);

  const pending = generation > 0 && Boolean(query.trim())
    && matches.search !== searchKey(generation, query, matchCase, wholeWord);
  return {
    query, setQuery, matchCase, setMatchCase, wholeWord, setWholeWord,
    matches: pending ? NO_MATCHES : matches, pending, onFindMatches, find,
  };
}
