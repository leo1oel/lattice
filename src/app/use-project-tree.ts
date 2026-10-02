import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { OverleafLink, ProjectSnapshot } from "../app-types";
import {
  absoluteProjectPath, applyProjectPathChanges, classifyExternalProjectDrop, confirmAction, dropAgentPanelAt,
  dropCanvasAt, dropDirectoryAt, dropEditorAt, projectItemPath, remapProjectPath, toMessage, type ProjectPathChange,
} from "../app-utils";
import { buildAgentComposerFilesMessage, type AgentComposerFilePayload } from "../agent/agent-composer-files";
import { waitForAgentCanvasAdapter } from "../agent/agent-canvas-tools";
import type { AgentProjectDocumentToolRequest } from "../agent/agent-project-document-tools";
import { waitForAgentSpreadsheetDocument } from "../agent/agent-spreadsheet-tools";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "../editor/insert/clipboard-image";
import { rewriteMovedDocumentAssetPaths } from "../editor/insert/figure-insertion";
import type { OverleafSyncMode } from "../settings/app-settings";
import { logAction } from "../telemetry/app-notify";
import type { TrellisController } from "../trellis/trellis-controller";
import { disposeWhenSettled } from "./effect-helpers";
import { useLatestRef } from "../hooks/use-latest-ref";
import { setError } from "./notify";
import type { UpdateCanvasRequest } from "./use-canvas-requests";
import type { OpenDocuments } from "./use-open-documents";
import type { useProjectLibrary } from "./use-project-library";
import type { ProjectState, useProjectTreeWatch } from "./use-project-state";

const loadWebview = () => import("@tauri-apps/api/webview");
const loadClipboard = () => import("@tauri-apps/plugin-clipboard-manager");

/** A text document whose figure paths are relative to its own folder, so a move rewrites them. */
const isMovableDocument = (path: string) => /\.(?:tex|md)$/i.test(path);

/**
 * Follow a pointer drag of a project-tree row. Past a 5px threshold,
 * `handOff` gets each pointer position until it takes the drag over (the
 * Trellis workspace, once the pointer leaves the Project panel); the click
 * that ends a handed-off drag is swallowed through `suppressClick`. A drag
 * that never leaves the panel belongs to the tree, which moves files.
 */
function trackProjectItemDrag(
  path: string,
  event: React.PointerEvent,
  suppressClick: { current: string | null },
  handOff: (pointer: PointerEvent) => boolean,
) {
  if (event.button !== 0) return;
  const { clientX: startX, clientY: startY, pointerId } = event;
  let dragging = false;
  const listening = new AbortController();
  const end = () => {
    listening.abort();
    document.body.classList.remove("dragging-project-item");
  };
  const onMove = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
    if (!dragging) document.body.classList.add("dragging-project-item");
    dragging = true;
    if (!handOff(pointer)) return;
    end();
    suppressClick.current = path;
    window.setTimeout(() => {
      if (suppressClick.current === path) suppressClick.current = null;
    }, 400);
  };
  window.addEventListener("pointermove", onMove, { passive: false, signal: listening.signal });
  window.addEventListener("pointerup", end, { signal: listening.signal });
  window.addEventListener("pointercancel", end, { signal: listening.signal });
  window.addEventListener("blur", end, { signal: listening.signal });
}

/**
 * Once a tree drag leaves the Project panel, cancel the tree's own drag (it
 * moves files between folders) and let Trellis drag the file as a panel.
 */
function trellisTakesProjectDrag(trellis: TrellisController, path: string, pointer: PointerEvent) {
  const panel = trellis.panelRect("project");
  if (!panel) return false;
  const inside = pointer.clientX >= panel.left && pointer.clientX <= panel.right
    && pointer.clientY >= panel.top && pointer.clientY <= panel.bottom;
  if (inside) return false;
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: pointer.pointerId, pointerType: pointer.pointerType }));
  return trellis.beginFileDrag(path, pointer);
}

/** Read the image on the system clipboard as PNG bytes. */
async function readClipboardPng() {
  const { readImage } = await loadClipboard();
  const image = await readImage();
  const size = await image.size();
  return { base64: await rgbaImageToPngBase64(await image.rgba(), size.width, size.height), type: "image/png" };
}

export type ProjectTreeDeps = {
  projectState: ProjectState;
  documents: OpenDocuments;
  library: Pick<ReturnType<typeof useProjectLibrary>, "refreshProject" | "refreshHistory">;
  setGitStatus: ReturnType<typeof useProjectTreeWatch>["setGitStatus"];
  overleaf: {
    link: OverleafLink | null;
    syncMode: OverleafSyncMode;
    syncRef: RefObject<(options?: { auto?: boolean }) => Promise<void>>;
    settleRemoteDeletes: (paths: string[], projectRoot: string, generation: number) => Promise<void>;
  };
  /** Paths in App's own derived state (outline sources, build diagnostics) follow a rename or move. */
  remapDerivedPaths: (remap: (path: string) => string) => void;
  updateCanvasRequest: UpdateCanvasRequest;
  /** Relay files dropped on the Agent panel into its composer. */
  postAgentMessage: (message: object) => void;
  /** Where the Agent's create-a-document tool finds this project's creator. */
  agentDocumentCreatorRef: { current: ((request: AgentProjectDocumentToolRequest) => Promise<string>) | null };
  trellis: TrellisController;
};

/**
 * The project tree's commands: creating, deleting, renaming, moving, copying
 * and importing entries (Finder drops and clipboard figures included), and
 * a tree row dragged out of the Project panel into a panel of its own.
 *
 * A rename or move applies optimistically — the tree, the open documents,
 * Git decorations and App's derived paths all follow at once — and rolls
 * back what did not complete if the backend refuses. Every successful delete
 * retires the open documents' references before the tree refreshes.
 * Commands keep their identity across renders: App's handlers read the
 * latest project, Overleaf and document state through `deps`.
 */
export function useProjectTree(deps: ProjectTreeDeps) {
  const { t } = useLingui();
  const depsRef = useLatestRef(deps);
  const { projectState, documents, trellis } = deps;
  const { project, setProject, projectOperationGenerationRef, withTreeMutation, reconcileProjectTree } = projectState;
  const {
    openFile, openAsset, flush, save, accept, markDiskVersion, remove: removeDocuments, move: moveDocuments,
    edit: editFile, reveal, assetPaths,
  } = documents;
  const { file: activeFileRef, text: sourceRef } = documents.live;
  const { allow: allowViewState } = documents.viewStates;
  const projectRoot = project?.root;
  const [assetImporting, setAssetImporting] = useState(false);
  const assetImportingRef = useLatestRef(assetImporting);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [editorDropActive, setEditorDropActive] = useState(false);
  const [fileDropTargetActive, setFileDropTargetActive] = useState(false);
  const [agentPanelDropActive, setAgentPanelDropActive] = useState(false);
  const nativeDragPathsRef = useRef<string[]>([]);
  const suppressedFigureClick = useRef<string | null>(null);
  const suppressedFileClick = useRef<string | null>(null);

  // A tree row dragged out of the Project panel becomes a panel wherever it is
  // dropped; the click that ends that drag must not also open it here.
  const openFileFromClick = useCallback((path: string, line?: number) => {
    if (suppressedFileClick.current === path) {
      suppressedFileClick.current = null;
      return;
    }
    void openFile(path, { line });
  }, [openFile]);
  const openAssetFromClick = useCallback((path: string) => {
    if (suppressedFigureClick.current === path) {
      suppressedFigureClick.current = null;
      return;
    }
    void openAsset(path);
  }, [openAsset]);
  const beginFigureDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedFigureClick, (pointer) => trellisTakesProjectDrag(trellis, path, pointer));
  }, [trellis]);
  const beginFileDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedFileClick, (pointer) => trellisTakesProjectDrag(trellis, path, pointer));
  }, [trellis]);

  const createEntry = useCallback(async (path: string, kind: "file" | "folder" | "presentation") => {
    const { refreshProject, refreshHistory } = depsRef.current.library;
    const create = async () => {
      const createdPath = kind === "presentation"
        ? await invoke<string>("create_open_slide_deck", { deckId: path, projectRoot })
        : await invoke<string>("create_project_entry", { path, kind, projectRoot });
      allowViewState(createdPath);
      await refreshProject();
      await refreshHistory();
      if (kind !== "folder") {
        // A local-only file has no Overleaf document id and therefore cannot
        // join realtime editing. Upload it before opening the editor so the
        // first keystroke does not have to wait for a later full-sync timer.
        const { overleaf } = depsRef.current;
        if (overleaf.link && overleaf.syncMode === "live") await overleaf.syncRef.current({ auto: true });
        await openFile(createdPath);
      }
      return createdPath;
    };
    return create().catch((reason: unknown) => {
      setError(toMessage(reason));
      throw reason;
    });
  }, [allowViewState, depsRef, openFile, projectRoot]);
  useLayoutEffect(() => {
    const { agentDocumentCreatorRef } = depsRef.current;
    const createAgentProjectDocument = async (request: AgentProjectDocumentToolRequest) => {
      if (!projectRoot) {
        // eslint-disable-next-line lingui/no-unlocalized-strings -- tool error returned to the agent
        throw Object.assign(new Error("Open a Lattice project before creating a document."), {
          code: "project_document_project_unavailable",
        });
      }
      const createdPath = await createEntry(request.args.path, "file");
      const remainingMs = request.expiresAt - Date.now();
      const documentReady = request.args.documentType === "board" ? waitForAgentCanvasAdapter : waitForAgentSpreadsheetDocument;
      await documentReady(createdPath, remainingMs);
      return createdPath;
    };
    agentDocumentCreatorRef.current = createAgentProjectDocument;
    return () => {
      if (agentDocumentCreatorRef.current === createAgentProjectDocument) agentDocumentCreatorRef.current = null;
    };
  }, [createEntry, depsRef, projectRoot]);

  /** Copy figures into `targetDirectory`; resolves the paths they landed at (none on failure). */
  const importAssets = useCallback(async (paths: string[], targetDirectory = "figures"): Promise<string[]> => {
    if (!paths.length || assetImportingRef.current) return [];
    setAssetImporting(true);
    const trace = logAction(t`Figures`, t`Import figures`, paths.join(", "));
    const run = async () => {
      const imported = await invoke<string[]>("import_project_assets", { paths, targetDirectory, projectRoot });
      for (const importedPath of imported) allowViewState(importedPath);
      await depsRef.current.library.refreshProject();
      const count = imported.length;
      trace.ok(targetDirectory
        ? count === 1 ? t`Imported ${count} figure into ${targetDirectory}.` : t`Imported ${count} figures into ${targetDirectory}.`
        : count === 1 ? t`Imported ${count} figure into the project root.` : t`Imported ${count} figures into the project root.`);
      return imported;
    };
    return run().catch((reason: unknown) => {
      trace.fail(reason);
      return [];
    }).finally(() => {
      setAssetImporting(false);
      setAssetDropTarget(null);
    });
  }, [allowViewState, assetImportingRef, depsRef, projectRoot, t]);

  /**
   * Run an import into the project tree and settle what it added: re-admit
   * the paths to view-state memory, then refresh the tree and history.
   */
  const importIntoProject = useCallback(async (run: () => Promise<string[]>): Promise<string[]> => {
    if (assetImportingRef.current) return [];
    setAssetImporting(true);
    const settle = async () => {
      const imported = await run();
      for (const path of imported) allowViewState(path);
      await reconcileProjectTree();
      await depsRef.current.library.refreshHistory();
      return imported;
    };
    return settle().catch((reason: unknown) => {
      setError(toMessage(reason));
      return [];
    }).finally(() => {
      setAssetImporting(false);
      setAssetDropTarget(null);
    });
  }, [allowViewState, assetImportingRef, depsRef, reconcileProjectTree]);

  const importSources = useCallback(async (paths: string[], targetDirectory = "") => (
    paths.length ? importIntoProject(() => (
      invoke<string[]>("import_project_sources", { paths, targetDirectory, projectRoot })
    )) : []
  ), [importIntoProject, projectRoot]);

  /**
   * Finder-style tree drops: any mix of files and folders, routed by the
   * backend on content (UTF-8 text through the transaction log, the rest
   * copied).
   */
  const importFiles = useCallback(async (paths: string[], targetDirectory = "", copyExisting = false) => (
    paths.length ? importIntoProject(async () => {
      const imported = await invoke<{ path: string }[]>("import_project_files", {
        paths, targetDirectory, projectRoot,
        ...(copyExisting ? { copyExisting: true } : {}),
      });
      return imported.map((file) => file.path);
    }) : []
  ), [importIntoProject, projectRoot]);

  /** Duplicate project entries into `targetDirectory` (the tree's copy and paste). */
  const copyEntries = useCallback((paths: string[], targetDirectory: string) => (project
    ? importFiles(paths.map((path) => absoluteProjectPath(project.root, path)), targetDirectory, true)
    : Promise.resolve([])
  ), [importFiles, project]);

  const chooseAssets = useCallback(async (targetDirectory = "figures") => {
    const selected = await open({
      multiple: true,
      title: t`Import figures into ${targetDirectory}`,
      filters: [{ name: t`Figures`, extensions: ["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"] }],
    });
    if (!selected) return;
    await importAssets(Array.isArray(selected) ? selected : [selected], targetDirectory);
  }, [importAssets, t]);

  // Files dragged in from Finder. The tree takes any mix into the folder under
  // the pointer; an editor or the canvas imports and opens them (or, for
  // figures over a TeX or Markdown editor, inserts them); the Agent panel
  // attaches them to its composer.
  useEffect(() => {
    if (!project) return;
    let active = true;
    const clearDropHighlights = () => {
      nativeDragPathsRef.current = [];
      setAssetDropTarget(null);
      setEditorDropActive(false);
      setFileDropTargetActive(false);
      setAgentPanelDropActive(false);
    };
    const dispose = disposeWhenSettled(loadWebview()
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (!active) return;
        if (event.payload.type === "leave") {
          clearDropHighlights();
          return;
        }
        if (event.payload.type === "enter") nativeDragPathsRef.current = event.payload.paths;
        const dragPaths = event.payload.type === "over" ? nativeDragPathsRef.current : event.payload.paths;
        const editorPosition = dropEditorAt(event.payload.position);
        const canvasTarget = dropCanvasAt(event.payload.position);
        const targetDirectory = dropDirectoryAt(event.payload.position);
        const agentPanelTarget = dropAgentPanelAt(event.payload.position);
        const dropKind = classifyExternalProjectDrop(dragPaths);
        const editorPath = activeFileRef.current;
        const insertsIntoEditor = Boolean(editorPosition && dropKind === "asset" && /\.(?:tex|md)$/i.test(editorPath ?? ""));
        // The tree accepts every drop kind, so the highlight only tracks
        // geometry (null when the pointer is not over the Project tree).
        setAssetDropTarget(targetDirectory);
        setEditorDropActive(insertsIntoEditor);
        setAgentPanelDropActive(agentPanelTarget && dropKind !== "unsupported");
        // Sources open in the editor under the pointer; figures do too unless they insert into its text.
        const opensInEditor = dropKind === "source" || (dropKind === "asset" && !insertsIntoEditor);
        setFileDropTargetActive(Boolean(editorPosition && opensInEditor));
        if (event.payload.type !== "drop") return;
        clearDropHighlights();
        if (!event.payload.paths.length) return;
        if (agentPanelTarget && dropKind !== "unsupported") {
          // The agent iframe never sees native drops (Tauri intercepts
          // them), so read the bytes here and relay them over the embed
          // bridge into the composer, same as its "+" attachment menu.
          // Checked ahead of the source/mixed branches: any file the agent
          // can read (figures and text sources alike) becomes an attachment.
          void invoke<AgentComposerFilePayload[]>("read_agent_composer_files", { paths: event.payload.paths })
            .then((files) => depsRef.current.postAgentMessage(buildAgentComposerFilesMessage(files)))
            .catch((error) => setError(toMessage(error)));
        } else if (dropKind === "source" && (editorPosition || canvasTarget)) {
          void importSources(event.payload.paths).then(async (paths) => {
            for (const path of paths) await openFile(path);
          });
        } else if (targetDirectory !== null) {
          // The Project tree takes any mix, Finder-style, into the folder
          // under the pointer ("" is the project root). Imported files land
          // without opening; editor/canvas drops import and open instead.
          void importFiles(event.payload.paths, targetDirectory);
        } else if (dropKind === "source") {
          setError(t`Drop source files onto an editor or the Project pane`);
        } else if (dropKind === "mixed") {
          setError(t`Drop source files and figures separately`);
        } else if (dropKind === "unsupported") {
          setError(t`This file type can’t be opened in an editor`);
        } else if (editorPosition && insertsIntoEditor) {
          void importAssets(event.payload.paths, "figures").then((paths) => {
            if (!paths.length) return;
            depsRef.current.updateCanvasRequest("figure", {
              id: crypto.randomUUID(), paths, clientX: editorPosition.x, clientY: editorPosition.y,
            });
          });
        } else if (canvasTarget) {
          void importAssets(event.payload.paths, "figures").then(async (paths) => {
            for (const path of paths) await openAsset(path);
          });
        } else {
          setError(t`Drop figures onto a TeX or Markdown editor, or the Project pane`);
        }
      }))
      // Browser-based tests and previews do not expose native file paths.
      .catch(() => () => undefined));
    return () => {
      active = false;
      dispose();
    };
  }, [activeFileRef, depsRef, importAssets, importFiles, importSources, openAsset, openFile, project, t]);

  /** Turn a figure the LaTeX toolchain cannot include as-is into one it can; resolves the path to include. */
  const prepareLatexFigure = useCallback(async (path: string): Promise<string | null> => {
    const prepare = async () => {
      const prepared = await invoke<string>("prepare_latex_figure", { path, projectRoot });
      if (prepared !== path) await depsRef.current.library.refreshProject();
      return prepared;
    };
    return prepare().catch((reason: unknown) => {
      setError(toMessage(reason));
      return null;
    });
  }, [depsRef, projectRoot]);

  const deleteEntries = useCallback(async (requestedPaths: string[]) => {
    const paths = [...new Set(requestedPaths.map((path) => path.replace(/[\\/]+$/, "")))]
      .filter((path, _index, candidates) => !candidates.some(
        (candidate) => candidate !== path && path.startsWith(`${candidate}/`),
      ));
    if (!paths.length) return;
    const path = paths[0];
    const confirmation = paths.length === 1
      ? t({ message: `Delete “${{ path }}” from this project?` })
      : t({ message: `Delete ${{ count: paths.length }} selected items from this project?` });
    if (!await confirmAction({
      title: confirmation,
      message: t`This action cannot be undone.`,
      confirmLabel: t`Delete`,
      destructive: true,
    })) return;
    const remove = async () => {
      for (const path of paths) await invoke("delete_project_entry", { path, projectRoot: project?.root });
      // A successful disk deletion authoritatively retires every UI reference
      // to that path, including files removed through a deleted directory.
      await removeDocuments(paths);
      const { overleaf } = depsRef.current;
      if (overleaf.link && project) {
        // Structural deletes do not pass through `save()`, so handle the
        // remote side now instead of waiting for an unrelated later sync.
        await overleaf.settleRemoteDeletes(paths, project.root, projectOperationGenerationRef.current);
      }
      await depsRef.current.library.refreshHistory();
    };
    await remove().catch((reason: unknown) => setError(toMessage(reason)));
  }, [depsRef, project, projectOperationGenerationRef, removeDocuments, t]);

  /** Everything that names a path follows a rename or move: the tree, open documents, Git decorations, derived state. */
  const applyPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);
    moveDocuments(changes);
    setProject((current: ProjectSnapshot | null) => current ? applyProjectPathChanges(current, changes) : current);
    depsRef.current.setGitStatus((current) => ({
      ...current,
      files: current.files.map((file) => ({ ...file, path: remapPath(file.path) })),
    }));
    depsRef.current.remapDerivedPaths(remapPath);
  }, [depsRef, moveDocuments, setProject]);

  const renameEntry = useCallback((path: string, name: string) => withTreeMutation(async () => {
    const rename = async () => {
      const renamedPath = await invoke<string>("rename_project_entry", { path, newName: name, projectRoot });
      applyPathChanges([{ previousPath: path, nextPath: renamedPath }]);
      void markDiskVersion();
      return renamedPath;
    };
    return rename().catch(async (reason: unknown) => {
      setError(toMessage(reason));
      await reconcileProjectTree().catch(() => undefined);
      throw reason;
    });
  }), [applyPathChanges, markDiskVersion, projectRoot, reconcileProjectTree, withTreeMutation]);

  const moveEntries = useCallback(async (paths: string[], targetDirectory: string): Promise<string[]> => {
    const normalizedTarget = targetDirectory.trim().replace(/[\\/]+$/, "");
    const plannedChanges = paths.map((path): ProjectPathChange => ({
      previousPath: path,
      nextPath: normalizedTarget
        ? `${normalizedTarget}/${path.split("/").at(-1) ?? path}`
        : (path.split("/").at(-1) ?? path),
    }));
    const completedChanges: ProjectPathChange[] = [];
    const originalPrimaryPath = activeFileRef.current;
    let optimisticChangesApplied = false;
    const move = async (): Promise<string[]> => {
      if (plannedChanges.some((change) => isMovableDocument(change.previousPath) && change.previousPath === originalPrimaryPath)) {
        if (!flush()) {
          setError(t`Try again`);
          return [];
        }
        // save() already reports the path and underlying write failure.
        if (!(await save())) return [];
      }
      applyPathChanges(plannedChanges);
      optimisticChangesApplied = true;
      for (const planned of plannedChanges) {
        const movedPath = await invoke<string>("move_project_entry", {
          path: planned.previousPath,
          targetDirectory: normalizedTarget,
          projectRoot,
        });
        completedChanges.push({ previousPath: planned.previousPath, nextPath: movedPath });
        if (planned.nextPath !== movedPath) applyPathChanges([{ previousPath: planned.nextPath, nextPath: movedPath }]);
        if (!isMovableDocument(planned.previousPath)) continue;
        const isOpen = planned.previousPath === originalPrimaryPath;
        const content = isOpen
          ? sourceRef.current
          : await invoke<string>("read_project_file", { path: movedPath, projectRoot });
        const rewritten = rewriteMovedDocumentAssetPaths(content, planned.previousPath, movedPath, assetPaths);
        if (rewritten === content) continue;
        // The open buffer takes the rewrite at once, so typing during the
        // write builds on it; it is clean again once the write lands.
        if (isOpen) editFile(rewritten);
        await invoke("write_project_file", { path: movedPath, content: rewritten, projectRoot });
        if (isOpen) accept(movedPath, rewritten, { text: rewritten });
      }
      void markDiskVersion();
      return completedChanges.map((change) => change.nextPath);
    };
    return withTreeMutation(() => move().catch(async (reason: unknown) => {
      const completedPaths = new Set(completedChanges.map((change) => change.previousPath));
      const rollbackChanges = optimisticChangesApplied
        ? plannedChanges
          .filter((change) => !completedPaths.has(change.previousPath))
          .reverse()
          .map((change) => ({ previousPath: change.nextPath, nextPath: change.previousPath }))
        : [];
      applyPathChanges(rollbackChanges);
      setError(toMessage(reason));
      await reconcileProjectTree().catch(() => undefined);
      throw reason;
    }));
  }, [
    accept, activeFileRef, applyPathChanges, assetPaths, editFile, flush, markDiskVersion, projectRoot,
    reconcileProjectTree, save, sourceRef, t, withTreeMutation,
  ]);

  /** Save pasted image bytes into the project; resolves the new path. */
  const importImageBytes = useCallback(async (
    readPng: () => Promise<{ base64: string; type: string }>,
    targetDirectory: string,
    emptyMessage = "",
  ): Promise<string | null> => {
    const store = async () => {
      const { base64, type } = await readPng();
      const path = await invoke<string>("import_clipboard_image", {
        targetDirectory, fileName: clipboardImageFileName(type), base64Data: base64, projectRoot,
      });
      await depsRef.current.library.refreshProject();
      return path;
    };
    return store().catch((reason: unknown) => {
      setError(toMessage(reason) || emptyMessage);
      return null;
    });
  }, [depsRef, projectRoot]);
  const importClipboardImageFile = useCallback((file: File) => importImageBytes(
    async () => ({ base64: await fileToBase64(file), type: file.type || "image/png" }),
    "figures",
  ), [importImageBytes]);
  const importSystemClipboardImage = useCallback(async (targetDirectory: string) => (
    project ? importImageBytes(readClipboardPng, targetDirectory, t`No image found on the clipboard.`) : null
  ), [importImageBytes, project, t]);
  /** Insert an imported figure at the editor caret. */
  const insertFigureAtCaret = useCallback((path: string | null) => {
    if (path) depsRef.current.updateCanvasRequest("figure", { id: crypto.randomUUID(), paths: [path], clientX: -1, clientY: -1 });
  }, [depsRef]);
  /** An image pasted into the editor becomes a project figure inserted at the caret. */
  const pasteImageFile = useCallback((file: File) => {
    void importClipboardImageFile(file).then(insertFigureAtCaret);
    return true;
  }, [importClipboardImageFile, insertFigureAtCaret]);
  /** The system clipboard's image becomes a figure in the open .tex file. */
  const pasteClipboardImage = useCallback(async () => {
    if (!project || !activeFileRef.current.endsWith(".tex")) {
      setError(t`Open a .tex file before pasting a figure.`);
      return;
    }
    const path = await importSystemClipboardImage("figures");
    if (!path) return;
    reveal("editor");
    insertFigureAtCaret(path);
  }, [activeFileRef, importSystemClipboardImage, insertFigureAtCaret, project, reveal, t]);

  const revealItem = useCallback(async (relativePath: string) => {
    if (!project) return;
    await revealItemInDir(projectItemPath(project.root, relativePath)).catch((reason: unknown) => {
      const message = toMessage(reason);
      setError(t`Could not show that item in Finder. ${message}`);
    });
  }, [project, t]);

  return {
    assetImporting, assetDropTarget,
    /** Where a Finder drag is over: a figure would insert into the editor, a file would open there, the Agent would attach it. */
    drops: { editor: editorDropActive, fileTarget: fileDropTargetActive, agentPanel: agentPanelDropActive },
    openFileFromClick, openAssetFromClick, beginFigureDrag, beginFileDrag,
    createEntry, deleteEntries, renameEntry, moveEntries, copyEntries, revealItem, chooseAssets,
    importSystemClipboardImage, importClipboardImageFile, pasteImageFile, pasteClipboardImage, prepareLatexFigure,
  };
}
