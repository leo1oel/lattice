import type { CanvasMode, EditorPaneId, FileNode, PaperSummary, ProjectSnapshot } from "../app-types";
import {
  isHtmlFilePath,
  isPaperTabKey,
  isPreviewableSourceFilePath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  paperTabKey,
} from "../app-utils";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import type { WorkspaceLayout } from "../settings/app-settings";

/** Every non-directory path in the tree that `include` accepts, in tree order. */
export function collectFilePaths(nodes: FileNode[], include: (node: FileNode) => boolean, paths: string[] = []): string[] {
  for (const node of nodes) {
    const isDirectory = node.kind === "directory" || node.contentKind === "directory";
    if (!isDirectory && include(node)) paths.push(node.path);
    if (node.children.length) collectFilePaths(node.children, include, paths);
  }
  return paths;
}

/** Every non-directory path the project shows as an image/binary preview rather than text. */
export function collectAssetPaths(nodes: FileNode[]): Set<string> {
  // SVG is text on disk but remains an image when tabs are selected or restored.
  return new Set(collectFilePaths(nodes, (node) => isProjectAssetFilePath(node.path)
    || node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink"));
}

/**
 * The canvas mode a restored active tab opens in. Workspaces saved by the old
 * fixed layout may say "dual" (two editors side by side): documents now get a
 * panel each, so that becomes the plain editor.
 */
function restoredCanvasMode(
  activeTab: string,
  kind: "paper" | "asset" | "document",
  layout: WorkspaceLayout | null,
): CanvasMode {
  const saved = layout?.canvasMode === "dual" ? "source" : layout?.canvasMode;
  if (kind === "paper") return saved === "source" || saved === "split" ? saved : "pdf";
  if (kind === "asset") return "asset";
  if (isHtmlFilePath(activeTab)) {
    return layout?.activeTab === activeTab && (saved === "source" || saved === "split" || saved === "pdf") ? saved : "pdf";
  }
  if (!isPreviewableSourceFilePath(activeTab)) return "source";
  return saved ?? "split";
}

/**
 * Where to put a project's workspace back: which files load into the panes,
 * which tabs reopen, the active tab and the canvas mode.
 * `layout` is the saved per-project workspace; `lastFile` is the single file
 * older releases remembered, kept as the migration fallback.
 */
export function planWorkspaceRestore(
  snapshot: ProjectSnapshot,
  papers: PaperSummary[],
  layout: WorkspaceLayout | null,
  lastFile: string | null,
) {
  const assetPaths = collectAssetPaths(snapshot.files);
  const sourcePaths = new Set(flattenProjectPaths(snapshot.files).filter((path) => (
    !isPaperTabKey(path) && !assetPaths.has(path) && isProjectSourceFilePath(path)
  )));
  // Root documents are authoritative even when the file tree omits them (a
  // lightweight test fixture skips the duplicate tree node).
  const rootDocuments = snapshot.manifest.rootDocuments;
  for (const document of rootDocuments) {
    if (isProjectSourceFilePath(document.path)) sourcePaths.add(document.path);
  }
  const paperKeys = new Set(papers.map((paper) => paperTabKey(paper.arxivId)));
  const validTab = (path: string) => sourcePaths.has(path) || assetPaths.has(path) || paperKeys.has(path);
  const rootDocument = rootDocuments.find((document) => document.path === "main.tex")
    ?? rootDocuments.find((document) => document.isDefault)
    ?? rootDocuments[0];
  const primaryFile: string | undefined = [layout?.activeFile, lastFile, rootDocument?.path]
    .find((path): path is string => Boolean(path) && sourcePaths.has(path!)) ?? [...sourcePaths][0];
  // Each document has its own panel now: nothing loads into a second pane.
  const secondaryFile: string | null = null;

  const tabs = layout ? layout.openTabs.filter(validTab) : primaryFile ? [primaryFile] : [];
  const activeTab = layout?.activeTab && validTab(layout.activeTab) ? layout.activeTab : primaryFile ?? tabs[0] ?? "";
  if (activeTab && !tabs.includes(activeTab)) tabs.push(activeTab);
  const activeKind = paperKeys.has(activeTab) ? "paper" : assetPaths.has(activeTab) ? "asset" : "document";
  const mode = restoredCanvasMode(activeTab, activeKind, layout);
  // The saved recency order first, then any open tab it does not know yet.
  const tabRecency = [...new Set([...(layout?.tabRecency ?? []).filter((path) => tabs.includes(path)), ...tabs])];
  const focusedPane: EditorPaneId = "primary";
  return {
    primaryFile,
    secondaryFile,
    tabs,
    tabRecency,
    activeTab,
    /** A Paper or asset tab must be opened through its own reader once the project is in. */
    activeKind,
    mode,
    focusedPane,
    documentMode: layout?.documentMode ?? "split",
    paperView: layout?.paperView ?? "blog",
  };
}
