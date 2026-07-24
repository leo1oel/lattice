import { Fragment, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  BookMarked,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  Download,
  File,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  ImagePlus,
  Library,
  LoaderCircle,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { SpinButton } from "./motion";
import { Tip } from "./components/icon-tip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { clamp, loadNavigatorSplit, persistNavigatorSplit } from "./app-settings";
import { paperKey, paperSubtitle, CITE_COMMANDS } from "./app-utils";
import type { FileNode, PaperSummary, CiteCommand, ProjectSearchResult } from "./app-types";

export function Navigator(props: {
  files: FileNode[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string, line?: number) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<void>;
  onDeleteEntry: (path: string) => void;
  onRenameEntry: (path: string, name: string) => void;
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onImportAssets: (targetDirectory?: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
  onPaper: (paper: PaperSummary) => void;
  onCitePaper: (paper: PaperSummary, command: CiteCommand) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  onAddBibEntry: () => void;
  onDiscoverLiterature: () => void;
  onDeletePaper: (paper: PaperSummary) => void;
  onRenamePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
}) {
  const navigatorRef = useRef<HTMLElement | null>(null);
  const [navigatorSplit, setNavigatorSplit] = useState(loadNavigatorSplit);
  const [entryFormOpen, setEntryFormOpen] = useState(false);
  const [entryPath, setEntryPath] = useState("");
  const [entryKind, setEntryKind] = useState<"file" | "folder">("file");
  const [entryBusy, setEntryBusy] = useState(false);
  // The entry form closes when focus leaves it, but opening the type Select
  // moves focus into a portaled listbox; this ref lets the blur handler tell
  // "the dropdown is open" apart from "the user clicked away".
  const entryTypeOpenRef = useRef(false);
  const [citeMenuId, setCiteMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectSearchResult[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setSearching(true);
      void invoke<ProjectSearchResult[]>("search_project", { query })
        .then((results) => {
          if (active) {
            setSearchResults(results);
            setSearchResultQuery(query);
          }
        })
        .catch(() => {
          if (active) {
            setSearchResults([]);
            setSearchResultQuery(query);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);
  const searchActive = Boolean(searchQuery.trim());
  const searchPending = searchActive && searchResultQuery !== searchQuery.trim();
  const visibleSearchResults = searchActive && searchResultQuery === searchQuery.trim() ? searchResults : [];
  const fileSearchResults = visibleSearchResults.filter((result) => result.kind === "file");
  const paperSearchResults = visibleSearchResults.filter((result) => result.kind === "paper");
  const paperResultCount = searchPending ? "…" : paperSearchResults.length;
  useEffect(() => {
    if (!citeMenuId) return;
    const close = () => setCiteMenuId(null);
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [citeMenuId]);
  const directoryForCreate = (path: string, kind: "project" | "directory" | "file") => {
    if (!path || kind === "project") return "";
    if (kind === "directory") return path;
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
  };
  const openCreateForm = (kind: "file" | "folder", basePath = "", baseKind: "project" | "directory" | "file" = "project") => {
    const directory = directoryForCreate(basePath, baseKind);
    setEntryKind(kind);
    setEntryPath(directory ? `${directory}/` : "");
    setEntryFormOpen(true);
  };
  const closeEntryForm = () => {
    if (entryBusy) return;
    setEntryFormOpen(false);
    setEntryPath("");
  };
  const submitEntry = async () => {
    if (!entryPath.trim() || entryBusy) return;
    setEntryBusy(true);
    try {
      await props.onCreateEntry(entryPath.trim(), entryKind);
      setEntryPath("");
      setEntryFormOpen(false);
    } catch {
      // The workspace error banner explains why creation failed.
    } finally {
      setEntryBusy(false);
    }
  };
  // Wrap a tree/paper row with a Radix ContextMenu (right-click). The items are
  // computed from the row's target, matching the old hand-rolled menu.
  const renderItemContextMenu = (
    target: { path: string; label: string; kind: "project" | "directory" | "file"; paper?: PaperSummary },
    children: React.ReactElement,
  ) => {
    const { path, label, kind, paper } = target;
    const isProtected = props.protectedPaths.some((entry) => entry === path || path.startsWith(`${entry}/`));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {!paper && (
            <>
              <ContextMenuItem onSelect={() => openCreateForm("file", path, kind)}><FilePlus size={14} />New file</ContextMenuItem>
              <ContextMenuItem onSelect={() => openCreateForm("folder", path, kind)}><FolderPlus size={14} />New folder</ContextMenuItem>
            </>
          )}
          {(paper || path) && (
            <ContextMenuItem onSelect={() => (paper ? props.onRenamePaper(paper) : props.onRenameEntry(path, label))}>
              <Pencil size={14} />Rename
            </ContextMenuItem>
          )}
          {path && !paper && (
            <ContextMenuItem onSelect={() => void writeText(path)}><Copy size={14} />Copy path</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => props.onReveal(path)}><FolderOpen size={14} />Show in Finder</ContextMenuItem>
          {path && !paper && !isProtected && (
            <ContextMenuItem variant="destructive" onSelect={() => props.onDeleteEntry(path)}><Trash2 size={14} />Delete</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const setSplitFromPointer = (clientY: number) => {
    const bounds = navigatorRef.current?.getBoundingClientRect();
    if (!bounds?.height) return navigatorSplit;
    const next = clamp((clientY - bounds.top) / bounds.height, 0.2, 0.78);
    setNavigatorSplit(next);
    return next;
  };
  const beginNavigatorSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let latest = navigatorSplit;
    document.body.classList.add("resizing-navigator-split");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = setSplitFromPointer(moveEvent.clientY);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-navigator-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistNavigatorSplit(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeNavigatorSplit = (delta: number) => {
    const next = clamp(navigatorSplit + delta, 0.2, 0.78);
    setNavigatorSplit(next);
    persistNavigatorSplit(next);
  };
  return (
    <aside
      ref={navigatorRef}
      className={`navigator ${props.assetDropTarget ? "asset-drag-active" : ""}`}
      style={{ gridTemplateRows: `minmax(100px, ${navigatorSplit}fr) 5px minmax(140px, ${1 - navigatorSplit}fr)` }}
    >
      <div className="navigator-section project-section" onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".project-entry-form") && !target.closest(".section-action")) closeEntryForm();
      }}>
        {renderItemContextMenu({ path: "", label: "Project folder", kind: "project" }, (
          <div className="section-heading">
            <span>Project</span>
            <div className="section-heading-actions">
              <Tip label="Refresh files">
                <SpinButton className="section-action" onClick={props.onRefresh}><RefreshCw size={13} strokeWidth={1.8} /></SpinButton>
              </Tip>
              <Tip label="Add file or folder">
                <button className="section-action" onClick={() => {
                  if (entryFormOpen) closeEntryForm();
                  else openCreateForm("file");
                }}><FolderPlus size={14} strokeWidth={1.8} /></button>
              </Tip>
            </div>
          </div>
        ))}
        <label className="navigator-search">
          <Search size={13} />
          <input aria-label="Filter project files and papers" placeholder="Filter files and papers" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          {searchPending || searching ? <LoaderCircle className="spin" size={12} /> : searchActive && <button title="Clear search" onClick={() => setSearchQuery("")}><X size={12} /></button>}
        </label>
        {entryFormOpen && (
          <div className="project-entry-form" onBlur={(event) => {
            if (entryTypeOpenRef.current) return;
            if (!event.currentTarget.contains(event.relatedTarget)) closeEntryForm();
          }}>
            <Select value={entryKind} onValueChange={(value) => setEntryKind(value as "file" | "folder")} onOpenChange={(open) => { entryTypeOpenRef.current = open; }}>
              <SelectTrigger aria-label="Entry type" className="entry-type-select"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="file">File</SelectItem>
                <SelectItem value="folder">Folder</SelectItem>
              </SelectContent>
            </Select>
            <input
              autoFocus
              aria-label="Project-relative path"
              placeholder={entryKind === "file" ? "sections/method.tex or notes.md" : "figures/results"}
              value={entryPath}
              onChange={(event) => setEntryPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitEntry();
                if (event.key === "Escape") closeEntryForm();
              }}
            />
            <button title="Create" disabled={entryBusy || !entryPath.trim()} onClick={() => void submitEntry()}>
              {entryBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            </button>
          </div>
        )}
        <div className="file-tree">
          {searchActive ? fileSearchResults.map((result, index) => (
            <button
              key={`${result.path}:${result.line ?? 0}:${index}`}
              className="navigator-search-result"
              onClick={() => result.fileKind === "figure"
                ? props.onAsset(result.path)
                : props.onFile(result.path, result.line ?? undefined)}
            >
              {result.fileKind === "figure" ? <Image size={13} /> : <FileText size={13} />}
              <span>
                <strong>{result.title}</strong>
                <small>
                  {result.line ? `L${result.line} · ` : ""}
                  {result.snippet || result.path}
                </small>
              </span>
            </button>
          )) : props.files.map((node) => <TreeNode key={node.path} node={node} activeFile={props.activeFile} activeAssetPath={props.activeAssetPath} protectedPaths={props.protectedPaths} onFile={props.onFile} onAsset={props.onAsset} onBeginFigureDrag={props.onBeginFigureDrag} onDelete={props.onDeleteEntry} onImportAssets={props.onImportAssets} assetDropTarget={props.assetDropTarget} assetImporting={props.assetImporting} renderContextMenu={renderItemContextMenu} />)}
          {searchActive && !searchPending && !searching && !fileSearchResults.length && <p className="search-empty">No matching project files.</p>}
        </div>
      </div>
      <div
        className="navigator-split-resizer"
        role="separator"
        aria-label="Resize Project and Papers"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={78}
        aria-valuenow={Math.round(navigatorSplit * 100)}
        tabIndex={0}
        onPointerDown={beginNavigatorSplitResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            nudgeNavigatorSplit(-0.03);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            nudgeNavigatorSplit(0.03);
          }
        }}
      />
      <div className="navigator-section papers-section">
        <div className="section-heading">
          <span>Papers</span>
          <div className="section-heading-actions">
            <button className="section-action" title="Discover literature (OpenAlex)" aria-label="Discover literature" onClick={props.onDiscoverLiterature}>
              <Search size={14} strokeWidth={1.8} />
            </button>
            <button className="section-action" title="Add bibliography entry" aria-label="Add bibliography entry" onClick={props.onAddBibEntry}>
              <BookMarked size={14} strokeWidth={1.8} />
            </button>
            <span className="count-badge">{searchActive ? paperResultCount : props.papers.length}</span>
          </div>
        </div>
        <div className="paper-list" role="list" aria-label="Papers">
          {(searchActive ? paperSearchResults.map((result) => props.papers.find((paper) => paper.arxivId === result.arxivId)).filter((paper): paper is PaperSummary => Boolean(paper)) : props.papers).map((paper) => {
            const row = (
              <div className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${props.activePaper && paperKey(props.activePaper) === paperKey(paper) ? "active" : ""}`}>
              <button
                title={paper.hasFullText
                  ? paper.title
                  : paper.arxivId
                    ? `Fetch the full text of arXiv ${paper.arxivId}`
                    : `${paper.title} — cited only, no full text available`}
                className="paper-open"
                // Knowing the preprint is as good as having it: clicking fetches.
                disabled={!paper.hasFullText && !paper.arxivId}
                onClick={() => paper.hasFullText ? props.onPaper(paper) : props.onFetchFullText(paper)}
              >
                {paper.hasFullText ? <BookOpen size={14} /> : paper.arxivId ? <Download size={14} /> : <BookMarked size={14} />}
                <span><strong>{paper.title}</strong><small>{paperSubtitle(paper, searchActive ? paperSearchResults.find((result) => result.arxivId === paper.arxivId)?.snippet : undefined)}</small></span>
              </button>
              {paper.citationKey && (
                <div className="cite-menu-wrap">
                  <button
                    className="row-cite"
                    title={`Insert citation for ${paper.citationKey}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCiteMenuId((current) => current === paperKey(paper) ? null : paperKey(paper));
                    }}
                  >
                    <Quote size={12} />
                  </button>
                  {citeMenuId === paperKey(paper) && (
                    <div className="cite-command-menu" onPointerDown={(event) => event.stopPropagation()}>
                      {CITE_COMMANDS.map((command) => (
                        <button
                          key={command}
                          type="button"
                          onClick={() => {
                            props.onCitePaper(paper, command);
                            setCiteMenuId(null);
                          }}
                        >
                          \{command}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {paper.citationKey && (
                <button className="row-edit-bib" title="Edit bibliography entry" onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
              )}
              <button className="row-delete" title={`Remove ${paper.title}`} onClick={() => props.onDeletePaper(paper)}><Trash2 size={12} /></button>
              </div>
            );
            // A cited-only paper has no local file to act on, so it stays bare;
            // one with full text gets the same right-click menu as a tree file.
            return (
              <Fragment key={paperKey(paper)}>
                {paper.hasFullText
                  ? renderItemContextMenu({ path: `.research/papers/${paper.arxivId}/paper.md`, label: paper.title, kind: "file", paper }, row)
                  : row}
              </Fragment>
            );
          })}
          {!searchActive && !props.papers.length && <p className="empty-note">Add an arXiv paper to ground the agent in project evidence.</p>}
          {searchActive && !searchPending && !searching && !paperSearchResults.length && <p className="search-empty">No matching papers.</p>}
        </div>
        <div className="import-box">
          <input
            placeholder="arXiv URL or id"
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && props.onImport()}
          />
          <button onClick={props.onImport} disabled={props.importing || !props.importInput.trim()} title="Import paper">
            {props.importing ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function TreeNode({ node, activeFile, activeAssetPath, protectedPaths, onFile, onAsset, onBeginFigureDrag, onDelete, onImportAssets, assetDropTarget, assetImporting, renderContextMenu }: { node: FileNode; activeFile: string; activeAssetPath: string; protectedPaths: string[]; onFile: (path: string) => void; onAsset: (path: string) => void; onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void; onDelete: (path: string) => void; onImportAssets: (targetDirectory?: string) => void; assetDropTarget: string | null; assetImporting: boolean; renderContextMenu: (target: { path: string; label: string; kind: "project" | "directory" | "file" }, children: React.ReactElement) => React.ReactElement }) {
  const [open, setOpen] = useState(true);
  const protectedEntry = protectedPaths.some((path) => path === node.path || path.startsWith(`${node.path}/`));
  if (node.kind === "directory") {
    return (
      <div className={`tree-directory ${assetDropTarget === node.path ? "drop-target" : ""}`} data-drop-directory={node.path}>
        {renderContextMenu({ path: node.path, label: node.name, kind: "directory" }, (
          <div className="tree-row">
            <button className="tree-main" onClick={() => setOpen((value) => !value)}>
              <ChevronRight className={`tree-chevron ${open ? "open" : ""}`} size={13} />
              <Folder size={14} /> <span>{node.name}</span>
            </button>
            {node.path === "figures" && <button className="row-import" title="Import images into figures" disabled={assetImporting} onClick={() => onImportAssets(node.path)}>{assetImporting ? <LoaderCircle className="spin" size={12} /> : <ImagePlus size={12} />}</button>}
            {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
          </div>
        ))}
        {assetDropTarget === node.path && <div className="asset-drop-hint">Drop images into {node.path}</div>}
        {open && <div className="tree-children">{node.children.map((child) => <TreeNode key={child.path} node={child} activeFile={activeFile} activeAssetPath={activeAssetPath} protectedPaths={protectedPaths} onFile={onFile} onAsset={onAsset} onBeginFigureDrag={onBeginFigureDrag} onDelete={onDelete} onImportAssets={onImportAssets} assetDropTarget={assetDropTarget} assetImporting={assetImporting} renderContextMenu={renderContextMenu} />)}</div>}
      </div>
    );
  }
  const Icon = node.kind === "tex" ? FileCode2 : node.kind === "bib" ? Library : File;
  if (node.kind === "figure") {
    return renderContextMenu({ path: node.path, label: node.name, kind: "file" }, (
      <div className={`tree-row asset-row ${activeAssetPath === node.path ? "active" : ""}`}>
        <button
          className="tree-main"
          title={`Preview ${node.name}; drag into the LaTeX editor to insert`}
          onClick={() => onAsset(node.path)}
          onPointerDown={(event) => onBeginFigureDrag(node.path, node.name, event)}
        ><span className="tree-spacer" /><Image size={14} /><span>{node.name}</span></button>
        {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
      </div>
    ));
  }
  return renderContextMenu({ path: node.path, label: node.name, kind: "file" }, (
    <div className={`tree-row ${activeFile === node.path ? "active" : ""}`}>
      <button className="tree-main" onClick={() => onFile(node.path)}><span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span></button>
      {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
    </div>
  ));
}
