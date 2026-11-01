/**
 * The one command table: every app-level action, as the ⌘K palette lists it,
 * as the window's shortcuts reach it and as the ⌘? sheet shows it (see
 * AppCommand). The palette and the sheet are one overlay state here, which
 * app-command-overlays.tsx renders.
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BROWSER_ENTRY_PORT } from "../platform/flavor";
import { requestMarginReviewHere, setMarginReviewMode } from "../overleaf/margin-review-mode";
import { welcomeDeskProjects } from "../project/first-pages";
import type { NewEntryType } from "../project/project-new-entries";
import { loadRecentCommands, rememberRecentCommand, type ThemePreference } from "../settings/app-settings";
import type { SettingsSearchEntry } from "../settings/settings-search-index";
import { REVEAL_IN_PDF_KEY } from "../pdf/pdf-keys";
import type { TrellisController } from "../trellis/trellis-controller";
import { closeDocumentTab } from "../trellis/close-document-tab";
import { WORKSPACE_SHORTCUTS } from "../trellis/trellis-workspaces";
import { FOCUS_MODE_KEY, FRAME_TOGGLE_KEY } from "../trellis/trellis-keymap";
import { PANEL_TITLES, spaceMixedScript } from "../trellis/trellis-titles";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { PaperSummary, ProjectSnapshot, SettingsTab } from "../app-types";
import { isProjectAssetFilePath } from "../app-utils";
import { logAction } from "../telemetry/app-notify";
import { showError } from "./notify";
import { annotationRounds, revisable } from "./annotation-rounds";
import type { PaletteChoice } from "./command-palette";
import { paletteSurface } from "./command-palette-leading";
import { PANEL_TOGGLE_KEYS, SINGLETON_PANELS } from "./panel-toggles";
import { projectPanelCommands } from "./project-panel-commands";
import type { SearchDialog } from "./app-search-dialogs";
import { collectFilePaths } from "./workspace-restore";
import { subscribeTauriEvent } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";
import { RUNNING_VERSION } from "./whats-new";
import { commandCombo, commandShortcutText, useAppCommands, type AppCommand } from "./use-app-commands";
import type { useAgentContext } from "./use-agent-context";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import type { EditorComments } from "./use-editor-comments";
import type { useInterfaceZoom } from "./use-interface-zoom";
import type { OpenDocuments } from "./use-open-documents";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { useProjectLifecycle } from "./use-project-lifecycle";
import type { ProjectSearch } from "./use-project-search";
import type { useProjectTree } from "./use-project-tree";
import type { ReferenceImport } from "./use-reference-import";
import type { useSyncTexNavigation } from "./use-synctex-navigation";
import type { ToolDrawers } from "./use-tool-drawers";
import type { useWhatsNew } from "./use-whats-new";

const loadTexlabLanguage = () => import("../build/texlab-language");

/** What File ▸ Close Tab (⌘W) sends the window it was used in (native_locale.rs). */
const CLOSE_TAB_EVENT = "close-tab";

/** No revision in flight, for counting what the palette's Revise would ask about. */
const NO_RUNNING_REVISIONS: ReadonlySet<string> = new Set();

type Compile = (force?: boolean, sound?: boolean) => Promise<void>;

export type CommandTableDeps = {
  project: ProjectSnapshot | null;
  papers: PaperSummary[];
  documents: OpenDocuments;
  trellis: TrellisController;
  layout: { focusMode: boolean; focusPdf: boolean; workspaceDirty: boolean };
  buildPipeline: Pick<ReturnType<typeof useBuildPipeline>, "building" | "cleanAndRebuild" | "cleanProject" | "abortBuild" | "cycleDiagnostic">;
  compileAndShowPdf: Compile;
  syncTex: Pick<ReturnType<typeof useSyncTexNavigation>, "canForwardSync" | "revealSourceInPdf">;
  agentContext: Pick<ReturnType<typeof useAgentContext>, "selectionSource" | "selection">;
  tools: Pick<ToolDrawers, "open">;
  tree: Pick<ReturnType<typeof useProjectTree>, "pasteClipboardImage">;
  referenceImport: Pick<ReferenceImport, "openAddSheet">;
  projectSearch: Pick<ProjectSearch, "openFind" | "openFindFor" | "openReplace">;
  editorComments: Pick<EditorComments, "comments">;
  lifecycle: Pick<
    ReturnType<typeof useProjectLifecycle>,
    | "recentProjects" | "unopenedProject" | "createForm" | "updateCreateForm" | "busyLabel" | "chooseExisting"
    | "chooseRecentProject" | "exportProjectZip" | "importOverleafZip" | "openTutorialProject" | "moveWorkspace"
  >;
  overleaf: Pick<
    ReturnType<typeof useOverleafWorkspace>,
    "overleafLink" | "overleafSyncing" | "overleafPickerOpen" | "setOverleafPickerOpen" | "openCurrentOverleafProject" | "flushDeferredWholeFileSync"
  >;
  syncOverleaf: () => void;
  todoCount: number;
  updateCanvasRequest: UpdateCanvasRequest;
  setSearchDialog: Dispatch<SetStateAction<SearchDialog | null>>;
  setTableGeneratorOpen: (open: boolean) => void;
  setArxivExportOpen: (open: boolean) => void;
  checkReferences: () => void;
  requestNewEntry: (type: NewEntryType) => void;
  settingsOpen: boolean;
  openSettings: (tab?: SettingsTab, returnFocus?: HTMLElement | null, reveal?: SettingsSearchEntry | null) => void;
  whatsNew: Pick<ReturnType<typeof useWhatsNew>, "setOpen">;
  browserHosted: boolean;
  theme: { preference: ThemePreference; setPreference: (preference: ThemePreference) => void };
  interfaceZoom: Pick<ReturnType<typeof useInterfaceZoom>, "zoom">;
  knownAuthorName: string | null;
  prewarmLikelyProjectFile: (path: string) => void;
  readDraggedPaper: (paper: PaperSummary) => void;
};

export function useCommandTable({
  project, papers, documents, trellis, layout: { focusMode, focusPdf, workspaceDirty }, buildPipeline, compileAndShowPdf,
  syncTex, agentContext, tools, tree, referenceImport, projectSearch, editorComments, lifecycle, overleaf, syncOverleaf,
  todoCount, updateCanvasRequest, setSearchDialog, setTableGeneratorOpen, setArxivExportOpen, checkReferences,
  requestNewEntry, settingsOpen, openSettings, whatsNew, browserHosted, theme, interfaceZoom, knownAuthorName,
  prewarmLikelyProjectFile, readDraggedPaper,
}: CommandTableDeps) {
  // Left to React as it was inside App, where the compiler built the table
  // afresh each render and kept only the run closures: compiled on its own it
  // memoized every command and label, ~16 KB of eager JS for a table that
  // useAppCommands reads through a ref at each keypress anyway.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a React Compiler directive
  "use no memo";
  const { t, i18n } = useLingui();
  const { file: activeFile, text: source, paper: activePaper, asset: activeAsset, save } = documents;
  const { openFile, openAsset, edit: editFile } = documents;
  const { building, cleanAndRebuild, cleanProject, abortBuild, cycleDiagnostic } = buildPipeline;
  const { revealSourceInPdf } = syncTex;
  const { openFind: openProjectFind, openFindFor: openProjectFindFor, openReplace: openProjectReplace } = projectSearch;
  const {
    recentProjects, unopenedProject, createForm, updateCreateForm, busyLabel, chooseExisting, chooseRecentProject,
    exportProjectZip, importOverleafZip, openTutorialProject, moveWorkspace,
  } = lifecycle;
  const { overleafLink, overleafSyncing, overleafPickerOpen, setOverleafPickerOpen, openCurrentOverleafProject } = overleaf;
  const { preference: themePreference, setPreference: setThemePreference } = theme;
  // The command palette or the shortcut sheet: one at a time, and one state.
  // The palette carries what it leads with, read at each opening: another
  // window may have run commands since.
  const [commandOverlay, setCommandOverlay] = useState<
    { kind: "palette"; recentCommands: string[]; recentFiles: string[] } | { kind: "shortcuts" } | null
  >(null);

  const formatFocusedDocument = () => {
    const path = activeFile;
    const text = source;
    if (!path.endsWith(".tex")) {
      showError(t`Open a .tex file before formatting.`, t`Format`);
      return;
    }
    const trace = logAction(t`Format`, t`Format document`, path);
    void loadTexlabLanguage()
      .then(({ formatLatexDocument }) => formatLatexDocument(path, text))
      .then((formatted) => {
        if (formatted === text) {
          trace.ok(t`Document is already formatted.`);
          return;
        }
        editFile(formatted);
        trace.ok(t`Formatted with latexindent.`);
      })
      .catch((reason) => trace.fail(reason));
  };
  const commandSurface = paletteSurface({ file: activeFile, paper: activePaper !== null, asset: Boolean(activeAsset) });
  // The welcome screen keeps the shortcuts listening, so a command that needs
  // a project, a text editor or LaTeX source says so and is neither listed
  // nor run without one.
  const inProject = project !== null;
  const textEditor = inProject && !activePaper && !activeAsset && Boolean(activeFile);
  const latexSource = inProject && commandSurface === "source";
  const editorSelected = agentContext.selectionSource === "editor" && agentContext.selection.trim() !== "";
  /** ⌘K (or ⌘⇧P) opens the palette, and closes it again. */
  const openCommandPalette = () => {
    if (commandOverlay?.kind === "palette") {
      setCommandOverlay(null);
      return;
    }
    const present = new Set(project ? collectFilePaths(project.files, (node) => Boolean(node.path)) : []);
    const shown = activeAsset?.path ?? (activePaper ? "" : activeFile);
    setCommandOverlay({
      kind: "palette",
      recentCommands: loadRecentCommands(),
      recentFiles: documents.recentPaths().filter((path) => path !== shown && present.has(path)),
    });
  };
  const trellisUi = trellis.ui.get();
  const docTools = trellis.docTools.get();
  const otherRecentProjects = recentProjects.filter((recent) => recent.path !== project?.root);
  // ⌘S saves, then builds what it saved; on a Paper there is nothing to build.
  const saveCommand: AppCommand = {
    id: "save", when: inProject, label: t`Save and build`, group: "build", key: "s", palette: false,
    run: () => void save().then((saved) => {
      if (!saved) return;
      void overleaf.flushDeferredWholeFileSync();
      if (!activePaper) void compileAndShowPdf();
    }),
  };
  /** Every app-level action: the palette entries, the window's shortcuts and the shortcut sheet (see AppCommand). */
  const revisableAnnotations = editorComments.comments.filter((annotation) => revisable(annotation, NO_RUNNING_REVISIONS)).length;
  const commands: AppCommand[] = [
    // ⌘S reaches it through Save, which builds what it saved.
    { id: "build", when: inProject, label: t`Build project`, shortcut: commandCombo(saveCommand) ?? undefined, group: "build", run: () => void compileAndShowPdf(false, true) },
    saveCommand,
    { id: "rebuild", when: inProject, label: t`Clean rebuild`, keywords: "latexmk", group: "build", recent: false, run: () => void cleanAndRebuild() },
    { id: "clean", when: inProject, label: t`Clean aux files`, group: "build", recent: false, run: () => void cleanProject() },
    // Only ever wanted while a build runs, so never worth remembering.
    { id: "stop-build", when: building, label: t`Stop build`, group: "build", recent: false, run: () => void abortBuild() },
    { id: "sync-pdf", when: latexSource && syncTex.canForwardSync, label: t`Jump to PDF`, group: "navigate", ...REVEAL_IN_PDF_KEY, run: () => void revealSourceInPdf() },
    { id: "quick-open", when: inProject, label: t`Quick open file`, group: "navigate", key: "p", run: () => setSearchDialog("quick-open") },
    { id: "goto-line", when: textEditor, label: t`Go to line`, group: "navigate", key: "g", run: () => setSearchDialog("goto-line") },
    { id: "goto-symbol", when: textEditor, label: t`Go to symbol`, group: "navigate", key: "o", shift: true, run: () => setSearchDialog("goto-symbol") },
    { id: "back", when: inProject, label: t({ message: "Back", context: "Document history" }), group: "navigate", key: "[", palette: false, run: () => void documents.go(-1) },
    { id: "forward", when: inProject, label: t({ message: "Forward", context: "Document history" }), group: "navigate", key: "]", palette: false, run: () => void documents.go(1) },
    { id: "next-problem", label: t`Next build problem`, group: "navigate", key: "f8", mod: false, palette: false, run: () => cycleDiagnostic(1) },
    { id: "previous-problem", label: t`Previous build problem`, group: "navigate", key: "f8", shift: true, mod: false, palette: false, run: () => cycleDiagnostic(-1) },
    { id: "reopen-tab", when: inProject, label: t`Reopen the closed tab`, group: "navigate", key: "t", shift: true, palette: false, run: documents.reopenClosed },
    // ⌘W closes a document tab, as in an editor or a browser, and the window
    // once none is open; ⇧⌘W (File ▸ Close Window) closes the window outright.
    // A browser tab's ⌘W is the browser's own, and Settings, over the
    // documents, leaves them alone.
    {
      id: "close-tab", when: !browserHosted && !settingsOpen, label: t`Close the document tab, or the window when none is open`, group: "navigate", key: "w", palette: false,
      run: () => {
        if (!closeDocumentTab(trellis)) void getCurrentWindow().close();
      },
    },
    // ⌘K everywhere, the welcome screen included, and ⌘⇧P where it always was: one row in the sheet.
    { id: "palette", label: t`Command palette`, group: "project", key: "k", palette: false, run: openCommandPalette },
    { id: "palette-shift-p", label: t`Command palette`, group: "project", key: "p", shift: true, palette: false, run: openCommandPalette },
    // The window's ⌘?, the Mac's Help key: every shortcut, from these commands and the keymaps.
    { id: "shortcuts", label: t`Keyboard shortcuts`, group: "project", key: "?", shift: true, run: () => setCommandOverlay({ kind: "shortcuts" }) },
    // Reset the panel layout, and bring back any panel that was hidden or closed.
    { id: "layout-reset", when: inProject, label: t`Reset panel layout`, group: "layout", recent: false, run: () => void trellis.resetLayout() },
    // Trellis binds ⌘⇧↩ itself; the label follows what it would do now, as the Panels menu's entry does.
    trellisUi.framed
      ? { id: "frame", when: inProject, label: t`Restore the layout`, shortcut: FRAME_TOGGLE_KEY, group: "layout", run: () => trellis.ws?.navigation.frame("all") }
      : { id: "frame", when: inProject, label: t`Maximize focused panel`, shortcut: FRAME_TOGGLE_KEY, group: "layout", run: () => trellis.ws?.navigation.toggle() },
    // The named workspaces: each by name here, and ⌘1 to ⌘9 by position (read when pressed, so a reorder counts at once).
    ...trellis.workspaces.list().map(({ id, name }, index): AppCommand => ({
      id: `workspace-${id}`, when: inProject, label: spaceMixedScript(t`Switch to ${name}`), group: "layout",
      shortcut: index < WORKSPACE_SHORTCUTS ? { key: String(index + 1), mod: true } : undefined,
      run: () => trellis.switchWorkspace(id),
    })),
    ...Array.from({ length: WORKSPACE_SHORTCUTS }, (_, index): AppCommand => ({
      id: `workspace-${index + 1}`, when: inProject, label: t`Switch to a workspace by its place`, group: "layout", key: String(index + 1), palette: false,
      run: () => trellis.switchWorkspaceAt(index),
    })),
    {
      id: "focus-mode", when: inProject, label: focusMode ? t`Leave focus mode` : t`Focus mode`,
      group: "layout", ...FOCUS_MODE_KEY, run: () => trellis.setFocus(!focusMode),
    },
    ...(focusMode ? [{
      id: "focus-pdf", label: focusPdf ? t`Hide the PDF` : t`Show the PDF beside the editor`, group: "layout" as const, run: () => trellis.setFocusPdf(!focusPdf),
    }] : []),
    { id: "workspace-new", when: inProject, label: t`New workspace`, group: "layout", run: () => void trellis.createWorkspace(t`Workspace`) },
    // While the project's layout differs from its workspace's saved arrangement.
    ...(workspaceDirty ? [
      { id: "workspace-save", when: inProject, label: t`Save to workspace`, group: "layout" as const, run: () => trellis.saveWorkspace() },
      { id: "workspace-revert", when: inProject, label: t`Revert to saved`, group: "layout" as const, recent: false as const, run: () => trellis.revertWorkspace() },
    ] : []),
    // Writing and Reading, the layout presets (also in the Panels menu); the one in use is not offered again.
    ...(["writing", "reading"] as const).filter((preset) => trellisUi.preset !== preset).map((preset): AppCommand => ({
      id: `preset-${preset}`, when: inProject, group: "layout",
      label: preset === "writing" ? t`Switch to the Writing layout` : t`Switch to the Reading layout`,
      run: () => trellis.setPreset(preset),
    })),
    // A panel with a toggle key (app/panel-toggles.ts) toggles, as its Panels menu entry does; the rest are shown.
    ...SINGLETON_PANELS.map((kind): AppCommand => {
      const name = i18n._(PANEL_TITLES[kind]);
      const toggleKey = PANEL_TOGGLE_KEYS[kind];
      const hide = toggleKey !== undefined && trellis.panelState(kind) === "shown";
      return {
        id: `panel-${kind}`, when: inProject, group: "layout",
        label: spaceMixedScript(hide ? t({ message: `Hide ${name} panel` }) : t({ message: `Show ${name} panel` })),
        ...toggleKey,
        run: () => (toggleKey ? trellis.togglePanel(kind) : trellis.showPanel(kind)),
      };
    }),
    // A Markdown or HTML file's or a Paper's Edit, Split and Preview, under the names their switch gives them.
    ...(docTools.viewModes ? (["source", "split", "pdf"] as const).filter((mode) => mode !== docTools.viewMode).map((mode): AppCommand => ({
      id: `view-${mode}`, when: inProject, group: "view",
      label: (docTools.viewModes === "html"
        ? { source: t`Edit HTML`, split: t`Edit and preview HTML`, pdf: t`Preview HTML` }
        : { source: t`Edit Markdown`, split: t`Edit and preview Markdown`, pdf: t`Preview Markdown` })[mode],
      run: () => documents.chooseMode(mode),
    })) : []),
    { id: "table", when: latexSource, label: t`Insert table`, group: "edit", run: () => setTableGeneratorOpen(true) },
    { id: "cite", when: latexSource, label: t`Insert citation`, group: "edit", key: "k", shift: true, run: () => setSearchDialog("cite") },
    { id: "ref", when: latexSource, label: t`Insert reference`, group: "edit", key: "l", shift: true, run: () => setSearchDialog("ref") },
    // The editor's own ⌘⌥P proofreads a selection; from here, the one the editor still holds.
    ...(["proofread", "polish"] as const).map((mode): AppCommand => ({
      id: mode, when: latexSource && editorSelected, group: "edit",
      label: mode === "proofread" ? t`Proofread selection` : t`Polish selection`,
      shortcut: mode === "proofread" ? { key: "p", mod: true, alt: true } : undefined,
      run: () => updateCanvasRequest("proofread", { mode, id: crypto.randomUUID() }),
    })),
    { id: "bib", when: inProject, label: t`Add papers`, keywords: t`DOIs, arXiv IDs, links, titles or BibTeX`, group: "research", run: () => referenceImport.openAddSheet() },
    // eslint-disable-next-line lingui/no-unlocalized-strings -- the sources' own names, for search only
    { id: "discover", when: inProject, label: t`Discover literature`, keywords: "alphaXiv OpenAlex", group: "research", run: () => tools.open("literature") },
    { id: "check-references", when: inProject, label: t`Check references`, group: "research", run: checkReferences },
    { id: "find", when: inProject, label: t`Find in project`, group: "edit", key: "f", shift: true, run: openProjectFind },
    { id: "replace", when: inProject, label: t`Replace in project`, group: "edit", key: "h", shift: true, run: openProjectReplace },
    {
      id: "todos", when: inProject, label: t`Manuscript TODOs`, detail: todoCount === 0 ? t`No markers` : todoCount === 1 ? t`${todoCount} marker` : t`${todoCount} markers`, group: "edit",
      run: () => tools.open("todos"),
    },
    {
      id: "checklist", when: inProject, label: t`Submission checklist`, keywords: t`Words / pages / TODOs`, group: "edit",
      run: () => tools.open("checklist"),
    },
    { id: "annotations", when: inProject, label: t`Show annotations`, group: "edit", run: () => tools.open("comments") },
    {
      id: "annotations-revise", when: inProject && revisableAnnotations > 0, label: t`Revise from annotations`,
      detail: revisableAnnotations === 1 ? t`1 annotation` : t`${revisableAnnotations} annotations`, group: "edit",
      run: () => annotationRounds.revise(),
    },
    { id: "paste-image", when: inProject, label: t`Paste clipboard image as figure`, group: "edit", run: () => void tree.pasteClipboardImage() },
    { id: "format", when: latexSource, label: t`Format document`, keywords: "latexindent", group: "edit", run: formatFocusedDocument },
    ...projectPanelCommands({ inProject, i18n, trellis, requestNewEntry }),
    { id: "history", when: inProject, label: t`Open project history`, group: "project", run: () => tools.open("history") },
    { id: "export-zip", when: inProject, label: t`Export project ZIP`, keywords: t`Overleaf source pack`, group: "project", run: () => void exportProjectZip() },
    { id: "export-arxiv", when: inProject, label: t`Export for arXiv…`, group: "project", run: () => setArxivExportOpen(true) },
    { id: "new-project", label: t`New project`, group: "project", run: () => updateCreateForm({ open: true }) },
    { id: "open-folder", label: t`Open another folder`, group: "project", key: "o", run: () => void chooseExisting() },
    ...otherRecentProjects.map(({ name, path }, index): AppCommand => ({
      id: `recent-project-${index}`, label: spaceMixedScript(t`Open ${name}`), detail: path, group: "project",
      // Ids by position, so no path is remembered; and never in Recent, where a position may name another project.
      recent: false,
      run: () => void chooseRecentProject(path),
    })),
    // ⌘1 to ⌘3 on the welcome screen: the projects on its desk, by place. In a
    // project the same keys switch workspaces, so these are only listed here.
    ...(inProject ? [] : welcomeDeskProjects(recentProjects, unopenedProject?.path).map(({ path }, index): AppCommand => ({
      id: `desk-project-${index + 1}`, label: t`Open a recent project by its place`, group: "project", key: String(index + 1), palette: false,
      when: !createForm.open && !busyLabel && !settingsOpen && !overleafPickerOpen,
      run: () => void chooseRecentProject(path),
    }))),
    { id: "import-zip", label: t`Import Overleaf ZIP`, group: "overleaf", run: () => void importOverleafZip() },
    { id: "overleaf-open", label: t`Open an Overleaf project`, group: "overleaf", run: () => setOverleafPickerOpen(true) },
    { id: "overleaf-sync", when: inProject && overleafLink !== null && !overleafSyncing, label: t`Sync with Overleaf`, group: "overleaf", run: syncOverleaf },
    { id: "overleaf-web", when: inProject && overleafLink !== null, label: t`Open this project on Overleaf`, group: "overleaf", run: () => void openCurrentOverleafProject() },
    // Margin review, as the View menu offers it (overleaf-margin-review.tsx); kept per window.
    { id: "margin-review-auto", when: inProject && overleafLink !== null, label: t`Margin review: Auto`, group: "view", run: () => setMarginReviewMode("auto") },
    { id: "margin-review-markers", when: inProject && overleafLink !== null, label: t`Margin review: Markers only`, group: "view", run: () => setMarginReviewMode("markers") },
    { id: "margin-review-off", when: inProject && overleafLink !== null, label: t`Margin review: Off`, group: "view", run: () => setMarginReviewMode("off") },
    { id: "margin-review-here", when: inProject && overleafLink !== null, label: t`Review here`, detail: t`the comment or suggestion by the caret`, group: "view", run: requestMarginReviewHere },
    { id: "whats-new", label: t`What’s new in Lattice`, detail: RUNNING_VERSION, group: "project", run: () => whatsNew.setOpen(true) },
    { id: "tutorial", label: t`Open guided tutorial`, group: "project", run: () => void openTutorialProject() },
    { id: "doctor", label: t`Run TeX doctor`, group: "project", run: () => openSettings("doctor") },
    {
      id: "browser", group: "project", run: () => void moveWorkspace(),
      ...(browserHosted
        ? { label: t`Open in Lattice app` }
        : { label: t`Open in browser`, detail: `http://127.0.0.1:${BROWSER_ENTRY_PORT}` }),
    },
    // Light, dark or the system's: the two not in use.
    ...(["light", "dark", "system"] as const).filter((preference) => preference !== themePreference).map((preference): AppCommand => ({
      id: `theme-${preference}`, group: "appearance", keywords: t({ message: "theme appearance", comment: "Search words for the theme commands, space-separated" }),
      label: { light: t`Use the light theme`, dark: t`Use the dark theme`, system: t`Match the system theme` }[preference],
      run: () => setThemePreference(preference),
    })),
    // The interface size, as every Mac app binds it; ⌘= is ⌘+ without Shift.
    { id: "interface-bigger", label: t`Larger interface`, group: "appearance", key: "+", shift: true, run: () => interfaceZoom.zoom("in") },
    { id: "interface-bigger-unshifted", key: "=", palette: false, run: () => interfaceZoom.zoom("in") },
    { id: "interface-smaller", label: t`Smaller interface`, group: "appearance", key: "-", run: () => interfaceZoom.zoom("out") },
    { id: "interface-actual-size", label: t`Reset interface size`, group: "appearance", key: "0", run: () => interfaceZoom.zoom("reset") },
    { id: "settings", label: t`Open settings`, group: "project", key: ",", run: () => openSettings() },
  ];
  const runCommand = useAppCommands(commands);
  // The menu's ⌘W, for a click or a key nothing in the page took (focus in a
  // frame that was never told the window's keys).
  const runCommandRef = useLatestRef(runCommand);
  useEffect(() => subscribeTauriEvent<string>(
    (handler) => listenInThisWindow(CLOSE_TAB_EVENT, handler),
    () => runCommandRef.current("close-tab"),
  ), [runCommandRef]);
  // The titlebar's search field is the palette's visible home. The titlebar
  // only re-renders with the workspace, so it gets one stable opener.
  const openCommandPaletteRef = useLatestRef(openCommandPalette);
  const openPaletteFromTitlebar = useCallback(() => openCommandPaletteRef.current(), [openCommandPaletteRef]);
  const palette = commandOverlay?.kind === "palette" ? commandOverlay : null;
  return {
    commands,
    openPaletteFromTitlebar,
    paletteShortcut: commandShortcutText(commands, "palette") ?? undefined,
    /** What the palette and the shortcut sheet show (app-command-overlays.tsx). */
    overlay: {
      shortcuts: commandOverlay?.kind === "shortcuts",
      palette: palette && {
        recentCommands: palette.recentCommands,
        recentFiles: palette.recentFiles,
        surface: commandSurface,
        // Listed only while open, from the tree as it is now.
        files: project ? collectFilePaths(project.files, (node) => Boolean(node.path)) : [],
        papers: project ? papers : [],
        hasProject: inProject,
        knownAuthorName,
        onFileIntent: prewarmLikelyProjectFile,
      },
      close: () => setCommandOverlay(null),
      choose: (choice: PaletteChoice) => {
        setCommandOverlay(null);
        if (choice.kind === "command") rememberRecentCommand(choice.id);
        // Only once the palette has handed focus back to where it was, so a
        // command that moves focus itself (the tree's inline New file field)
        // keeps it. The dialog returns focus in a microtask as it unmounts,
        // and Radix's FocusScope again on a zero-delay timer it starts then;
        // this timer, started before that unmount, starts one more after it.
        window.setTimeout(() => window.setTimeout(() => {
          if (choice.kind === "command") runCommand(choice.id);
          else if (choice.kind === "file") {
            if (isProjectAssetFilePath(choice.path)) void openAsset(choice.path);
            else void openFile(choice.path);
          } else if (choice.kind === "paper") readDraggedPaper(choice.paper);
          else if (choice.kind === "find") openProjectFindFor(choice.query);
          else openSettings(choice.entry.tab, null, choice.entry);
        }, 0), 0);
      },
    },
  };
}
