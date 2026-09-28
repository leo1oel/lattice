import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot, RefreshProject } from "../app-types";
import { toMessage } from "../app-utils";
import { appendBibEntry, formatBibEntry, type BibEntryDraft } from "../papers/bib-entry";
import type { ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import { PAPER_IMPORT_PROGRESS_EVENT } from "../papers/paper-import-progress";
import { isTitleQuery } from "../papers/paper-source";
import { subscribeTauriEvent } from "./effect-helpers";
import { setError, setNotice } from "./notify";

type ImportResult = {
  arxivId: string;
  title: string;
  citationKey?: string;
  alreadyImported: boolean;
  fetchError?: string;
  cancelled?: boolean;
  paperPath?: string;
};

type BibEntryDialog = {
  open: boolean;
  busy: boolean;
  resolving: boolean;
  error: string | null;
  /** Remounts the dialog per opening, so it starts from `initial`. */
  key: number;
  mode: "add" | "edit";
  initial: ResolvedCitationDraft | undefined;
  resolveSeed: string;
  /** Set when an ambiguous import handed its result here for review; saving then imports it. */
  importRoot: string | null;
};

/**
 * Adding references: importing a paper or citation from the Papers sidebar
 * (with the backend's progress stages and cancellation), and the bibliography
 * entry dialog for adding, reviewing or editing a BibTeX entry by hand.
 */
export function useReferenceImport({
  project, projectRootRef, refreshProject, refreshHistory, editor, onCite, onExternalEdits,
}: {
  project: ProjectSnapshot | null;
  projectRootRef: { readonly current: string | null };
  refreshProject: RefreshProject;
  refreshHistory: () => Promise<void>;
  editor: {
    activeFile: string;
    source: string;
    dirty: boolean;
    save: () => Promise<boolean>;
    /** Replace the open file's buffer with what is now on disk. */
    commit: (content: string) => void;
  };
  /** Insert `\cite{key}` at the editor caret. */
  onCite: (key: string) => void;
  /** Hand bibliography writes that bypassed save to Overleaf sync, like any other disk edit. */
  onExternalEdits: { readonly current: (paths: readonly string[]) => void };
}) {
  const { t } = useLingui();
  const [input, setInput] = useState("");
  const [importing, setImporting] = useState(false);
  const inFlightRef = useRef(false);
  const requestIdRef = useRef<string | null>(null);
  const [recentImport, setRecentImport] = useState<{
    projectRoot: string; query: string; citationKey?: string; arxivId: string;
  } | null>(null);
  // Which network step the literature pipeline is in, from the backend's
  // "paper-import-progress" events. Cleared by whichever operation owned the
  // spinner; agent-driven imports run in a separate process and never emit.
  const [stage, setStage] = useState<string | null>(null);
  useEffect(() => subscribeTauriEvent<string>(PAPER_IMPORT_PROGRESS_EVENT, setStage), []);
  const [literatureOpen, setLiteratureOpen] = useState(false);
  const [bibEntry, setBibEntryState] = useState<BibEntryDialog>({
    open: false, busy: false, resolving: false, error: null, key: 0, mode: "add", initial: undefined,
    resolveSeed: "", importRoot: null,
  });
  const setBibEntry = useCallback(
    (update: Partial<BibEntryDialog>) => setBibEntryState((current) => ({ ...current, ...update })),
    [],
  );
  const showBibEntry = useCallback((
    mode: BibEntryDialog["mode"],
    initial: ResolvedCitationDraft | undefined,
    resolveSeed = "",
    importRoot: string | null = null,
  ) => setBibEntryState((current) => ({
    ...current, open: true, error: null, key: current.key + 1, mode, initial, resolveSeed, importRoot,
  })), []);

  const importReference = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || inFlightRef.current) return;
    inFlightRef.current = true;
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    const importRoot = projectRootRef.current;
    const superseded = () => projectRootRef.current !== importRoot || requestIdRef.current !== requestId;
    setImporting(true);
    try {
      let importInput = trimmed;
      // Only ambiguous/incomplete results need review. Import the resolved
      // snapshot, never a second title search that could choose another work.
      if (isTitleQuery(trimmed)) {
        const resolved = await invoke<ResolvedCitationDraft>("resolve_citation_query", { query: trimmed });
        if (superseded()) return;
        if (resolved.candidates?.length || !resolved.bibtex?.trim()) {
          showBibEntry("add", resolved, trimmed, importRoot);
          return;
        }
        importInput = resolved.bibtex;
      }
      const result = await invoke<ImportResult>("import_reference", { input: importInput, requestId });
      if (projectRootRef.current !== importRoot) return;
      if (importRoot) {
        setRecentImport({ projectRoot: importRoot, query: trimmed, citationKey: result.citationKey, arxivId: result.arxivId });
      }
      const snapshot = await refreshProject();
      // papers.rs writes the bibliography directly; hand it to Overleaf sync
      // like any other disk edit instead of waiting for an unrelated save.
      if (!result.alreadyImported && result.citationKey) onExternalEdits.current([snapshot.manifest.primaryBibliography]);
      await refreshHistory();
      // The citation lands even when the download does not (papers.rs commits
      // the bibliography before fetching), so a fetch failure is a notice on a
      // success, not an error. The converter's stderr ends with its one
      // meaningful "Error: …" line; the Papers row keeps a Download button for
      // retrying, which surfaces the full message.
      const fetchNote = result.fetchError
        ?.trim().split("\n").filter((line) => line.trim()).pop()?.replace(/^Error:\s*/, "");
      // "cite it with \cite{…}" over the old "as \cite{…}": the key's whole
      // point is being pasted into the manuscript, so the notice hands over
      // the exact command instead of assuming the reader parses BibTeX-ese.
      const citeHint = result.citationKey ? ` — cite it with \\cite{${result.citationKey}}` : "";
      const citationCommand = `\\cite{${result.citationKey}}`;
      setNotice(result.cancelled
        ? result.citationKey
          ? result.paperPath
            ? t({ message: `Cancellation arrived after “${result.title}” was added — cite it with ${citationCommand}; its full text had already finished importing.` })
            : t({ message: `Import cancelled. “${result.title}” remains in the bibliography — cite it with ${citationCommand}; full-text enrichment stopped.` })
          : result.paperPath
            ? t`Paper import cancelled before changing the bibliography; the downloaded full text remains available.`
            : t`Paper import cancelled before making changes.`
        : result.alreadyImported
        ? `“${result.title}” is already in Papers${citeHint}.`
        : result.arxivId
          ? result.fetchError
            ? `Added “${result.title}” to the bibliography${citeHint}. The full text could not be downloaded: ${fetchNote}`
            : `Imported “${result.title}”${citeHint}.`
          : `Added “${result.title}” to the bibliography${citeHint}. No full text to open.`);
      return result;
    } catch (reason) {
      if (isTitleQuery(trimmed) && superseded()) return;
      setError(toMessage(reason));
      throw reason instanceof Error ? reason : new Error(toMessage(reason));
    } finally {
      inFlightRef.current = false;
      if (requestIdRef.current === requestId) requestIdRef.current = null;
      setImporting(false);
      setStage(null);
    }
  }, [projectRootRef, refreshHistory, refreshProject, showBibEntry, t, onExternalEdits]);

  const cancelImport = useCallback(() => {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    requestIdRef.current = null;
    void invoke("cancel_reference_import", { requestId }).catch((reason) => setError(toMessage(reason)));
  }, []);

  const importFromInput = useCallback(async () => {
    // importReference has already surfaced any failure.
    await importReference(input).catch(() => undefined);
  }, [importReference, input]);

  const openBibEntry = useCallback((resolveSeed = "") => showBibEntry("add", undefined, resolveSeed), [showBibEntry]);

  const editBibEntry = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) return;
    try {
      const entry = await invoke<ResolvedCitationDraft | null>("read_bib_entry", { key: paper.citationKey });
      if (entry) showBibEntry("edit", entry);
      else setError(`Couldn't find a bibliography entry for \\cite{${paper.citationKey}}.`);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [showBibEntry]);

  const resolveBibQuery = useCallback(async (query: string): Promise<ResolvedCitationDraft | null> => {
    setBibEntry({ resolving: true, error: null });
    const resolved = await invoke<ResolvedCitationDraft>("resolve_citation_query", { query }).catch((reason) => {
      setBibEntry({ error: toMessage(reason) });
      return null;
    });
    setBibEntry({ resolving: false });
    return resolved;
  }, [setBibEntry]);

  const { activeFile, source, dirty, save, commit } = editor;
  const saveBibEntry = useCallback(async (draft: BibEntryDraft, insertCite: boolean) => {
    const { importRoot, mode } = bibEntry;
    if (!project || (importRoot !== null && importRoot !== project.root)) return;
    const bibliography = project.manifest.primaryBibliography;
    if (!bibliography) {
      setBibEntry({ error: "This project has no primary bibliography." });
      return;
    }
    if (!draft.title.trim() || !draft.author.trim() || !draft.year.trim()) {
      setBibEntry({ error: "Title, author, and year are required." });
      return;
    }
    setBibEntry({ busy: true, error: null });
    try {
      if (dirty && !(await save())) return;
      if (importRoot !== null && mode === "add") {
        const result = await importReference(formatBibEntry(draft));
        if (!result || projectRootRef.current !== importRoot) return;
        setBibEntry({ open: false, importRoot: null });
        if (insertCite && result.citationKey) onCite(result.citationKey);
        return;
      }
      if (mode === "edit") {
        // The key is read-only when editing, so this replaces the entry in place.
        await invoke("save_bib_entry", { key: draft.key, bibtex: formatBibEntry(draft) });
      } else {
        const existing = bibliography === activeFile
          ? source
          : await invoke<string>("read_project_file", { path: bibliography });
        await invoke("write_project_file", {
          path: bibliography,
          content: appendBibEntry(existing, formatBibEntry(draft)),
          projectRoot: project.root,
        });
      }
      onExternalEdits.current([bibliography]);
      // Re-sync the editor buffer with what's now on disk.
      if (bibliography === activeFile) commit(await invoke<string>("read_project_file", { path: bibliography }));
      await refreshProject();
      setBibEntry({ open: false });
      if (insertCite) onCite(draft.key);
    } catch (reason) {
      setBibEntry({ error: toMessage(reason) });
    } finally {
      setBibEntry({ busy: false });
    }
  }, [
    activeFile, bibEntry, commit, dirty, importReference, onCite, project, projectRootRef,
    refreshProject, save, setBibEntry, source, onExternalEdits,
  ]);

  const clearStage = useCallback(() => setStage(null), []);

  return {
    input, setInput, importing, stage, clearStage, recentImport,
    importReference, importFromInput, cancelImport,
    literatureOpen, setLiteratureOpen,
    bibEntry, setBibEntry, openBibEntry, editBibEntry, resolveBibQuery, saveBibEntry,
  };
}

export type ReferenceImport = ReturnType<typeof useReferenceImport>;
