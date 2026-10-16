import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary, ProjectSnapshot, RefreshProject } from "../app-types";
import { toMessage } from "../app-utils";
import { isMissingPaperToolsError } from "../build/tex-setup";
import { appendBibEntry, formatBibEntry, type BibEntryDraft } from "../papers/bib-entry";
import { bibEntryKeys } from "../papers/bib-format";
import type { ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import { PAPER_IMPORT_PROGRESS_EVENT } from "../papers/paper-import-progress";
import { isTitleQuery } from "../papers/paper-source";
import { addQueueRunning, cancelAddQueue, runAddQueue, type PaperAddItem } from "../papers/add-papers-queue";
import { subscribeTauriEvent } from "./effect-helpers";
import { showError, showNotice } from "./notify";

type ImportResult = {
  arxivId: string;
  title: string;
  citationKey?: string;
  alreadyImported: boolean;
  fetchError?: string;
  cancelled?: boolean;
  paperPath?: string;
};

/** How much an import says when it ends: everything, only what went wrong or differently, or nothing (its row says it). */
type ImportNotices = "all" | "problems" | "none";

type BibEntryDialog = {
  open: boolean;
  busy: boolean;
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
  project, projectRootRef, refreshProject, refreshHistory, editor, onCite, onExternalEdits, onMissingPaperTools,
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
    /** Durable text for `path` reached disk: show it if `path` is the open file. */
    accept: (path: string, content: string) => void;
  };
  /** Insert `\cite{key}` at the editor caret. */
  onCite: (key: string) => void;
  /** Hand bibliography writes that bypassed save to Overleaf sync, like any other disk edit. */
  onExternalEdits: { readonly current: (paths: readonly string[]) => void };
  /** A lookup or import needed the paper tools, and they are missing: offer the install instead of an error. */
  onMissingPaperTools: (failure: string) => void;
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
  // Adding papers, in one state so startup pays one hook for it: what the
  // running import was given (the Papers pending row names it by this); the
  // papers this window added since the last batch began, by citation key or
  // arXiv id, whose rows say "Just added" with the key to copy instead of a
  // toast; and the Add papers sheet's opening and the query handed to Find
  // literature, each new one remounting its surface.
  const [adding, setAdding] = useState<{
    label: string | null;
    justAdded: { projectRoot: string; keys: ReadonlySet<string> } | null;
    sheet: { open: boolean; key: number; seed: string };
    literature: { query: string; key: number };
  }>({ label: null, justAdded: null, sheet: { open: false, key: 0, seed: "" }, literature: { query: "", key: 0 } });
  const [literatureOpen, setLiteratureOpen] = useState(false);
  // The linked library's sheet (papers/linked-library-sheet.tsx), remounted per opening.
  const [linkedLibrary, setLinkedLibrary] = useState({ open: false, key: 0 });
  const [bibEntry, setBibEntryState] = useState<BibEntryDialog>({
    open: false, busy: false, error: null, key: 0, mode: "add", initial: undefined,
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

  const importReference = useCallback(async (
    query: string,
    { notices = "all", label }: { notices?: ImportNotices; label?: string } = {},
  ) => {
    const trimmed = query.trim();
    if (!trimmed || inFlightRef.current) return;
    inFlightRef.current = true;
    setAdding((current) => ({ ...current, label: label ?? trimmed }));
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
        const added = result.citationKey || result.arxivId;
        if (notices !== "all" && added && !result.cancelled && !result.alreadyImported) {
          setAdding((current) => ({
            ...current,
            justAdded: {
              projectRoot: importRoot,
              keys: new Set([...(current.justAdded?.projectRoot === importRoot ? current.justAdded.keys : []), added]),
            },
          }));
        }
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
      const cited = Boolean(result.citationKey);
      const title = result.title;
      const citationCommand = `\\cite{${result.citationKey}}`;
      // The Papers box's own adds settle as a "Just added" row with the key
      // to copy, so only a cancellation, a duplicate or a missing full text
      // still needs saying; the sheet's rows say even those.
      const quiet = notices === "none"
        || (notices === "problems" && !result.cancelled && !result.alreadyImported && !result.fetchError);
      if (!quiet) showNotice(result.cancelled
        ? result.citationKey
          ? result.paperPath
            ? t({ message: `Cancellation arrived after “${result.title}” was added — cite it with ${citationCommand}; its full text had already finished importing.` })
            : t({ message: `Import cancelled. “${result.title}” remains in the bibliography — cite it with ${citationCommand}; full-text enrichment stopped.` })
          : result.paperPath
            ? t`Paper import cancelled before changing the bibliography; the downloaded full text remains available.`
            : t`Paper import cancelled before making changes.`
        : result.alreadyImported
        ? cited ? t`“${title}” is already in Papers — cite it with ${citationCommand}.` : t`“${title}” is already in Papers.`
        : result.arxivId
          ? result.fetchError
            ? cited
              ? t`Added “${title}” to the bibliography — cite it with ${citationCommand}. The full text could not be downloaded: ${fetchNote}`
              : t`Added “${title}” to the bibliography. The full text could not be downloaded: ${fetchNote}`
            : cited ? t`Imported “${title}” — cite it with ${citationCommand}.` : t`Imported “${title}”.`
          : cited
            ? t`Added “${title}” to the bibliography — cite it with ${citationCommand}. No full text to open.`
            : t`Added “${title}” to the bibliography. No full text to open.`);
      return result;
    } catch (reason) {
      if (isTitleQuery(trimmed) && superseded()) return;
      const message = toMessage(reason);
      if (isMissingPaperToolsError(message)) onMissingPaperTools(message);
      else if (notices !== "none") showError(message);
      throw reason instanceof Error ? reason : new Error(message);
    } finally {
      inFlightRef.current = false;
      if (requestIdRef.current === requestId) requestIdRef.current = null;
      setImporting(false);
      setAdding((current) => ({ ...current, label: null }));
      setStage(null);
    }
  }, [projectRootRef, refreshHistory, refreshProject, showBibEntry, t, onExternalEdits, onMissingPaperTools]);

  // Cancel stops the paper being imported and, in a batch, every one still waiting.
  const cancelImport = useCallback(() => {
    cancelAddQueue();
    const requestId = requestIdRef.current;
    if (!requestId) return;
    requestIdRef.current = null;
    void invoke("cancel_reference_import", { requestId }).catch((reason) => showError(toMessage(reason)));
  }, []);

  // Setters only, so built once: openers for the sheet, Find literature and
  // the entry form, and the start of a batch, which retires "Just added".
  const [requestActions] = useState(() => ({
    openAddSheet: (seed = "") => setAdding((current) => ({ ...current, sheet: { open: true, key: current.sheet.key + 1, seed } })),
    closeAddSheet: () => setAdding((current) => ({ ...current, sheet: { ...current.sheet, open: false } })),
    searchLiterature: (query: string) => setAdding((current) => ({
      ...current, literature: { query: query.trim(), key: current.literature.key + 1 },
    })),
    // The sheet's way to the form: straight to the fields, no lookup first.
    enterBibEntryManually: () => setBibEntryState((current) => ({
      ...current, open: true, error: null, key: current.key + 1, mode: "add", resolveSeed: "", importRoot: null,
      initial: { key: "", title: "", author: "", year: "", journal: "", booktitle: "", publisher: "", url: "", doi: "", entryType: "article" },
    })),
    openLinkedLibrary: () => setLinkedLibrary((current) => ({ open: true, key: current.key + 1 })),
    closeLinkedLibrary: () => setLinkedLibrary((current) => ({ ...current, open: false })),
    startBatch: () => {
      const root = projectRootRef.current;
      setAdding((current) => ({ ...current, justAdded: root ? { projectRoot: root, keys: new Set() } : null }));
    },
  }));
  const { startBatch } = requestActions;

  const importFromInput = useCallback(async () => {
    if (addQueueRunning()) return;
    startBatch();
    // importReference has already surfaced any failure.
    await importReference(input, { notices: "problems" }).catch(() => undefined);
  }, [importReference, input, startBatch]);

  /**
   * The Add papers sheet's batch (papers/add-papers-queue.ts): one import
   * after another, so each gets the pipeline's progress and its own Cancel,
   * while the writer keeps writing with the sheet closed.
   */
  const addPapers = (items: ReadonlyArray<Pick<PaperAddItem, "id" | "input" | "label">>) => {
    if (inFlightRef.current || addQueueRunning()) return;
    const root = projectRootRef.current;
    startBatch();
    void runAddQueue(items, (item) => importReference(item.input, { notices: "none", label: item.label }), () => projectRootRef.current === root);
  };

  const openBibEntry = useCallback((resolveSeed = "") => showBibEntry("add", undefined, resolveSeed), [showBibEntry]);

  const editBibEntry = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) return;
    try {
      const entry = await invoke<ResolvedCitationDraft | null>("read_bib_entry", { key: paper.citationKey });
      if (entry) showBibEntry("edit", entry);
      else {
        const citationCommand = `\\cite{${paper.citationKey}}`;
        showError(t`Couldn't find a bibliography entry for ${citationCommand}.`);
      }
    } catch (reason) {
      showError(toMessage(reason));
    }
  }, [showBibEntry, t]);

  // The dialog owns the lookup, its in-flight state and its error, so one it
  // abandoned (Enter manually, a new query, closing) cannot block saving or
  // closing, or report into a later draft. A new lookup supersedes the last save's error.
  const resolveBibQuery = useCallback((query: string) => {
    setBibEntry({ error: null });
    return invoke<ResolvedCitationDraft>("resolve_citation_query", { query }).catch((reason: unknown) => {
      if (isMissingPaperToolsError(toMessage(reason))) onMissingPaperTools(toMessage(reason));
      throw reason;
    });
  }, [onMissingPaperTools, setBibEntry]);

  const { activeFile, source, dirty, save, accept } = editor;
  const saveBibEntry = useCallback(async (draft: BibEntryDraft, insertCite: boolean) => {
    const { importRoot, mode } = bibEntry;
    if (!project || (importRoot !== null && importRoot !== project.root)) return;
    const bibliography = project.manifest.primaryBibliography;
    if (!bibliography) {
      setBibEntry({ error: t`This project has no primary bibliography.` });
      return;
    }
    if (!draft.title.trim() || !draft.author.trim() || !draft.year.trim()) {
      setBibEntry({ error: t`Title, author, and year are required.` });
      return;
    }
    setBibEntry({ busy: true, error: null });
    try {
      if (dirty && !(await save())) return;
      if (importRoot !== null && mode === "add") {
        // The record a title from the Papers box resolved to: it settles in
        // the list as "Just added", like the box's other adds.
        const result = await importReference(formatBibEntry(draft), { notices: "problems", label: draft.title });
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
      if (bibliography === activeFile) accept(bibliography, await invoke<string>("read_project_file", { path: bibliography }));
      await refreshProject();
      setBibEntry({ open: false });
      if (insertCite) onCite(draft.key);
    } catch (reason) {
      setBibEntry({ error: toMessage(reason) });
    } finally {
      setBibEntry({ busy: false });
    }
  }, [
    accept, activeFile, bibEntry, dirty, importReference, onCite, project, projectRootRef,
    refreshProject, save, setBibEntry, source, onExternalEdits, t,
  ]);

  /**
   * Rewrite a bibliography from what is on disk now (`change` maps the text
   * read to the text to write), as one undoable edit, after saving the open
   * file. Reading at the last moment, rather than when a preview was shown,
   * keeps a sync that landed in between.
   */
  const rewriteBibliography = useCallback(async (path: string, change: (current: string) => string) => {
    if (!project) return false;
    const root = project.root;
    if (dirty && !(await save())) throw new Error(t`Save the open file first.`);
    const current = await invoke<string>("read_project_file", { path, projectRoot: root });
    const content = change(current);
    if (content === current || projectRootRef.current !== root) return false;
    await invoke("write_project_file", { path, content, projectRoot: root, baseContent: current });
    onExternalEdits.current([path]);
    if (path === activeFile) accept(path, await invoke<string>("read_project_file", { path }));
    await refreshProject();
    await refreshHistory();
    return true;
  }, [accept, activeFile, dirty, onExternalEdits, project, projectRootRef, refreshHistory, refreshProject, save, t]);

  /**
   * A bibliography entry for `query` (a DOI, arXiv id or title) without its
   * full text, answering its key: Find support's Cite needs the key at once,
   * not after a download. A lookup that is unsure (several candidates, no
   * BibTeX) opens the entry form on what it found and answers null, as does
   * a key the bibliography already gives another work; the same work
   * answers the key it already has.
   */
  const addCitation = useCallback(async (query: string): Promise<string | null> => {
    const root = project?.root;
    const bibliography = project?.manifest.primaryBibliography;
    if (!root) return null;
    if (!bibliography) {
      showError(t`This project has no primary bibliography.`);
      return null;
    }
    let resolved: ResolvedCitationDraft;
    try {
      resolved = await invoke<ResolvedCitationDraft>("resolve_citation_query", { query });
    } catch (reason) {
      const message = toMessage(reason);
      if (isMissingPaperToolsError(message)) onMissingPaperTools(message);
      else showError(message);
      return null;
    }
    if (projectRootRef.current !== root) return null;
    const key = resolved.key?.trim();
    const bibtex = resolved.bibtex?.trim();
    if (resolved.candidates?.length || !bibtex || !key) {
      showBibEntry("add", resolved, query);
      return null;
    }
    if (dirty && !(await save())) return null;
    const existing = bibliography === activeFile
      ? source
      : await invoke<string>("read_project_file", { path: bibliography });
    if (projectRootRef.current !== root) return null;
    if (bibEntryKeys(existing).some((item) => item.toLowerCase() === key.toLowerCase())) {
      const known = existing.toLowerCase();
      const same = resolved.doi ? known.includes(resolved.doi.toLowerCase()) : known.includes(resolved.title.toLowerCase());
      if (same) return key;
      showBibEntry("add", resolved, query);
      return null;
    }
    await invoke("write_project_file", { path: bibliography, content: appendBibEntry(existing, bibtex), projectRoot: root });
    onExternalEdits.current([bibliography]);
    if (bibliography === activeFile) accept(bibliography, await invoke<string>("read_project_file", { path: bibliography }));
    await refreshProject();
    return key;
  }, [accept, activeFile, dirty, onExternalEdits, onMissingPaperTools, project, projectRootRef, refreshProject, save, showBibEntry, source, t]);

  const clearStage = useCallback(() => setStage(null), []);

  return {
    input, setInput, importing, stage, clearStage, recentImport, importLabel: adding.label, justAdded: adding.justAdded,
    importReference, importFromInput, cancelImport, addCitation,
    addSheet: adding.sheet, addPapers, ...requestActions,
    literatureOpen, setLiteratureOpen, literatureSeed: adding.literature,
    linkedLibrary, rewriteBibliography,
    projectRoot: project?.root ?? null, bibliography: project?.manifest.primaryBibliography ?? "",
    bibEntry, setBibEntry, openBibEntry, editBibEntry, resolveBibQuery, saveBibEntry,
  };
}

export type ReferenceImport = ReturnType<typeof useReferenceImport>;
