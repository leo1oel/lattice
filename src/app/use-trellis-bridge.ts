import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { AssetPreview, PaperSummary, ProjectSnapshot, SettingsTab } from "../app-types";
import { arxivIdFromTabKey, isHtmlFilePath, isPaperTabKey, stripFrontmatter } from "../app-utils";
import type { MenuEntry } from "@danfessler/trellis";
import { NEW_ENTRIES, type NewEntryType } from "../project/project-new-entries";
import type { TrellisBridge, TrellisController } from "../trellis/trellis-controller";
import type { SearchDialog } from "./app-search-dialogs";
import { setNotice } from "./notify";
import type { BuildOutcome, useBuildPipeline } from "./use-build-pipeline";
import { documentKind, paperDocumentPath, readPaperDocuments, type OpenDocuments } from "./use-open-documents";
import type { useProjectSearch } from "./use-project-search";
import type { useReferenceImages } from "./use-reference-images";
import type { useReferenceImport } from "./use-reference-import";
import type { useSynaraHost } from "./use-synara-host";
import type { ToolDrawers } from "./use-tool-drawers";

/** What the Trellis workspace reads from App: the open documents, the project, and the actions its panels call. */
export type TrellisBridgeApp = {
  trellis: TrellisController;
  project: ProjectSnapshot | null;
  projectRef: RefObject<ProjectSnapshot | null>;
  papers: PaperSummary[];
  documents: OpenDocuments;
  lastBuild: BuildOutcome | null;
  building: boolean;
  buildPipeline: Pick<ReturnType<typeof useBuildPipeline>, "cleanAndRebuild" | "abortBuild">;
  synara: Pick<ReturnType<typeof useSynaraHost>, "mountFrame" | "notifyPanelOpened">;
  tools: Pick<ToolDrawers, "open">;
  referenceImport: Pick<ReturnType<typeof useReferenceImport>, "openBibEntry">;
  referenceImages: ReturnType<typeof useReferenceImages>;
  projectSearch: Pick<ReturnType<typeof useProjectSearch>, "openFind">;
  compile: (force?: boolean, sound?: boolean) => Promise<void>;
  compileAndShowPdf: (force?: boolean, sound?: boolean) => Promise<void>;
  revealSourceInPdf: () => Promise<void>;
  openSettings: (tab?: SettingsTab) => void;
  setSearchDialog: Dispatch<SetStateAction<SearchDialog | null>>;
  setProjectSearchOpen: Dispatch<SetStateAction<boolean>>;
  setBibliographyAuditRoot: Dispatch<SetStateAction<string | null>>;
  setBibliographyAuditOpen: Dispatch<SetStateAction<boolean>>;
  requestNewEntry: (type: NewEntryType) => void;
};

/**
 * Connects App to the Trellis workspace: the bridge the workspace calls at event time, and the stores
 * (`app`, `texts`, `docTools`) its panels read.
 */
export function useTrellisBridge(app: TrellisBridgeApp) {
  const { t, i18n } = useLingui();
  const {
    trellis, project, projectRef, papers, documents, lastBuild, building, buildPipeline,
    synara, tools, referenceImport, referenceImages, projectSearch, compile, compileAndShowPdf, revealSourceInPdf,
    openSettings, setSearchDialog, setProjectSearchOpen, setBibliographyAuditRoot, setBibliographyAuditOpen,
    requestNewEntry,
  } = app;
  const {
    file: activeFile, text: source, paper: activePaper, asset: activeAsset, mode: canvasMode, paperView, activeTab,
    tabs: openTabs, tabsReady, revealRequest, dirty, paperViews, assetPaths,
  } = documents;
  const trellisFilesRevisionRef = useRef<{ files: unknown; revision: number }>({ files: null, revision: 0 });
  useLayoutEffect(() => {
    const bridge: TrellisBridge = {
      activate: (key, line) => void documents.open(key, { line }),
      closeTab: async (key) => {
        await documents.close(key);
        return true;
      },
      save: documents.save,
      tabKind: (key) => documentKind(key, assetPaths),
      tabLabel: (key) => (isPaperTabKey(key)
        ? papers.find((paper) => paper.arxivId === arxivIdFromTabKey(key))?.title ?? t`Paper`
        : key.split("/").at(-1) || key),
      readText: async (path) => {
        if (path === documents.live.file.current) return documents.live.text.current;
        const root = projectRef.current?.root;
        if (!root) return null;
        try {
          return await invoke<string>("read_project_file", { path, projectRoot: root });
        } catch {
          return null;
        }
      },
      readPaper: async (key) => {
        if (!isPaperTabKey(key)) return null;
        const arxivId = arxivIdFromTabKey(key);
        const { markdown, blog } = await readPaperDocuments(arxivId);
        const view = (paperView === "blog" ? blog : markdown) ? paperView : paperView === "blog" ? "fulltext" : "blog";
        const path = paperDocumentPath(arxivId, view);
        // Shown as the reader shows it: a full text's converter frontmatter
        // would be a block the reader lacks, shifting the shared reading anchor.
        const text = view === "blog" ? blog : markdown && stripFrontmatter(markdown);
        return text ? { path, text } : null;
      },
      readAsset: (path) => invoke<AssetPreview>("read_project_asset", { path }),
      viewState: (path) => documents.viewStates.get(path),
      rememberViewState: (path, update) => documents.viewStates.remember(path, update),
      // A panel asking for a drawer that is already open only comes forward:
      // reopening would reset it (a comment reply's focus, Overleaf's tab).
      openTool: (kind) => {
        if (trellis.openDrawers.get()[kind]) trellis.revealTool(kind);
        else tools.open(kind);
      },
      agentShown: () => {
        synara.mountFrame();
        synara.notifyPanelOpened();
      },
      notify: (message) => setNotice(message),
      panelMenu: (kind) => {
        if (kind === "project") {
          // The + menu's entries, then the header's other action.
          return [
            ...NEW_ENTRIES.flatMap((entry): MenuEntry[] => [
              ...(entry.separated ? ["separator" as const] : []),
              { id: `new-${entry.type}`, label: i18n._(entry.label), run: () => requestNewEntry(entry.type) },
            ]),
            "separator",
            { id: "find", label: t`Find in project`, run: () => { setProjectSearchOpen(false); projectSearch.openFind(); } },
          ];
        }
        if (kind === "papers") {
          return [
            { id: "discover", label: t`Discover literature`, run: () => tools.open("literature") },
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
          if (documents.live.file.current !== key && documentKind(key, assetPaths) === "file") await documents.openFile(key);
          trellis.showPdfFor(options?.beside);
          if (options?.clean) await buildPipeline.cleanAndRebuild();
          else await compile(false, true);
        })();
      },
      stopBuild: () => void buildPipeline.abortBuild(),
      setViewMode: (mode) => documents.chooseMode(mode),
      setPaperView: (view) => documents.choosePaperView(view),
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
      activeKey: activeTab,
      activeDirty: dirty,
      openTabs,
      tabsReady,
      revealRequest,
      filesRevision: revision.revision,
      loadAsset: referenceImages.load,
      assetRevision: referenceImages.generation,
    });
  }, [activeTab, dirty, openTabs, project, referenceImages.generation, referenceImages.load, revealRequest, tabsReady, trellis]);
  // Inactive panels paint the last text they showed while loading a fresh copy.
  useEffect(() => {
    if (activeFile && !activePaper) trellis.texts.set(activeFile, source);
  }, [activeFile, activePaper, source, trellis]);
  // What the document panels' header tools show: build state, the active document's view, the Paper's view.
  const trellisViewModes = activePaper || activeAsset ? null
    : activeFile.toLocaleLowerCase().endsWith(".md") ? "markdown"
      : isHtmlFilePath(activeFile) ? "html" : null;
  const trellisViewMode = canvasMode === "pdf" ? "pdf" : canvasMode === "split" ? "split" : "source";
  useLayoutEffect(() => {
    trellis.docTools.set({
      building,
      lastBuild,
      viewMode: trellisViewMode,
      viewModes: trellisViewModes,
      paperView: activePaper ? paperView : null,
      paperViews,
    });
  }, [activePaper, building, lastBuild, paperView, paperViews, trellis, trellisViewMode, trellisViewModes]);
}
