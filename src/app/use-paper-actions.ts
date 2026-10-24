/**
 * What the Papers panel, the palette and a dragged-in paper do with a paper:
 * download its full text and open it, cancel the downloads under way, read a
 * paper dropped on the window, and remove a cited entry. Each download's
 * progress glyph is kept here, by paper key.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { canDownloadPaper } from "../papers/paper-source";
import { isMissingPaperToolsError } from "../build/tex-setup";
import type { PaperSummary, RefreshProject } from "../app-types";
import { paperKey, toMessage } from "../app-utils";
import { showError } from "./notify";
import { removeReference } from "./remove-reference-action";
import type { OpenDocuments } from "./use-open-documents";
import type { ProjectState } from "./use-project-state";

export function usePaperActions({
  projectState: { project, captureProjectScope }, documents, refreshProject, refreshHistory, clearImportStage, openForMissingPaperTools,
}: {
  projectState: Pick<ProjectState, "project" | "captureProjectScope">;
  documents: OpenDocuments;
  refreshProject: RefreshProject;
  refreshHistory: () => Promise<void>;
  clearImportStage: () => void;
  openForMissingPaperTools: (failure: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const {
    file: activeFile, paper: activePaper, claim, openPaper, flush, save, accept, markDiskVersion, leavePaper,
  } = documents;
  const { file: activeFileRef, text: sourceRef } = documents.live;
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  // Each paper's download under way (its request id, which Cancel stops) and
  // the timer that clears its "success" glyph, by paper key.
  const paperFetches = useRef<{ requests: Record<string, string>; timers: Record<string, number> }>({ requests: {}, timers: {} });

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
    if (!canDownloadPaper(paper)) {
      if (paper.url) await openUrl(paper.url).catch((reason: unknown) => showError(toMessage(reason)));
      return;
    }
    // Reserve the navigation when the user asks, not after a potentially slow
    // network fetch. Any later file/Paper/asset click invalidates this claim.
    const opening = claim();
    const key = paperKey(paper);
    const requestId = crypto.randomUUID();
    const fetches = paperFetches.current;
    fetches.requests[key] = requestId;
    // Cancel forgets the request at once; whatever the backend answers later is then ignored.
    const live = () => fetches.requests[key] === requestId;
    const clearFetchState = () => setPaperFetchStates((current) => (
      Object.fromEntries(Object.entries(current).filter(([fetching]) => fetching !== key))
    ));
    setPaperFetchStates((current) => ({ ...current, [key]: "loading" }));
    const fetchAndOpen = async () => {
      // Two fetchable shapes: an arXiv id (HTML or PDF route) and a cited
      // webpage (Firecrawl capture). Both return the same bundle contract, so
      // everything after this line treats them identically.
      const arxiv = paper.arxivId && !paper.arxivId.startsWith("web-");
      const result = await invoke<{ arxivId: string; paperPath: string; blogPath?: string | null }>(
        arxiv ? "fetch_paper" : "fetch_web_reference",
        arxiv ? { arxivId: paper.arxivId, requestId } : { url: paper.url, requestId },
      );
      if (!live()) return;
      delete fetches.requests[key];
      await refreshProject();
      const fetched = (await invoke<PaperSummary[]>("list_papers"))
        .find((item) => item.arxivId === result.arxivId) ?? { ...paper, hasFullText: true };
      setPaperFetchStates((current) => ({ ...current, [key]: "success" }));
      if (fetches.timers[key]) window.clearTimeout(fetches.timers[key]);
      fetches.timers[key] = window.setTimeout(() => {
        clearFetchState();
        delete fetches.timers[key];
      }, 1100);
      if (!opening.isCurrent()) return;
      await openPaper(fetched, { claim: opening });
    };
    await fetchAndOpen().catch((reason: unknown) => {
      if (!live()) return;
      delete fetches.requests[key];
      clearFetchState();
      const message = toMessage(reason);
      if (isMissingPaperToolsError(message)) void openForMissingPaperTools(message);
      else if (opening.isCurrent()) showError(message);
    }).finally(() => {
      if (!Object.keys(fetches.requests).length) clearImportStage();
    });
  }, [claim, clearImportStage, openForMissingPaperTools, openPaper, refreshProject]);

  // Stops the downloads under way: the backend kills the converter and keeps
  // nothing, and each paper is back where it was, ready to download again.
  const cancelPaperFetches = () => {
    const { requests } = paperFetches.current;
    const keys = Object.keys(requests);
    for (const key of keys) {
      void invoke("cancel_paper_fetch", { requestId: requests[key] }).catch(() => undefined);
      delete requests[key];
    }
    setPaperFetchStates((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))));
    clearImportStage();
  };

  const readDraggedPaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) void openPaper(paper);
    else if (paper.arxivId || paper.url) void fetchAndOpenPaper(paper);
    else showError(t`This paper has no local reading or downloadable source.`);
  };

  useEffect(() => () => {
    Object.values(paperFetches.current.timers).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const deletePaper = useCallback((paper: PaperSummary) => removeReference(paper, {
    project, captureProjectScope, flush, save, activeFile, activeFileRef, sourceRef, accept, markDiskVersion,
    activePaper, leavePaper, refreshProject, refreshHistory,
  }), [
    accept, activeFile, activeFileRef, activePaper, flush, leavePaper, markDiskVersion, project,
    refreshHistory, refreshProject, save, sourceRef, captureProjectScope,
  ]);

  return { paperFetchStates, fetchAndOpenPaper, cancelPaperFetches, readDraggedPaper, deletePaper };
}
