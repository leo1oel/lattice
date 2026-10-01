import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useLingui } from "@lingui/react/macro";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ContextMenuItem as PierreContextMenuItem, ContextMenuOpenContext, FileTreeDropTarget } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Check, ClipboardPaste, Copy, Eye, FilePlus, FolderOpen, FolderPlus, ImagePlus, Pencil } from "lucide-react";
import { ContextMenu, ContextMenuTrigger } from "../components/ui/context-menu";
import { ExternalScrollbar } from "../components/ui/external-scrollbar";
import { absoluteProjectPath } from "../app-utils";
import type { FileNode, GitFileStatus } from "../app-types";
import { dropTargetDirectory, fromPierrePath, toPierreDirectoryPath } from "./navigator-drag";
import { PROJECT_FILE_TREE_ICONS } from "./project-file-icons";
import { useProjectTreeClipboard } from "./project-tree-clipboard";
import { ProjectTreeBackgroundMenu, ProjectTreeItemMenu, type MenuAction } from "./project-tree-context-menu";
import { PIERRE_TREE_CSS } from "./project-tree-css";
import {
  isDirectoryNode,
  parentDirectory,
  readExpandedDirectories,
  toPierreGitStatus,
  treePath,
  useProjectTreeFiles,
} from "./project-tree-files";
import { ProjectTreeHover } from "./project-tree-hover";
import { settleTreePath, useCreateRequest, useInlineCreation, type EntryKind } from "./project-tree-inline-create";
import { useProjectTreeMotion } from "./project-tree-motion";
import { afterNextPaint, selectionIncluding, useProjectTreePointerDrag } from "./project-tree-pointer-drag";
import { notifyCopied } from "../telemetry/app-notify";

// @pierre/trees virtualizes by a numeric item height, so this mirrors the
// design-system `--row-height-tree` / compact 32px row role.
const PROJECT_TREE_ITEM_HEIGHT = 32;

export type ProjectFileTreeProps = {
  projectKey: string;
  searchOpen: boolean;
  /** Incrementing signal from the header "New board" button. */
  boardCreateRequest?: number;
  /** Incrementing signal from the header "New spreadsheet" button. */
  spreadsheetCreateRequest?: number;
  /** Incrementing signal from the header "New presentation" button. */
  presentationCreateRequest?: number;
  onSearchOpenChange: (open: boolean) => void;
  files: FileNode[];
  gitStatus: GitFileStatus[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  onFile: (path: string) => void;
  onLikelyFile?: (path: string) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onBeginFileDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: EntryKind) => Promise<string>;
  onDeleteEntries: (paths: string[]) => void;
  onRenameEntry: (path: string, name: string) => Promise<string>;
  onMoveEntries: (paths: string[], targetDirectory: string) => Promise<string[]>;
  onCopyEntries: (paths: string[], targetDirectory: string) => Promise<string[]>;
  onReveal: (path: string) => void;
  onImportAssets: (targetDirectory?: string) => void;
  onPasteImage: (targetDirectory: string) => void;
  onError: (message: string) => void;
  /** "" targets the project root; only null means "no asset drag". */
  assetDropTarget: string | null;
  assetImporting: boolean;
};

function findPierreItemPath(event: { nativeEvent: Event }): string | null {
  for (const target of event.nativeEvent.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.itemPath) return target.dataset.itemPath;
  }
  return null;
}

const composedPathHas = (event: { nativeEvent: Event }, match: (target: EventTarget) => boolean) => (
  event.nativeEvent.composedPath().some(match)
);

export function ProjectFileTree(props: ProjectFileTreeProps) {
  const { t } = useLingui();
  const { showHidden, toggleHidden, tree } = useProjectTreeFiles(props.projectKey, props.files, props.onError);
  const gitStatus = useMemo(() => toPierreGitStatus(props.gitStatus), [props.gitStatus]);
  const expansionStorageKey = `lattice:expanded-directories:${props.projectKey}`;
  const propsRef = useLatestRef(props);
  const treeRef = useLatestRef(tree);
  const syncingSelectionRef = useRef(false);
  const lastLikelyFileRef = useRef<string | null>(null);
  // Pierre and the gesture hooks call these only after mount, so they may
  // close over `model` and `creation`, which are declared further down.
  const hasNode = (path: string) => (
    treeRef.current.nodes.has(path) || treeRef.current.nodes.has(toPierreDirectoryPath(fromPierrePath(path)))
  );
  const canDrag = (paths: readonly string[]) => paths.length > 0 && paths.every(hasNode);
  const resetTree = () => model.resetPaths(treeRef.current.paths);
  const commitMove = (draggedPaths: readonly string[], target: FileTreeDropTarget) => {
    const targetDirectory = dropTargetDirectory(target);
    void afterNextPaint()
      .then(() => propsRef.current.onMoveEntries(draggedPaths.map(fromPierrePath), targetDirectory))
      .catch(resetTree);
  };

  const initialExpandedPaths = useMemo(() => readExpandedDirectories(expansionStorageKey), [expansionStorageKey]);
  const initialActivePath = props.activeAssetPath || props.activeFile;
  const { model } = useFileTree({
    paths: tree.paths,
    initialExpansion: "closed",
    initialExpandedPaths,
    initialSelectedPaths: initialActivePath ? [initialActivePath] : [],
    composition: { contextMenu: { triggerMode: "right-click" } },
    density: "default",
    itemHeight: PROJECT_TREE_ITEM_HEIGHT,
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    gitStatus,
    icons: PROJECT_FILE_TREE_ICONS,
    search: true,
    searchBlurBehavior: "retain",
    stickyFolders: true,
    unsafeCSS: PIERRE_TREE_CSS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const node = treeRef.current.nodes.get(selectedPaths.at(-1) ?? "");
      if (!node || isDirectoryNode(node)) return;
      if (node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink") propsRef.current.onAsset(node.path);
      else propsRef.current.onFile(node.path);
    },
    renaming: {
      canRename: ({ path }) => creation.isPending(fromPierrePath(path)) || hasNode(path),
      onError: (message) => propsRef.current.onError(message),
      onRename: (event) => {
        const source = fromPierrePath(event.sourcePath);
        const destination = fromPierrePath(event.destinationPath);
        const name = destination.split("/").at(-1);
        if (!name) return;
        if (creation.persist(source, destination, event.isFolder)) return;
        settleTreePath(
          model,
          event.destinationPath,
          propsRef.current.onRenameEntry(source, name).then((renamed) => treePath(renamed, event.isFolder)),
          resetTree,
        );
      },
    },
    dragAndDrop: {
      canDrag,
      onDropComplete: ({ draggedPaths, target }) => commitMove(draggedPaths, target),
      onDropError: (message) => propsRef.current.onError(message),
    },
  });
  const creation = useInlineCreation(model, {
    onCreateEntry: (path, kind) => propsRef.current.onCreateEntry(path, kind),
    resetTree,
  });
  const pointerDrag = useProjectTreePointerDrag(model, {
    canDrag,
    onError: (message) => propsRef.current.onError(message),
    onDropped: commitMove,
    resetTree,
  });
  const getTreeScrollViewport = useCallback(
    () => model.getFileTreeContainer()?.shadowRoot
      ?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]') ?? null,
    [model],
  );
  useProjectTreeMotion(getTreeScrollViewport);

  const clipboard = useProjectTreeClipboard(model, () => ({ ...propsRef.current, nodes: treeRef.current.nodes }));

  const treeSignature = tree.paths.join("\u0000");
  const lastTreeIdentityRef = useRef(`${props.projectKey}\u0000${treeSignature}`);
  useEffect(() => {
    const identity = `${props.projectKey}\u0000${treeSignature}`;
    if (lastTreeIdentityRef.current === identity) return;
    lastTreeIdentityRef.current = identity;
    model.resetPaths(tree.paths, { initialExpandedPaths: readExpandedDirectories(expansionStorageKey) });
  }, [expansionStorageKey, model, props.projectKey, tree.paths, treeSignature]);

  const activePath = props.activeAssetPath || props.activeFile;
  useEffect(() => {
    syncingSelectionRef.current = true;
    try {
      const selectedPaths = model.getSelectedPaths();
      // Opening the newest member of a Command/Shift selection re-renders App
      // with that file as active. Keep the rest selected so the next drag or
      // delete remains a batch; external navigation to an unselected file
      // still replaces the tree selection.
      if (!activePath || !selectedPaths.includes(activePath)) {
        for (const selected of selectedPaths) {
          if (selected !== activePath) model.getItem(selected)?.deselect();
        }
        const item = activePath ? model.getItem(activePath) : null;
        if (item && !item.isSelected()) item.select();
      }
      if (activePath) {
        model.focusPath(activePath);
        model.scrollToPath(activePath, { focus: false, offset: "nearest" });
      }
    } finally {
      syncingSelectionRef.current = false;
    }
  }, [activePath, model, treeSignature]);

  useEffect(() => {
    if (props.searchOpen) model.openSearch();
    else model.closeSearch();
  }, [model, props.searchOpen]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  // Persist expansion (without Pierre's trailing slash) and report search
  // visibility changes the user makes inside the tree.
  useEffect(() => {
    let expandedSignature = "";
    let searchOpen = model.isSearchOpen();
    return model.subscribe(() => {
      const expanded = treeRef.current.directoryPaths
        .filter((path) => {
          const item = model.getItem(path);
          return !!item && "isExpanded" in item && item.isExpanded();
        })
        .map(fromPierrePath);
      const nextExpandedSignature = expanded.join("\u0000");
      if (nextExpandedSignature !== expandedSignature) {
        expandedSignature = nextExpandedSignature;
        try {
          localStorage.setItem(expansionStorageKey, JSON.stringify(expanded));
        } catch {
          // Expansion still works in memory when persistence is unavailable.
        }
      }
      const nextSearchOpen = model.isSearchOpen();
      if (nextSearchOpen !== searchOpen) {
        searchOpen = nextSearchOpen;
        propsRef.current.onSearchOpenChange(nextSearchOpen);
      }
    });
  }, [expansionStorageKey, model, propsRef, treeRef]);

  useEffect(() => {
    const markNativeDropTarget = () => {
      const root = model.getFileTreeContainer()?.shadowRoot;
      if (!root) return;
      for (const row of root.querySelectorAll<HTMLElement>("[data-lattice-native-drop-target]")) {
        delete row.dataset.latticeNativeDropTarget;
      }
      if (!props.assetDropTarget) return;
      const path = toPierreDirectoryPath(props.assetDropTarget);
      for (const row of root.querySelectorAll<HTMLElement>("[data-item-type='folder'][data-item-path]")) {
        if (row.dataset.itemPath === path) row.dataset.latticeNativeDropTarget = "true";
      }
    };
    markNativeDropTarget();
    return model.subscribe(markNativeDropTarget);
  }, [model, props.assetDropTarget]);

  useCreateRequest(props.boardCreateRequest, () => creation.begin("", "file", "tldr"));
  useCreateRequest(props.spreadsheetCreateRequest, () => creation.begin("", "file", "lattice-sheet"));
  useCreateRequest(props.presentationCreateRequest, () => creation.begin("slides", "presentation"));

  const creationActions = (directory: string): MenuAction[] => [
    { icon: FilePlus, label: t`New file`, run: () => creation.begin(directory, "file") },
    { icon: FolderPlus, label: t`New folder`, run: () => creation.begin(directory, "folder") },
  ];
  const hiddenFilesAction: MenuAction = {
    icon: showHidden ? Check : Eye,
    label: t`Show hidden files`,
    checked: showHidden,
    run: toggleHidden,
  };

  const renderContextMenu = (item: PierreContextMenuItem, context: ContextMenuOpenContext) => {
    const path = fromPierrePath(item.path);
    const directory = item.kind === "directory";
    const deletionPaths = selectionIncluding(model, item.path).map(fromPierrePath);
    const protectedEntry = deletionPaths.some((deletedPath) => props.protectedPaths.some(
      (protectedPath) => protectedPath === deletedPath || protectedPath.startsWith(`${deletedPath}/`),
    ));
    const actions: MenuAction[] = [
      ...creationActions(directory ? path : parentDirectory(path)),
      { icon: Pencil, label: t`Rename`, run: () => model.startRenaming(item.path) },
      {
        icon: Copy,
        label: t`Copy path`,
        run: () => void writeText(absoluteProjectPath(props.projectKey, path)).then(() => notifyCopied(t`Path copied`)),
      },
      { icon: FolderOpen, label: t`Show in Finder`, run: () => props.onReveal(path) },
      hiddenFilesAction,
      ...(directory ? [
        { icon: ImagePlus, label: t`Import images here`, disabled: props.assetImporting, run: () => props.onImportAssets(path) },
        { icon: ClipboardPaste, label: t`Paste clipboard image as figure`, run: () => props.onPasteImage(path) },
      ] : []),
    ];
    const destructive = protectedEntry ? null : {
      label: creation.isPending(path) && deletionPaths.length === 1 ? t`Cancel creation` : t`Delete`,
      run: () => {
        const persistedPaths = deletionPaths.filter((deletedPath) => !creation.clear(deletedPath));
        if (persistedPaths.length) props.onDeleteEntries(persistedPaths);
      },
    };
    return <ProjectTreeItemMenu context={context} actions={actions} destructive={destructive} />;
  };

  const reportLikelyFile = (event: React.SyntheticEvent) => {
    const path = findPierreItemPath(event);
    const node = path ? tree.nodes.get(path) : null;
    if (!node || isDirectoryNode(node) || !/\.mdx?$/i.test(node.path)) return;
    if (lastLikelyFileRef.current === node.path) return;
    lastLikelyFileRef.current = node.path;
    props.onLikelyFile?.(node.path);
  };
  // Enter renames the single selected row; Command-C/V copy and paste files.
  const shortcut = (event: React.KeyboardEvent): (() => void) | undefined => {
    if (event.altKey || event.shiftKey) return undefined;
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLocaleLowerCase();
      if (key === "c") return clipboard.copy;
      if (key === "v") return () => void clipboard.paste().catch((reason) => propsRef.current.onError(String(reason)));
      return undefined;
    }
    const selected = event.key === "Enter" ? model.getSelectedPaths() : [];
    return selected.length === 1 ? () => model.startRenaming(selected[0]) : undefined;
  };
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    const editingText = composedPathHas(event, (target) => (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable)
    ));
    const action = editingText ? undefined : shortcut(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="project-file-tree-surface" aria-label={t`Project files`} onKeyDownCapture={onKeyDownCapture}>
          <FileTree
            className="lattice-file-tree"
            model={model}
            renderContextMenu={renderContextMenu}
            onPointerOverCapture={reportLikelyFile}
            onFocusCapture={reportLikelyFile}
            onContextMenu={(event) => {
              if (findPierreItemPath(event) || composedPathHas(event, (target) => target instanceof HTMLInputElement)) {
                event.stopPropagation();
              }
            }}
            onPointerDown={(event) => {
              const interactiveControl = composedPathHas(event, (target) => target instanceof HTMLInputElement
                || (target instanceof HTMLElement && target.dataset.type === "context-menu-trigger"));
              const path = interactiveControl ? null : findPierreItemPath(event);
              if (!path) return;
              pointerDrag.begin(path, event);
              const node = tree.nodes.get(path);
              if (node?.kind === "figure" || node?.contentKind === "binary") {
                props.onBeginFigureDrag(node.path, node.name, event);
              } else if (node && !isDirectoryNode(node)) {
                props.onBeginFileDrag(node.path, node.name, event);
              }
            }}
            onDragStartCapture={pointerDrag.onDragStartCapture}
            onClickCapture={pointerDrag.onClickCapture}
          />
          <ExternalScrollbar getViewport={getTreeScrollViewport} />
          <ProjectTreeHover getViewport={getTreeScrollViewport} />
        </div>
      </ContextMenuTrigger>
      <ProjectTreeBackgroundMenu actions={[...creationActions(""), hiddenFilesAction]} />
    </ContextMenu>
  );
}
