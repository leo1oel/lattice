/**
 * Following a source link, or a citation that names a page, into a library
 * paper: open the paper, then show its original PDF at that page with the
 * quoted passage highlighted. The Paper reader answers the request once the
 * paper is in front (usePaperPdf), so this holds it only until then.
 */
import { useCallback, useEffect, useReducer } from "react";
import type { PaperSourceRequest, PaperSummary } from "../app-types";
import type { PaperSourceCitation } from "../papers/paper-source";

type RouteAction =
  | { type: "post"; request: PaperSourceRequest }
  | { type: "settle"; id: string }
  /** The paper (if any) now in front. */
  | { type: "front"; arxivId: string | undefined };

function route(current: PaperSourceRequest | null, action: RouteAction): PaperSourceRequest | null {
  if (action.type === "post") return action.request;
  if (action.type === "settle") return current?.id === action.id ? null : current;
  return current && current.arxivId !== action.arxivId ? null : current;
}

export function usePaperSourceRoute({ activePaperId, activeFile, openPaper, fetchAndOpenPaper }: {
  activePaperId: string | undefined;
  activeFile: string;
  /** Opens a paper whose text is local; false when it did not open. */
  openPaper: (paper: PaperSummary) => Promise<boolean>;
  /** Downloads a paper's text, then opens it; false when the download failed. */
  fetchAndOpenPaper: (paper: PaperSummary) => Promise<boolean>;
}) {
  const [request, dispatch] = useReducer(route, null);
  const forget = useCallback((id: string) => dispatch({ type: "settle", id }), []);

  // Going anywhere but the requested paper drops the request, so a failed or
  // abandoned open does not jump a later, unrelated visit to that page.
  useEffect(() => {
    dispatch({ type: "front", arxivId: activePaperId });
  }, [activePaperId, activeFile]);

  /** `onDownloadFailed` runs when the paper's text had to be fetched and could not be. */
  const openPaperSource = useCallback((paper: PaperSummary, place: PaperSourceCitation, onDownloadFailed?: () => void) => {
    const id = crypto.randomUUID();
    dispatch({ type: "post", request: { arxivId: paper.arxivId, ...place, id } });
    const local = paper.hasFullText || paper.hasBlog;
    void (local ? openPaper(paper) : fetchAndOpenPaper(paper)).then((opened) => {
      if (opened) return;
      forget(id);
      if (!local) onDownloadFailed?.();
    });
  }, [fetchAndOpenPaper, forget, openPaper]);

  return { request, settle: forget, openPaperSource };
}
