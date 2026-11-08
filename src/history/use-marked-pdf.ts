/**
 * The PDF with review mode's changes marked, for the PDF panel to show in
 * place of the paper's own while review mode is on, unless the writer asks
 * for the PDF without changes (the review bar's toggle).
 *
 * It is built after each build of the paper (a new `pdfUrl`: the sources it
 * reads have reached disk) and after each accept (a new base), a moment
 * later so a run of either is one build. A newer build stops the older one
 * in Lattice's host. The marked PDF on screen stays until the next one is
 * ready; when one cannot be made (latexdiff fails on a construct, or is not
 * installed) the paper's own PDF comes back with the reason.
 */
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { pdfBytesToObjectUrl } from "../pdf/pdf-bytes";
import { reviewMode } from "./review-mode-store";

/** How long after a build or an accept the marked PDF waits, in case another follows. */
export const MARKED_PDF_DELAY_MS = 600;

export type MarkedPdf = Readonly<{
  /** The marked PDF, while it is asked for and one has been made. */
  url: string | null;
  building: boolean;
  /** Why the latest one could not be made. */
  error: string | null;
}>;

const NONE: MarkedPdf = { url: null, building: false, error: null };

type Shown = MarkedPdf & { root: string };
type ShownAction = { kind: "reset"; root: string } | { kind: "building" } | { kind: "built"; url: string; root: string } | { kind: "failed"; error: string };

function shownReducer(current: Shown, action: ShownAction): Shown {
  switch (action.kind) {
    case "reset": return current.url || current.building || current.error || current.root !== action.root ? { ...NONE, root: action.root } : current;
    case "building": return { ...current, building: true };
    case "built": return { url: action.url, building: false, error: null, root: action.root };
    case "failed": return { ...current, url: null, building: false, error: action.error };
  }
}

export function useMarkedPdf(projectRoot: string, pdfUrl: string | null): MarkedPdf {
  // The base revision while a marked PDF is wanted, else null: a number, so
  // the store's other changes (its project read at startup) do not render the panel.
  const revision = useSyncExternalStore(reviewMode.subscribe, () => {
    const { root, active, marked, revision } = reviewMode.get();
    return active && marked && root === projectRoot ? revision : null;
  });
  const wanted = revision !== null;
  const [shown, dispatch] = useReducer(shownReducer, { ...NONE, root: projectRoot });

  useEffect(() => {
    if (!wanted) {
      dispatch({ kind: "reset", root: projectRoot });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      dispatch({ kind: "building" });
      void (async () => {
        try {
          await reviewMode.flush();
          const bytes = await invoke<ArrayBuffer>("review_changes_pdf", { projectRoot });
          if (cancelled) return;
          const url = pdfBytesToObjectUrl(bytes);
          dispatch({ kind: "built", url, root: projectRoot });
        } catch (reason) {
          // A newer build stopped this one; that build answers instead.
          if (!cancelled) dispatch({ kind: "failed", error: toMessage(reason) });
        }
      })();
    }, MARKED_PDF_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wanted, projectRoot, pdfUrl, revision]);

  // A marked PDF that is replaced or no longer shown gives its memory back.
  useEffect(() => {
    const url = shown.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [shown.url]);

  if (!wanted || shown.root !== projectRoot) return NONE;
  return { url: shown.url, building: shown.building, error: shown.error };
}
