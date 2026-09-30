import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type {
  BuildResult, CanvasMode, DocumentViewMode, FileViewState, PaperSummary, ProjectSnapshot, SettingsTab,
} from "../app-types";
import { arxivIdFromTabKey, isHtmlFilePath, isPaperTabKey } from "../app-utils";
import type { ReferenceAssetPreview } from "../project/reference-preview";
import type { TrellisBridge, TrellisController } from "../trellis/trellis-controller";
import type { SearchDialog } from "./app-search-dialogs";
import { setNotice } from "./notify";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { PaperView } from "./use-document-buffers";
import type { useEditorComments } from "./use-editor-comments";
import type { useProjectSearch } from "./use-project-search";
import type { useReferenceImport } from "./use-reference-import";
import type { useSynaraHost } from "./use-synara-host";

/** What the Trellis workspace reads from App: the open document, the project, and the actions its panels call. */
export type TrellisBridgeApp = {
  trellis: TrellisController;
  project: ProjectSnapshot | null;
  projectRef: RefObject<ProjectSnapshot | null>;
  projectAssetPaths: Set<string>;
  papers: PaperSummary[];
  activeFile: string;
  activeFileRef: RefObject<string>;
  activeTabKey: string;
  activePaper: PaperSummary | null;
  activePaperDirty: boolean;
  activeAsset: ReferenceAssetPreview | null;
  source: string;
  sourceRef: RefObject<string>;
  savedSource: string;
  openTabs: string[];
  tabsSettledRoot: string | null;
  workspacePersistenceReadyRoot: string | null;
  canvasMode: CanvasMode;
  paperView: PaperView | null;
  paperMarkdown: string;
  paperBlog: string | null;
  build: BuildResult | null;
  building: boolean;
  buildPipeline: Pick<ReturnType<typeof useBuildPipeline>, "cleanAndRebuild" | "abortBuild">;
  synara: Pick<ReturnType<typeof useSynaraHost>, "requestRuntime" | "mountFrame" | "notifyPanelOpened">;
  editorComments: Pick<ReturnType<typeof useEditorComments>, "openPanel">;
  referenceImport: Pick<ReturnType<typeof useReferenceImport>, "setLiteratureOpen" | "openBibEntry">;
  projectSearch: Pick<ReturnType<typeof useProjectSearch>, "openFind">;
  getFileViewState: (path: string) => FileViewState | undefined;
  openProjectFile: (path: string, line?: number) => Promise<void>;
  selectEditorTab: (path: string) => void;
  closeEditorTab: (path: string) => Promise<void>;
  save: () => Promise<boolean>;
  compile: (force?: boolean, sound?: boolean) => Promise<void>;
  compileAndShowPdf: (force?: boolean, sound?: boolean) => Promise<void>;
  revealSourceInPdf: () => Promise<void>;
  openDocumentMode: (mode: DocumentViewMode) => void;
  changePaperView: (view: "blog" | "fulltext") => void;
  openSettings: (tab?: SettingsTab) => void;
  openLiterature: (open: SetStateAction<boolean>) => void;
  refreshTodos: () => Promise<void>;
  setSearchDialog: Dispatch<SetStateAction<SearchDialog | null>>;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  setGitOpen: Dispatch<SetStateAction<boolean>>;
  setTodosOpen: Dispatch<SetStateAction<boolean>>;
  setChecklistOpen: Dispatch<SetStateAction<boolean>>;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  setBibliographyAuditRoot: Dispatch<SetStateAction<string | null>>;
  setBibliographyAuditOpen: Dispatch<SetStateAction<boolean>>;
  setSpreadsheetCreateRequest: Dispatch<SetStateAction<number>>;
  setBoardCreateRequest: Dispatch<SetStateAction<number>>;
  setPresentationCreateRequest: Dispatch<SetStateAction<number>>;
};

/**
 * Connects App to the Trellis workspace: the bridge the workspace calls at event time, and the stores
 * (`app`, `texts`, `docTools`) its panels read.
 */
export function useTrellisBridge(app: TrellisBridgeApp) {
  const { t } = useLingui();
  const {
    trellis, project, projectRef, projectAssetPaths, papers, activeFile, activeFileRef, activeTabKey, activePaper,
    activePaperDirty, activeAsset, source, sourceRef, savedSource, openTabs, tabsSettledRoot,
    workspacePersistenceReadyRoot, canvasMode, paperView, paperMarkdown, paperBlog, build, building, buildPipeline,
    synara, editorComments, referenceImport, projectSearch, getFileViewState, openProjectFile, selectEditorTab,
    closeEditorTab, save, compile, compileAndShowPdf, revealSourceInPdf, openDocumentMode, changePaperView,
    openSettings, openLiterature, refreshTodos, setSearchDialog, setHistoryOpen, setGitOpen, setTodosOpen,
    setChecklistOpen, setProjectSearchOpen, setBibliographyAuditRoot, setBibliographyAuditOpen,
    setSpreadsheetCreateRequest, setBoardCreateRequest, setPresentationCreateRequest,
  } = app;
  const trellisDirty = activePaper ? activePaperDirty : source !== savedSource;
  const trellisFilesRevisionRef = useRef<{ files: unknown; revision: number }>({ files: null, revision: 0 });
  useLayoutEffect(() => {
    const bridge: TrellisBridge = {
      activate: (key, line) => {
        if (line !== undefined && !isPaperTabKey(key) && !projectAssetPaths.has(key)) void openProjectFile(key, line);
        else selectEditorTab(key);
      },
      closeTab: async (key) => {
        await closeEditorTab(key);
        return true;
      },
      save,
      tabKind: (key) => (isPaperTabKey(key) ? "paper" : projectAssetPaths.has(key) ? "asset" : "file"),
      tabLabel: (key) => (isPaperTabKey(key)
        ? papers.find((paper) => paper.arxivId === arxivIdFromTabKey(key))?.title ?? t`Paper`
        : key.split("/").at(-1) || key),
      readText: async (path) => {
        if (path === activeFileRef.current) return sourceRef.current;
        const root = projectRef.current?.root;
        if (!root) return null;
        try {
          return await invoke<string>("read_project_file", { path, projectRoot: root });
        } catch {
          return null;
        }
      },
      textScrollTop: (path) => getFileViewState(path)?.text?.scrollTop ?? null,
      openTool: (kind) => {
        if (trellis.openDrawers.get()[kind]) {
          trellis.revealTool(kind);
          return;
        }
        if (kind === "history") setHistoryOpen(true);
        else if (kind === "git") {
          synara.requestRuntime();
          setGitOpen(true);
        } else if (kind === "comments" || kind === "overleaf") editorComments.openPanel();
        else if (kind === "literature") referenceImport.setLiteratureOpen(true);
        else if (kind === "todos") {
          void refreshTodos();
          setTodosOpen(true);
        } else setChecklistOpen(true);
      },
      agentShown: () => {
        synara.mountFrame();
        synara.notifyPanelOpened();
      },
      notify: (message) => setNotice(message),
      panelMenu: (kind) => {
        if (kind === "project") {
          return [
            { id: "new-spreadsheet", label: t`New spreadsheet`, run: () => setSpreadsheetCreateRequest((request) => request + 1) },
            { id: "new-board", label: t`New board`, run: () => setBoardCreateRequest((request) => request + 1) },
            { id: "new-presentation", label: t`New presentation`, run: () => setPresentationCreateRequest((request) => request + 1) },
            { id: "find", label: t`Find in project`, run: () => { setProjectSearchOpen(false); projectSearch.openFind(); } },
          ];
        }
        if (kind === "papers") {
          return [
            { id: "discover", label: t`Discover literature`, run: () => openLiterature(true) },
            { id: "bib-entry", label: t`Add bibliography entry`, run: () => referenceImport.openBibEntry() },
            {
              id: "check-references", label: t`Check references`, run: () => {
                const root = projectRef.current?.root;
                if (!root) return;
                setBibliographyAuditRoot(root);
                setBibliographyAuditOpen(true);
              },
            },
          ];
        }
        if (kind === "agent") return [{ id: "agent-settings", label: t`Agent settings…`, run: () => openSettings("agent") }];
        return [
          { id: "build", label: t`Build project`, shortcut: "⌘S", run: () => void compileAndShowPdf(false, true) },
          { id: "reveal", label: t`Reveal cursor in PDF`, shortcut: "⌘⇧J", run: () => void revealSourceInPdf() },
        ];
      },
      quickOpen: () => setSearchDialog("quick-open"),
      build: (key, options) => {
        void (async () => {
          // The build follows the active document (it may be a root of its own), so the panel's file goes first.
          if (activeFileRef.current !== key && !isPaperTabKey(key) && !projectAssetPaths.has(key)) await openProjectFile(key);
          trellis.showPdfFor(options?.beside);
          if (options?.clean) await buildPipeline.cleanAndRebuild();
          else await compile(false, true);
        })();
      },
      stopBuild: () => void buildPipeline.abortBuild(),
      setViewMode: (mode) => openDocumentMode(mode),
      setPaperView: (view) => changePaperView(view),
    };
    trellis.setBridge(bridge);
  });
  useLayoutEffect(() => {
    if (!project) return;
    const revision = trellisFilesRevisionRef.current;
    if (revision.files !== project.files) {
      revision.files = project.files;
      revision.revision += 1;
    }
    trellis.app.set({
      projectRoot: project.root,
      activeKey: activeTabKey,
      activeDirty: trellisDirty,
      openTabs,
      tabsReady: tabsSettledRoot === project.root || workspacePersistenceReadyRoot === project.root,
      filesRevision: revision.revision,
    });
  }, [activeTabKey, openTabs, project, tabsSettledRoot, trellis, trellisDirty, workspacePersistenceReadyRoot]);
  // Inactive panels paint the last text they showed while loading a fresh copy.
  useEffect(() => {
    if (activeFile && !activePaper) trellis.texts.set(activeFile, source);
  }, [activeFile, activePaper, source, trellis]);
  // What the document panels' header tools show: build state, the active document's view, the Paper's view.
  const trellisViewModes = activePaper || activeAsset ? null
    : activeFile.toLocaleLowerCase().endsWith(".md") ? "markdown"
      : isHtmlFilePath(activeFile) ? "html" : null;
  const trellisViewMode = canvasMode === "pdf" ? "pdf" : canvasMode === "split" ? "split" : "source";
  const trellisBuiltIn = build?.success ? build.durationMs / 1000 : null;
  const trellisPaperViews = Boolean(activePaper && paperBlog !== null && paperMarkdown);
  useLayoutEffect(() => {
    trellis.docTools.set({
      building,
      builtIn: trellisBuiltIn,
      viewMode: trellisViewMode,
      viewModes: trellisViewModes,
      paperView: activePaper ? paperView : null,
      paperViews: trellisPaperViews,
    });
  }, [activePaper, building, paperView, trellis, trellisBuiltIn, trellisPaperViews, trellisViewMode, trellisViewModes]);
}
