/**
 * The Zotero library inside Add papers: its folders as a tree to open and
 * search, and the papers of the folder in view, to tick and add. Lattice
 * finds the library itself and reads a copy of its database
 * (src-tauri/src/zotero.rs), so nothing needs turning on in Zotero and it
 * works whether or not Zotero is open; a library kept somewhere Lattice cannot
 * find is chosen by its folder.
 *
 * Folders and papers sit side by side; in a narrow sheet the papers replace
 * the folders and Back (or Escape) returns to them. A paper Papers already
 * holds (same DOI, arXiv id or citation key) is marked and cannot be ticked.
 * The ticked papers go to the sheet's ordinary import queue, each with its
 * PDF attachment, if any, for the import to attach.
 */
import { useEffect, useImperativeHandle, useMemo, useReducer, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, Folder, Library, Plus } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { EmptyState } from "../components/ui/empty-state";
import { SearchField } from "../components/ui/search-field";
import { Switch } from "../components/ui/switch";
import { InfinityLoader } from "../components/ui/activity-icons";
import { hostErrorMessage } from "../app-utils";
import { findInLibrary, parsePastedReferences } from "./paper-add";
import { folderCounts, folderItems, folderRows, type ZoteroItem, type ZoteroLibrary } from "./zotero";

/** A paper as its row shows it. */
export type ZoteroPaper = {
  item: ZoteroItem;
  title: string;
  byline: string;
  /** The paper Papers already holds, if any. */
  existing?: PaperSummary;
};

/** "" stands for My Library, the whole library. */
type FolderKey = string;

type BrowserState = {
  library: ZoteroLibrary | null;
  libraryError: string | null;
  /** The data folder the writer chose; null lets Lattice find it. */
  chosenDir: string | null;
  /** Bumped by Try again. */
  attempt: number;
  expanded: ReadonlySet<string>;
  folderQuery: string;
  paperQuery: string;
  /** The folder in view; null before one is opened. */
  folder: FolderKey | null;
  includeSubfolders: boolean;
  /** Ticked papers by citation key, kept across folders. */
  ticked: ReadonlyMap<string, ZoteroPaper>;
  /** In a narrow sheet, which pane shows. */
  pane: "folders" | "papers";
};

type BrowserAction =
  | { type: "library"; library: ZoteroLibrary }
  | { type: "library-failed"; error: string }
  | { type: "retry" }
  | { type: "chose-dir"; dir: string }
  | { type: "toggle"; key: string; open?: boolean }
  | { type: "folder-query"; query: string }
  | { type: "paper-query"; query: string }
  | { type: "open"; folder: FolderKey }
  | { type: "subfolders"; on: boolean }
  | { type: "tick"; papers: ZoteroPaper[]; on: boolean }
  | { type: "pane"; pane: "folders" | "papers" };

function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case "library": return { ...state, library: action.library, libraryError: null };
    case "library-failed": return { ...state, libraryError: action.error };
    case "retry": return { ...state, library: null, libraryError: null, folder: null, attempt: state.attempt + 1 };
    case "chose-dir": return { ...state, chosenDir: action.dir, library: null, libraryError: null, ticked: new Map(), folder: null };
    case "toggle": {
      const expanded = new Set(state.expanded);
      if (action.open ?? !expanded.has(action.key)) expanded.add(action.key);
      else expanded.delete(action.key);
      return { ...state, expanded };
    }
    case "folder-query": return { ...state, folderQuery: action.query };
    case "paper-query": return { ...state, paperQuery: action.query };
    case "open": return { ...state, folder: action.folder, paperQuery: "", pane: "papers" };
    case "subfolders": return { ...state, includeSubfolders: action.on };
    case "tick": {
      const ticked = new Map(state.ticked);
      for (const paper of action.papers) {
        if (action.on && !paper.existing) ticked.set(paper.item.citationKey, paper);
        else ticked.delete(paper.item.citationKey);
      }
      return { ...state, ticked };
    }
    case "pane": return { ...state, pane: action.pane };
  }
}

/** What the browser hands the sheet: Escape, which steps back a pane first. */
export type ZoteroBrowserHandle = { escape: () => boolean };

export function ZoteroBrowser(props: {
  papers: readonly PaperSummary[];
  /** Another import holds the pipeline. */
  busy: boolean;
  onAdd: (papers: ZoteroPaper[]) => void;
  onBack: () => void;
  handle: Ref<ZoteroBrowserHandle>;
}) {
  const { t } = useLingui();
  const [state, dispatch] = useReducer(browserReducer, {
    library: null, libraryError: null, chosenDir: null, attempt: 0, expanded: new Set<string>(), folderQuery: "",
    paperQuery: "", folder: null, includeSubfolders: false, ticked: new Map(), pane: "folders",
  });
  const { library, folder, includeSubfolders, chosenDir, attempt } = state;

  // One read of one snapshot each time the browser opens (and on Try again or
  // a chosen folder); opening a folder filters it, without reading again.
  useEffect(() => {
    let current = true;
    invoke<ZoteroLibrary>("zotero_library", { dataDir: chosenDir }).then(
      (read) => { if (current) dispatch({ type: "library", library: read }); },
      (reason: unknown) => { if (current) dispatch({ type: "library-failed", error: hostErrorMessage(reason) }); },
    );
    return () => { current = false; };
  }, [attempt, chosenDir]);

  // A folder chosen after the browser closed is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const counts = useMemo(() => (library ? folderCounts(library, includeSubfolders) : new Map<string, number>()), [library, includeSubfolders]);
  const items: ZoteroItem[] = useMemo(
    () => (library && folder !== null ? folderItems(library, folder, includeSubfolders) : []),
    [library, folder, includeSubfolders],
  );
  const papers: ZoteroPaper[] = useMemo(() => items.map((item) => {
    const record = parsePastedReferences(item.bibtex)[0]?.record;
    const title = record?.title || item.citationKey;
    return { item, title, byline: record?.byline ?? "", existing: record ? findInLibrary(props.papers, record.identity) : undefined };
  }), [items, props.papers]);
  const needle = state.paperQuery.trim().toLocaleLowerCase();
  const shownPapers = needle
    ? papers.filter((paper) => `${paper.title} ${paper.byline} ${paper.item.citationKey}`.toLocaleLowerCase().includes(needle))
    : papers;
  const tickable = shownPapers.filter((paper) => !paper.existing);
  const tickedHere = tickable.filter((paper) => state.ticked.has(paper.item.citationKey)).length;
  const ticked = [...state.ticked.values()];

  const rows = library ? folderRows(library.collections, state.expanded, state.folderQuery) : [];
  const folderName = folder === "" ? t`My Library` : library?.collections.find((collection) => collection.key === folder)?.name ?? "";
  const folderHasChildren = Boolean(folder) && Boolean(library?.collections.some((collection) => collection.parent === folder));

  // Escape in a narrow sheet showing papers returns to the folders; anywhere
  // else it leaves the browser (the sheet decides).
  const rootRef = useRef<HTMLDivElement>(null);
  const narrowPapers = state.pane === "papers" && folder !== null;
  useImperativeHandle(props.handle, () => ({
    escape: () => {
      const root = rootRef.current;
      if (!narrowPapers || !root || getComputedStyle(root.querySelector(".zotero-back") ?? root).display === "none") return false;
      dispatch({ type: "pane", pane: "folders" });
      return true;
    },
  }), [narrowPapers]);

  const chooseFolder = async () => {
    const dir = await openDialog({ directory: true, title: t`Choose Zotero folder…` }).catch(() => null);
    if (typeof dir === "string" && mounted.current) dispatch({ type: "chose-dir", dir });
  };

  // Up and Down move between folder rows; Right opens a folder's subfolders,
  // Left closes them.
  const folderKeys = (event: ReactKeyboardEvent<HTMLElement>, row?: { key: string; hasChildren: boolean; expanded: boolean }) => {
    const buttons = [...event.currentTarget.closest(".zotero-tree")?.querySelectorAll<HTMLElement>(".zotero-folder-open") ?? []];
    const at = buttons.indexOf(event.target as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (row?.hasChildren && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      dispatch({ type: "toggle", key: row.key, open: event.key === "ArrowRight" });
    }
  };

  const folderRow = (rowKey: FolderKey, name: string, count: number | null, depth: number, row?: (typeof rows)[number]) => (
    <li key={rowKey || "library"} role="treeitem" aria-expanded={row?.hasChildren ? row.expanded : undefined} aria-selected={folder === rowKey}>
      <div className="zotero-folder" data-selected={folder === rowKey || undefined} style={{ "--zotero-depth": depth } as CSSProperties}>
        {row?.hasChildren ? (
          <button
            type="button"
            className="zotero-folder-toggle"
            tabIndex={-1}
            aria-label={row.expanded ? t`Collapse ${name}` : t`Expand ${name}`}
            data-open={row.expanded || undefined}
            onClick={() => dispatch({ type: "toggle", key: row.key })}
          >
            <ChevronRight size={13} aria-hidden="true" />
          </button>
        ) : <span className="zotero-folder-toggle" aria-hidden="true" />}
        <button type="button" className="zotero-folder-open" onClick={() => dispatch({ type: "open", folder: rowKey })} onKeyDown={(event) => folderKeys(event, row)}>
          {rowKey ? <Folder size={14} aria-hidden="true" /> : <Library size={14} aria-hidden="true" />}
          <span className="zotero-folder-name" title={name}>{name}</span>
          {count !== null && <span className="zotero-count">{count.toLocaleString()}</span>}
        </button>
      </div>
    </li>
  );

  const paperList = () => {
    if (folder === null || !library) return <EmptyState className="zotero-empty" density="compact" title={t`Choose a folder`} />;
    if (!papers.length) return <EmptyState className="zotero-empty" density="compact" title={t`No papers in this folder`} />;
    if (!shownPapers.length) return <EmptyState className="zotero-empty" density="compact" title={t`No matching papers`} />;
    return (
      <ul className="zotero-paper-list" aria-label={folderName}>
        {shownPapers.map((paper) => {
          const on = state.ticked.has(paper.item.citationKey);
          return (
            <li key={paper.item.citationKey} data-existing={paper.existing ? true : undefined}>
              <label className="zotero-paper">
                <Checkbox
                  checked={on}
                  disabled={Boolean(paper.existing)}
                  aria-label={paper.title}
                  onChange={(event) => dispatch({ type: "tick", papers: [paper], on: event.currentTarget.checked })}
                />
                <span className="zotero-paper-main">
                  <strong title={paper.title}>{paper.title}</strong>
                  {paper.byline && <span title={paper.byline}>{paper.byline}</span>}
                </span>
                <span className="zotero-paper-badges">
                  {paper.item.pdf && <Badge size="compact">PDF</Badge>}
                  {paper.existing && <Badge size="compact" tone="success">{t`In Papers`}</Badge>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div ref={rootRef} className="zotero-browser" data-pane={state.pane}>
      <div className="add-papers-body zotero-panes">
        <section className="zotero-folders" aria-label={t`Zotero folders`}>
          <SearchField
            controlSize="compact"
            placeholder={t`Search folders`}
            aria-label={t`Search folders`}
            value={state.folderQuery}
            onChange={(event) => dispatch({ type: "folder-query", query: event.target.value })}
            onClear={() => dispatch({ type: "folder-query", query: "" })}
          />
          {state.libraryError ? (
            <div className="zotero-error" role="alert">
              <span>{state.libraryError}</span>
              <span className="zotero-error-actions">
                <Button variant="secondary" size="compact" onClick={() => dispatch({ type: "retry" })}>{t`Try again`}</Button>
                <Button variant="secondary" size="compact" onClick={() => void chooseFolder()}>{t`Choose Zotero folder…`}</Button>
              </span>
            </div>
          ) : !library ? (
            <div className="zotero-loading"><InfinityLoader size={16} /></div>
          ) : (
            <ul className="zotero-tree" role="tree" aria-label={t`Zotero folders`}>
              {!state.folderQuery.trim() && folderRow("", t`My Library`, null, 0)}
              {rows.map((row) => folderRow(row.key, row.name, counts.get(row.key) ?? 0, row.depth + 1, row))}
              {state.folderQuery.trim() && !rows.length && <li className="zotero-none">{t`No matching folders`}</li>}
            </ul>
          )}
        </section>
        <section className="zotero-papers" aria-label={folderName || t`Papers`}>
          <div className="zotero-papers-head">
            <Button variant="ghost" size="compact" className="zotero-back" onClick={() => dispatch({ type: "pane", pane: "folders" })}>
              <ChevronLeft size={14} aria-hidden="true" />
              {t`Folders`}
            </Button>
            {folder !== null && <strong className="zotero-papers-title" title={folderName}>{folderName}</strong>}
            {folderHasChildren && (
              <label className="zotero-subfolders">
                <span>{t`Include subfolders`}</span>
                <Switch checked={includeSubfolders} label={t`Include subfolders`} onChange={(on) => dispatch({ type: "subfolders", on })} />
              </label>
            )}
          </div>
          {papers.length > 0 && (
            <div className="zotero-papers-tools">
              <label className="zotero-select-all">
                <Checkbox
                  checked={tickable.length > 0 && tickedHere === tickable.length}
                  indeterminate={tickedHere > 0 && tickedHere < tickable.length}
                  disabled={!tickable.length}
                  onChange={(event) => dispatch({ type: "tick", papers: tickable, on: event.currentTarget.checked })}
                />
                <span>{t`Select all`}</span>
              </label>
              <SearchField
                controlSize="compact"
                placeholder={t`Search papers`}
                aria-label={t`Search papers`}
                value={state.paperQuery}
                onChange={(event) => dispatch({ type: "paper-query", query: event.target.value })}
                onClear={() => dispatch({ type: "paper-query", query: "" })}
              />
            </div>
          )}
          <div className="zotero-paper-scroll">{paperList()}</div>
        </section>
      </div>
      <div className="table-generator-actions add-papers-footer">
        <span className="add-papers-summary" role="status">
          {ticked.length === 1 ? t`1 paper selected` : ticked.length ? t`${ticked.length} papers selected` : ""}
        </span>
        <Button variant="ghost" onClick={props.onBack}>{t`Back`}</Button>
        <Button
          variant="primary"
          disabled={!ticked.length || props.busy}
          title={props.busy ? t`Another paper is being added` : undefined}
          onClick={() => props.onAdd(ticked)}
        >
          <Plus size={14} aria-hidden="true" />
          {ticked.length === 1 ? t`Add 1 paper` : ticked.length ? t`Add ${ticked.length} papers` : t`Add papers`}
        </Button>
      </div>
    </div>
  );
}
