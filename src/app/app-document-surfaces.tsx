/**
 * The two surfaces of a project's first frame that App takes from its
 * `surfaces` prop (app-surfaces.ts): the document canvas, and the compiled
 * project PDF beside it with the build's diagnostics above its pages. Each
 * renders behind a ChunkGate, so the frame shows as soon as its chunk is in.
 *
 * App owns every document and the state these read; this maps that state onto
 * the canvas's and the PDF panel's prop groups.
 */
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openSlideComposerPrompt } from "../agent/agent-composer-prompt";
import { EMPTY_DIAGNOSTICS, diagnosticMatchesFile, resolveDiagnosticPath, flattenProjectPaths, type CompileDiagnostic } from "../build/compile-diagnostics";
import type { useCompileRepair } from "../build/use-compile-repair";
import type { useTexlabDiagnostics } from "../build/use-texlab-diagnostics";
import type { DocumentCanvasProps } from "../canvas/canvas-model";
import type { SaveSlot } from "../canvas/save-slot";
import { ChunkGate } from "../components/chunk-gate";
import type { OpenSlideContext } from "../editor/presentation/open-slide-bridge";
import type { LivePreview } from "../live-preview/use-live-preview";
import { citationSourceUrl } from "../papers/paper-source";
import type { TrellisController } from "../trellis/trellis-controller";
import type { EditorPosition, ProjectManifest, ProjectSnapshot } from "../app-types";
import { toMessage } from "../app-utils";
import { annotationRounds } from "./annotation-rounds";
import { AppOverleafMarginReview } from "./app-overleaf-drawer";
import type { SearchDialog } from "./app-search-dialogs";
import type { AppSurfaces } from "./app-surfaces";
import { persistSynaraThread } from "./app-synara-embed";
import { showError, showingErrors } from "./notify";
import type { useAgentContext } from "./use-agent-context";
import type { useApplyOpenSlideMutation } from "./use-apply-open-slide-mutation";
import type { useBuildErrorFix } from "./use-build-error-fix";
import type { useBuildPipeline } from "./use-build-pipeline";
import type { useCanvasRequests } from "./use-canvas-requests";
import type { EditorComments } from "./use-editor-comments";
import type { OpenDocuments } from "./use-open-documents";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { usePreviewPrewarm } from "./use-preview-prewarm";
import type { useLatexStructure } from "./use-latex-structure";
import type { useProjectLibrary } from "./use-project-library";
import type { ProjectState } from "./use-project-state";
import type { useProjectTree } from "./use-project-tree";
import type { ReferenceImport } from "./use-reference-import";
import type { useReferenceImages } from "./use-reference-images";
import type { useSourceNavigation } from "./use-source-navigation";
import type { SynaraHost } from "./use-synara-host";
import type { useSyncTexNavigation } from "./use-synctex-navigation";
import type { TexSetup } from "./use-tex-setup";
import type { ToolDrawers } from "./use-tool-drawers";

const CompileDiagnosticsPanel = lazy(() =>
  import("../build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];

export function AppDocumentSurfaces({
  surfaces: {
    documentCanvas: { load: loadDocumentCanvas, Component: DocumentCanvas },
    projectPdfPanel: { load: loadProjectPdfPanel, Component: ProjectPdfPanel },
  },
  project, projectState: { projectRef, setProject }, documents, settledSource, workspaceIndex, preferences, library, latex,
  texlabDiagnostics, referenceImport, referenceImages, canvasRequests, onEditorPosition, sourceNavigation, setSearchDialog,
  outline, tableGenerator, tree, overleaf, layout, comments, tools, agentContext, openSlide, trellis, synara, build, texSetup,
  saveSlot, movingWorkspace, livePreview, pdfPage, syncTex, setPaperPdfOpen,
}: {
  surfaces: Pick<AppSurfaces, "documentCanvas" | "projectPdfPanel">;
  project: ProjectSnapshot;
  projectState: Pick<ProjectState, "projectRef" | "setProject">;
  documents: OpenDocuments;
  /** The canvas's text as of the last pause in typing (useSettledSource). */
  settledSource: string;
  workspaceIndex: ReturnType<typeof usePreviewPrewarm>["workspaceIndex"];
  /** The user's editor settings; the project's root and spelling words come from `project`. */
  preferences: Omit<DocumentCanvasProps["preferences"], "projectRoot" | "spellingWords">;
  library: Pick<
    ReturnType<typeof useProjectLibrary>,
    "papers" | "citationKeys" | "citations" | "unusedSymbols" | "bibliographyIndexPending" | "projectWordCount"
  >;
  latex: ReturnType<typeof useLatexStructure>;
  texlabDiagnostics: ReturnType<typeof useTexlabDiagnostics>;
  referenceImport: Pick<ReferenceImport, "resolveBibQuery">;
  referenceImages: ReturnType<typeof useReferenceImages>;
  canvasRequests: { requests: ReturnType<typeof useCanvasRequests>["requests"]; settle: (id: string) => void };
  onEditorPosition: (position: EditorPosition) => void;
  sourceNavigation: Pick<
    ReturnType<typeof useSourceNavigation>,
    "openMarkdownProjectPath" | "gotoDefinition" | "findSymbolReferences" | "beginRename" | "beginSymbolRename"
  >;
  setSearchDialog: Dispatch<SetStateAction<SearchDialog | null>>;
  outline: { open: boolean; setOpen: (open: boolean) => void };
  tableGenerator: { open: boolean; setOpen: (open: boolean) => void };
  tree: ReturnType<typeof useProjectTree>;
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  layout: { focusMode: boolean; editorHibernated: boolean; pdfLive: boolean };
  comments: { store: EditorComments; author: { id: string; name: string } };
  tools: Pick<ToolDrawers, "open">;
  agentContext: Pick<ReturnType<typeof useAgentContext>, "reportSelection" | "activateSurface">;
  openSlide: { applyMutation: ReturnType<typeof useApplyOpenSlideMutation>; setContext: (context: OpenSlideContext | null) => void };
  trellis: TrellisController;
  synara: SynaraHost;
  build: {
    pipeline: ReturnType<typeof useBuildPipeline>;
    compileAndShowPdf: (force?: boolean, sound?: boolean) => Promise<void>;
    openCompileDiagnostic: (diagnostic: CompileDiagnostic) => Promise<void>;
    repair: ReturnType<typeof useCompileRepair>;
    repairWritable: boolean;
    errorFix: Pick<ReturnType<typeof useBuildErrorFix>, "replaceToken">;
    shortcut: string | undefined;
  };
  texSetup: TexSetup;
  saveSlot: SaveSlot;
  movingWorkspace: boolean;
  livePreview: LivePreview;
  pdfPage: { setCount: (count: number | null) => void; setNumber: (page: number) => void };
  syncTex: ReturnType<typeof useSyncTexNavigation>;
  setPaperPdfOpen: (open: boolean) => void;
}) {
  const { file: activeFile, text: source, paper: activePaper, asset: activeAsset, openFile, openPaper, save } = documents;
  const { get: getFileViewState, remember: rememberFileViewState } = documents.viewStates;
  const { papers, citationKeys, citations, unusedSymbols } = library;
  const { gotoDefinition, findSymbolReferences, beginRename, beginSymbolRename } = sourceNavigation;
  const { overleafLink, overleafRealtime, overleafDocPaths, overleafActiveCursors, overleafTrackChanges } = overleaf;
  const { pipeline: buildPipeline, repair: compileRepair } = build;
  const { build: lastBuild, building, pdfUrl, outcome: buildOutcome } = buildPipeline;
  const { focusMode } = layout;
  const editorComments = comments.store;

  const editorEditableForPath = (path: string, ignoreOverleaf = false) => (
    !compileRepair.busy
    && !movingWorkspace
    && (
      ignoreOverleaf
      || overleafLink === null
      || overleafRealtime.canWrite
      || (
        overleafRealtime.permission !== "unknown"
        && overleafRealtime.entities.get(path)?.kind !== "doc"
        && !Array.from(overleafDocPaths.values()).includes(path)
      )
    )
  );
  // texlab, when installed, reports unused labels/citations itself, so the local
  // check would duplicate its warnings. Suppress the local one when texlab is
  // available (assume it is until the doctor report loads) and fall back to it
  // otherwise. The unused-symbol counts elsewhere still use the full list.
  const texlabActive = texSetup.doctorReport?.checks.some((check) => check.name === "texlab" && check.ok) ?? true;
  // A citation opens its readable Paper when the library has one, else the source it cites.
  const sameKey = (key: string | undefined, other: string) => key?.toLocaleLowerCase() === other.toLocaleLowerCase();
  const readablePaperCited = (key: string) => papers.find((item) => sameKey(item.citationKey, key) && (item.hasFullText || item.hasBlog));
  const citationUrl = (key: string) => citationSourceUrl(citations.find((item) => sameKey(item.key, key)));

  // The outline, from the source's rail and status bar or the PDF's toolbar: its menu closes as the jump starts.
  const navigateOutline = (path: string, line: number) => {
    outline.setOpen(false);
    void syncTex.navigateOutline(path, line);
  };

  const documentCanvas = (
    <DocumentCanvas
      document={{
        mode: documents.mode,
        workspaceIndex,
        source: documents.canvas.text,
        settledSource,
        markdownPreviewSource: documents.canvas.previewText,
        activeFile: documents.canvas.path,
        setSource: documents.canvas.setText,
        onSave: save,
        onVisualMarkdownFlushChange: documents.canvas.registerFlush,
        onMarkdownModeViewportCaptureChange: documents.canvas.registerViewportCapture,
        onCompletionCloseChange: documents.canvas.registerCompletionClose,
        onViewMarkdownSource: () => documents.chooseMode("split"),
        activePaper,
        activeAsset,
        onActiveAssetChanged: documents.canvas.onAssetChanged,
        onPaperPdfOpenChange: setPaperPdfOpen,
        activeAssetMissing: documents.assetMissing,
        onEditorLeave: documents.canvas.onLeave,
        onCompletionActiveChange: documents.canvas.onCompletionActiveChange,
        onOpenMarkdownPath: sourceNavigation.openMarkdownProjectPath,
        // Papers live under .research/, which Overleaf deliberately
        // excludes from sync.
        editorEditable: editorEditableForPath(activeFile, activePaper !== null),
        editorKey: documents.canvas.key,
        openPaths: documents.tabs,
      }}
      preferences={{
        projectRoot: project.root,
        ...preferences,
        spellingWords: project.manifest.spellingWords ?? EMPTY_SPELLING_WORDS,
      }}
      bibliography={{
        papers,
        onOpenPaper: (paper) => void openPaper(paper),
        onOpenUrl: (url) => void openUrl(url).catch((reason) => showError(toMessage(reason))),
        onResolveCitation: referenceImport.resolveBibQuery,
        citationUsageRevision: unusedSymbols,
        citationKeys,
        citations,
        references: latex.liveReferences,
        indexPending: library.bibliographyIndexPending,
        unusedLabels: texlabActive ? [] : unusedSymbols.labels,
        unusedCitations: texlabActive ? [] : unusedSymbols.citations,
        onLoadReferenceImage: referenceImages.load,
        referenceImageGeneration: referenceImages.generation,
        localMacros: latex.macros,
        katexMacros: latex.katexMacros,
        projectPaths: latex.projectPaths,
        graphicsRoots: latex.graphicsRoots,
      }}
      navigation={{
        requests: canvasRequests.requests,
        onRequestHandled: canvasRequests.settle,
        onEditorPosition,
        onViewState: (path, state) => rememberFileViewState(path, { text: state }),
        getFileViewState,
        onFileViewState: rememberFileViewState,
        onGotoDefinition: (target) => void gotoDefinition(target),
        onTexlabGoto: (path, line) => { void openFile(path, { line }); },
        onFindReferences: (target) => void findSymbolReferences(target),
        onRenameSymbol: beginSymbolRename,
        onRenameEnvironment: (name) => beginRename({ kind: "environment", name }),
        onWrapEnvironment: () => beginRename({ kind: "wrap-environment" }),
        onGotoLineRequest: () => setSearchDialog("goto-line"),
        outlineNodes: latex.outlineNodes,
        outlineRootPath: latex.rootDocumentPath,
        onOutlineNavigate: navigateOutline,
        tableGeneratorOpen: tableGenerator.open,
        onTableGeneratorOpenChange: tableGenerator.setOpen,
        onCreateMissingFile: (path) => {
          void tree.createEntry(path, "file");
        },
      }}
      pdf={{ pdfUrl }}
      review={{
        editorComments: editorComments.all,
        overleafPresenceCursors: overleafActiveCursors,
        overleafChanges: overleafRealtime.changes,
        sourceMargin: overleafLink ? (view) => (
          <AppOverleafMarginReview overleaf={overleaf} view={view} path={documents.canvas.path} focusMode={focusMode} />
        ) : undefined,
        overleafTrackChangeActions: {
          authorName: overleafTrackChanges.authorName,
          canAct: () => overleafRealtime.canWrite,
          onAccept: (change) => void overleafTrackChanges.accept([change.id]),
          onReject: (change) => void overleafTrackChanges.reject([change]),
        },
        activeEditorCommentId: editorComments.activeId,
        // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
        commentAuthorName: comments.author.name.trim() || "Anonymous",
        commentAuthorId: comments.author.id,
        onCreateEditorComment: editorComments.create,
        annotationRounds,
        onOpenEditorComments: () => tools.open("comments"),
        onResolveEditorComment: editorComments.resolve,
        onReplyEditorComment: (commentId) => tools.open("comments", { replyTo: commentId }),
        onPostEditorCommentReply: editorComments.reply,
        commentFocusRequest: editorComments.focusRequest,
        onCommentFocusHandled: editorComments.focusHandled,
      }}
      selection={{
        setSelection: (value, lines) => agentContext.reportSelection(activePaper ? "paper" : "editor", value, undefined, lines),
        onPdfTextSelect: (value, place) => agentContext.reportSelection("pdf", value, place),
        onPaperTextSelect: (value) => agentContext.reportSelection("paper", value),
        onContextSurfaceActivate: agentContext.activateSurface,
      }}
      assets={{
        onImportAsset: tree.importClipboardImageFile,
        onOpenSlideMutation: openSlide.applyMutation,
        onOpenSlideContext: openSlide.setContext,
        onOpenSlideError: showError,
        onOpenSlideAgentRequest: (request) => {
          const root = projectRef.current?.root;
          if (!root) return;
          trellis.showPanel("agent");
          synara.sendComposerPrompt(openSlideComposerPrompt(request, root));
        },
        onPrepareFigure: tree.prepareLatexFigure,
        onPasteImageFile: tree.pasteImageFile,
        nativeFigureDropActive: tree.drops.editor,
        fileDropTargetActive: tree.drops.fileTarget,
      }}
      status={{
        buildDiagnostics: buildPipeline.compiledSources.get(activeFile) === source
          ? lastBuild?.diagnostics ?? EMPTY_DIAGNOSTICS
          : EMPTY_DIAGNOSTICS,
        texlabDiagnostics,
        todoCount: latex.todoHits.length,
        onOpenTodos: () => tools.open("todos"),
        projectWordCount: library.projectWordCount,
        saveSlot,
      }}
      hosts={{
        editorHost: trellis.hosts.editor,
        editorHibernated: layout.editorHibernated,
        hibernatedPlaceholder: null,
        decks: trellis.decks,
        switchState: trellis.switchState,
      }}
    />
  );

  // The build panel's engine actions: write the engine, then build with it.
  // `keepEngine` is the undo of an automatic switch, which must not recur.
  // Declared below the canvas: the compiler takes the canvas's
  // `buildPipeline.compiledSources.get` for a write to the pipeline and
  // memoizes no function made from it above that read, so the diagnostics
  // panel handed this one rendered again with every render of App.
  const switchEngineAndBuild = (engine: string, keepEngine?: boolean) => void showingErrors(async () => {
    const manifest = await invoke<ProjectManifest>("update_project_manifest", { engine, keepEngine });
    setProject((current) => current ? { ...current, manifest } : current);
    await buildPipeline.runBuild(false, { requested: true, sound: true });
  });
  const replaceDiagnosticToken = (diagnostic: CompileDiagnostic, token: string, replacement: string) => {
    const line = diagnostic.line;
    if (!line) return;
    const path = resolveDiagnosticPath(diagnostic.file, flattenProjectPaths(project.files), activeFile);
    void build.errorFix.replaceToken(path, line, token, replacement);
  };

  // The diagnostics' excerpts quote the open buffer, and only an expanded list
  // naming its file shows one: handed the buffer otherwise, the panel above
  // the PDF re-rendered on every keystroke for nothing on screen.
  const diagnosticSourceOf = buildPipeline.diagnosticsExpanded
    && lastBuild?.diagnostics.some((diagnostic) => diagnosticMatchesFile(diagnostic.file, activeFile))
    ? (file: string | undefined) => (diagnosticMatchesFile(file, activeFile) ? source : null)
    : undefined;

  // The compiled PDF in its own panel, beside the canvas: it takes the open
  // document's path, not its text, so only what it shows changing renders it.
  const projectPdfPanel = (
    <ProjectPdfPanel
      host={layout.pdfLive ? trellis.hosts.pdf : null}
      projectRoot={project.root}
      activeFile={documents.canvas.path}
      livePreview={livePreview}
      pdf={{
        pdfUrl,
        pdfBytes: buildPipeline.displayedPdfBytesRef.current,
        onBuildProject: () => void build.compileAndShowPdf(false, true),
        building,
        buildShortcut: build.shortcut,
        pdfTop: (!buildPipeline.diagnosticsDismissed || compileRepair.busy) && lastBuild && (!lastBuild.success || lastBuild.diagnostics.length > 0 || compileRepair.state) ? (
          <Suspense fallback={null}>
            <CompileDiagnosticsPanel
              diagnostics={lastBuild.diagnostics}
              log={lastBuild.log}
              success={lastBuild.success}
              wrotePdf={buildOutcome?.status === "failed" && buildOutcome.wrotePdf}
              expanded={buildPipeline.diagnosticsExpanded}
              onExpandedChange={buildPipeline.setDiagnosticsExpanded}
              onSelect={(diagnostic) => void build.openCompileDiagnostic(diagnostic)}
              onInstallDependency={texSetup.installDependency}
              onSwitchToPdfLatex={(project.manifest.engine ?? "pdf") === "pdf" ? undefined : () => switchEngineAndBuild("pdf")}
              onUndoEngineSwitch={(engine) => switchEngineAndBuild(engine, true)}
              onFixAll={() => { synara.requestRuntime(); void compileRepair.start(lastBuild.diagnostics); }}
              fixDisabled={!build.repairWritable || building || compileRepair.busy}
              repair={compileRepair.state}
              onCancelRepair={() => void compileRepair.cancel()}
              onOpenRepair={() => {
                const threadId = compileRepair.state?.threadId;
                if (!threadId) return;
                persistSynaraThread(project.root, threadId);
                synara.mountFrame();
                trellis.showPanel("agent");
                synara.showThread(threadId);
              }}
              onDismiss={() => buildPipeline.dismissDiagnostics(lastBuild.diagnostics)}
              sourceOf={diagnosticSourceOf}
              onReplaceToken={replaceDiagnosticToken}
              onAskAgent={(diagnostic) => { synara.requestRuntime(); void compileRepair.start([diagnostic]); }}
            />
          </Suspense>
        ) : null,
        pdfSyncTarget: syncTex.pdfSyncTarget,
        canForwardSync: syncTex.canForwardSync,
        locatingPdf: syncTex.locatingPdf,
        onForwardSync: () => void syncTex.revealSourceInPdf(),
        onPdfSource: syncTex.revealPdfSource,
        onPdfPageCount: pdfPage.setCount,
        onPdfPageChange: pdfPage.setNumber,
      }}
      citations={{
        citations,
        canOpenCitation: (key) => Boolean(readablePaperCited(key) || citationUrl(key)),
        onOpenCitation: (key) => {
          const paper = readablePaperCited(key);
          const url = citationUrl(key);
          if (paper) void openPaper(paper);
          else if (url) void openUrl(url).catch((reason) => showError(toMessage(reason)));
        },
      }}
      outline={{
        nodes: latex.outlineNodes,
        activeId: latex.activeOutlineId,
        open: outline.open,
        onOpenChange: outline.setOpen,
        onNavigate: navigateOutline,
      }}
      review={{ annotations: editorComments.all, annotationRounds }}
      selection={{
        onPdfTextSelect: (value, place) => agentContext.reportSelection("pdf", value, place),
        onContextSurfaceActivate: agentContext.activateSurface,
      }}
      viewState={{ getFileViewState, onFileViewState: rememberFileViewState }}
      onLeaveEditor={documents.canvas.onLeaveForPdf}
    />
  );

  return (
    <>
      <ChunkGate chunk={loadDocumentCanvas}>
        <Suspense fallback={null}>
          {documentCanvas}
        </Suspense>
      </ChunkGate>
      <ChunkGate chunk={loadProjectPdfPanel}>
        <Suspense fallback={null}>
          {projectPdfPanel}
        </Suspense>
      </ChunkGate>
    </>
  );
}
